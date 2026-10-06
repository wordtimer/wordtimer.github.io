import type { FormEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

/* ==========================================================================
 * CONFIG / CONSTANTS
 * ========================================================================== */

// Your Supabase project + public (publishable) key. Safe to ship in frontend
// code ONLY because Row Level Security / function grants protect the data.
const SUPABASE_URL = "https://frnjbjhigceptzwtmyax.supabase.co";
const SUPABASE_KEY = "sb_publishable_mB2ZU7RWDpQdPA-mIh8tKw_oxs1_2_B";

// REST endpoints for the two tables: one row per player, one row per room.
const PLAYERS_URL = `${SUPABASE_URL}/rest/v1/group_players`;
const GAMES_URL = `${SUPABASE_URL}/rest/v1/group_games`;

// External counter for "total games played by all users".
const COUNTER_URL =
  "https://countapi.mileshilliard.com/api/v1/hit/word_bomb_solo_games_7f3c9"; // +1
const COUNTER_GET_URL =
  "https://countapi.mileshilliard.com/api/v1/get/word_bomb_solo_games_7f3c9"; // read only

// localStorage keys so a player keeps the same identity/name across reloads.
const PLAYER_ID_KEY = "wordtimer_group_player_id";
const NAME_KEY = "wordtimer_group_name";

export const TARGET_WORDS = 20; // words needed to finish the race
const MIN_PLAYERS = 2; // host can't start with fewer
const MAX_PLAYERS = 8; // room cap
const MAX_NAME_LENGTH = 15;
const POLL_MS = 1000; // how often we re-read the room from Supabase
const COUNTDOWN_SECONDS = 3; // "get ready" time before the race starts

/* ==========================================================================
 * TYPES
 * ========================================================================== */

export type GroupDifficulty = "superEasy" | "hard";

// One prompt: the letters players must include, plus example words.
export type PromptItem = {
  fragment: string;
  examples: string[];
};

// A row in group_players.
type Player = {
  player_id: string;
  room_code: string;
  display_name: string;
  joined_at: string;
  progress: number; // words completed (0..TARGET_WORDS)
  finished_at: string | null; // set by the SQL function when they finish
};

// A row in group_games.
type Game = {
  room_code: string;
  status: "waiting" | "playing";
  host_id: string;
  prompts: PromptItem[] | null; // same list for every player
  game_number: number; // increments each round
  finish_mode: "first" | "last";
  started_at: string | null; // official race start (after countdown)
};

// Props passed in by the parent app.
type Props = {
  onExit: () => void;
  makePrompts: (count: number, difficulty: GroupDifficulty) => PromptItem[];
  isValidWord: (word: string) => boolean;
};

/* ==========================================================================
 * API HELPERS
 * ========================================================================== */

// Error that remembers the HTTP status (used to detect 409 = duplicate).
class ApiError extends Error {
  status: number;

  constructor(status: number, body: string) {
    super(`request failed (${status}): ${body}`);
    this.status = status;
  }
}

// Headers Supabase needs on every request.
const AUTH_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
};

// Generic fetch wrapper: adds headers, throws ApiError on failure, and
// safely returns null for empty responses (DELETE / PATCH with minimal return).
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...AUTH_HEADERS,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new ApiError(response.status, await response.text());
  }

  const text = await response.text();

  return (text ? JSON.parse(text) : null) as T;
}

const enc = encodeURIComponent;

// Tells Supabase not to send the row back (faster, smaller).
const MINIMAL = {
  Prefer: "return=minimal",
};

// Read the global games counter (no increment).
async function loadGamesPlayed(
  setGamesPlayed: React.Dispatch<React.SetStateAction<number>>,
) {
  try {
    const response = await fetch(COUNTER_GET_URL);

    if (!response.ok) return;

    const data = await response.json();

    setGamesPlayed(Number(data.value) || 0);
  } catch {
    // counter is cosmetic, ignore failures
  }
}

// Increment the global games counter by 1.
async function countGamePlayed(
  setGamesPlayed: React.Dispatch<React.SetStateAction<number>>,
) {
  try {
    const response = await fetch(COUNTER_URL);

    if (!response.ok) return;

    const data = await response.json();

    setGamesPlayed(Number(data.value) || 0);
  } catch {
    // counter is cosmetic, ignore failures
  }
}

// Stable anonymous identity for this browser (no login needed).
function getPlayerId() {
  let id = localStorage.getItem(PLAYER_ID_KEY);

  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(PLAYER_ID_KEY, id);
  }

  return id;
}

// 6-character room code. Skips look-alike characters (0/O, 1/I).
function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  return Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map((v) => chars[v % chars.length])
    .join("");
}

// Load the room row (or null if it doesn't exist).
async function fetchGame(room: string) {
  const rows = await request<Game[]>(
    `${GAMES_URL}?room_code=eq.${enc(
      room,
    )}&select=room_code,status,host_id,prompts,game_number,finish_mode,started_at&limit=1`,
  );

  return rows[0] ?? null;
}

// Load every player in the room, oldest joiner first.
function fetchPlayers(room: string) {
  return request<Player[]>(
    `${PLAYERS_URL}?room_code=eq.${enc(
      room,
    )}&select=player_id,room_code,display_name,joined_at,progress,finished_at&order=joined_at.asc`,
  );
}

// Delete my player row (leaving / switching rooms).
function removeMe() {
  return request<null>(`${PLAYERS_URL}?player_id=eq.${enc(getPlayerId())}`, {
    method: "DELETE",
  });
}

// Zero out everyone's progress + finish time (new round / back to lobby).
function resetPlayers(room: string) {
  return request<null>(`${PLAYERS_URL}?room_code=eq.${enc(room)}`, {
    method: "PATCH",
    headers: MINIMAL,
    body: JSON.stringify({
      progress: 0,
      finished_at: null,
    }),
  });
}

// Update the room row (status, host, prompts, etc.).
function patchGame(room: string, body: Record<string, unknown>) {
  return request<null>(`${GAMES_URL}?room_code=eq.${enc(room)}`, {
    method: "PATCH",
    headers: MINIMAL,
    body: JSON.stringify({
      ...body,
      updated_at: new Date().toISOString(),
    }),
  });
}

// Save my current word count so other players' scoreboards update.
function saveProgress(progress: number) {
  return request<null>(`${PLAYERS_URL}?player_id=eq.${enc(getPlayerId())}`, {
    method: "PATCH",
    headers: MINIMAL,
    body: JSON.stringify({
      progress,
    }),
  });
}

// Tell the database I finished. The SQL function finish_group_player sets
// finished_at = now() on the SERVER, so nobody can fake their time.
// (SQL for this function is in the Supabase SQL editor - see instructions.)
function saveFinished() {
  return request<null>(`${SUPABASE_URL}/rest/v1/rpc/finish_group_player`, {
    method: "POST",
    body: JSON.stringify({
      p_player_id: getPlayerId(),
      p_target_words: TARGET_WORDS,
    }),
  });
}

// Leave a room. If I was host, hand host to the next player, or delete the
// room if I was the last one.
async function leaveRoom(room: string, hostId: string | undefined) {
  const me = getPlayerId();

  await removeMe();

  if (hostId !== me) return;

  const rest = await fetchPlayers(room);

  if (rest.length > 0) {
    await patchGame(room, {
      host_id: rest[0].player_id,
    });
  } else {
    await request<null>(`${GAMES_URL}?room_code=eq.${enc(room)}`, {
      method: "DELETE",
    });
  }
}

/* ==========================================================================
 * COMPONENT
 * ========================================================================== */

export default function GroupGame({ onExit, makePrompts, isValidWord }: Props) {
  // My permanent id for this browser.
  const me = useMemo(getPlayerId, []);

  // ---- menu state ----
  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) ?? "");
  const [codeInput, setCodeInput] = useState("");

  // ---- room state (synced from Supabase by polling) ----
  const [room, setRoom] = useState<string | null>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);

  // ---- UI feedback ----
  const [error, setError] = useState(""); // action errors (create/join/start)
  const [syncError, setSyncError] = useState(""); // polling errors
  const [busy, setBusy] = useState(false); // disables buttons mid-request

  // ---- host settings (only used by the host when starting) ----
  const [difficulty, setDifficulty] = useState<GroupDifficulty>("superEasy");
  const [finishMode, setFinishMode] = useState<"first" | "last">("first");

  // ---- my local race state ----
  const [index, setIndex] = useState(0); // which word I'm on (0-based)
  const [input, setInput] = useState("");
  const [message, setMessage] = useState("");
  const [used, setUsed] = useState<Set<string>>(new Set()); // no repeat words
  const [countdown, setCountdown] = useState(0); // seconds until start
  const [raceTime, setRaceTime] = useState(0); // seconds since start

  const [gamesPlayed, setGamesPlayed] = useState(0);

  // Last game_number I've reset my local state for (see effect below).
  const seenGameNumber = useRef(0);

  // Queue of pending saves so they run in order (see queueSave).
  const saveChain = useRef<Promise<unknown>>(Promise.resolve());

  const isHost = !!game && game.host_id === me;

  /* ------------------------------------------------------------------------
   * SAVE QUEUE
   * Runs database saves one after another. Without this, fast typing could
   * send "progress 19" and "progress 20" at the same time and have the older
   * one arrive last, overwriting the newer.
   * ---------------------------------------------------------------------- */
  const queueSave = (fn: () => Promise<unknown>) => {
    saveChain.current = saveChain.current
      .catch(() => {}) // a previous failure must not block the queue
      .then(fn)
      .catch((e) => console.error("SAVE ERROR:", e));
  };

  /* ------------------------------------------------------------------------
   * EFFECT: refresh the "total games played" number every 5 seconds.
   * ---------------------------------------------------------------------- */
  useEffect(() => {
    loadGamesPlayed(setGamesPlayed);

    const id = window.setInterval(() => {
      loadGamesPlayed(setGamesPlayed);
    }, 5000);

    return () => window.clearInterval(id);
  }, []);

  /* ------------------------------------------------------------------------
   * EFFECT: poll the room + players once per second while in a room.
   * This is how every computer learns about everyone else's progress.
   * ---------------------------------------------------------------------- */
  useEffect(() => {
    if (!room) return;

    let cancelled = false; // stops stale responses after leaving

    const tick = async () => {
      try {
        const [g, p] = await Promise.all([fetchGame(room), fetchPlayers(room)]);

        if (cancelled) return;

        // Room row vanished (host left and deleted it).
        if (!g) {
          setRoom(null);
          setGame(null);
          setPlayers([]);
          setError("that game was closed.");
          return;
        }

        setGame(g);
        setPlayers(p);
        setSyncError("");
      } catch (e) {
        console.error("GROUP POLL ERROR:", e);

        if (!cancelled) {
          setSyncError("connection problem, retrying...");
        }
      }
    };

    tick(); // immediately, then every POLL_MS

    const id = window.setInterval(tick, POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [room]);

  /* ------------------------------------------------------------------------
   * EFFECT: if the tab is closed, remove my player row so I don't linger
   * as a ghost player. keepalive lets the request finish while unloading.
   * ---------------------------------------------------------------------- */
  useEffect(() => {
    if (!room) return;

    const onHide = () => {
      fetch(`${PLAYERS_URL}?player_id=eq.${enc(me)}`, {
        method: "DELETE",
        keepalive: true,
        headers: AUTH_HEADERS,
      }).catch(() => {});
    };

    window.addEventListener("pagehide", onHide);

    return () => window.removeEventListener("pagehide", onHide);
  }, [room, me]);

  /* ------------------------------------------------------------------------
   * EFFECT: reset MY local race state whenever a new round begins.
   * Without this, "index" stays at 20 after the first game and the second
   * game would instantly show "you finished".
   * ---------------------------------------------------------------------- */
  useEffect(() => {
    if (!game) return;

    if (game.game_number !== seenGameNumber.current) {
      seenGameNumber.current = game.game_number;

      setIndex(0);
      setInput("");
      setMessage("");
      setUsed(new Set());
    }
  }, [game?.game_number]);

  /* ------------------------------------------------------------------------
   * EFFECT: countdown. started_at is in the FUTURE (now + 3s), so the
   * remaining time until it is the "get ready" number.
   * ---------------------------------------------------------------------- */
  useEffect(() => {
    if (!game || game.status !== "playing" || !game.started_at) {
      setCountdown(0);
      return;
    }

    // Copy to a const: TypeScript loses the "not null" check inside the
    // nested function below, so we capture the narrowed string here.
    const startedAt = game.started_at;

    const updateCountdown = () => {
      const start = new Date(startedAt).getTime();

      if (!Number.isFinite(start)) {
        setCountdown(0);
        return;
      }

      const remaining = Math.max(0, start - Date.now());

      setCountdown(Math.ceil(remaining / 1000));
    };

    updateCountdown();

    const id = window.setInterval(updateCountdown, 100);

    return () => window.clearInterval(id);
  }, [game?.status, game?.started_at]);

  /* ------------------------------------------------------------------------
   * EFFECT: live race clock (seconds since started_at), updated every 50ms.
   * ---------------------------------------------------------------------- */
  useEffect(() => {
    if (!game || game.status !== "playing" || !game.started_at) {
      setRaceTime(0);
      return;
    }

    const startedAt = game.started_at;

    const updateTime = () => {
      const start = new Date(startedAt).getTime();

      if (!Number.isFinite(start)) {
        setRaceTime(0);
        return;
      }

      const elapsed = Math.max(0, Date.now() - start);

      setRaceTime(elapsed / 1000);
    };

    updateTime();

    const id = window.setInterval(updateTime, 50);

    return () => window.clearInterval(id);
  }, [game?.status, game?.started_at]);

  /* ------------------------------------------------------------------------
   * DERIVED DATA
   * ---------------------------------------------------------------------- */

  // Scoreboard order: finishers by finish time, then everyone else by progress.
  const ranked = useMemo(
    () =>
      [...players].sort((a, b) => {
        if (a.finished_at && b.finished_at) {
          return (
            new Date(a.finished_at).getTime() -
            new Date(b.finished_at).getTime()
          );
        }

        if (a.finished_at) return -1;
        if (b.finished_at) return 1;

        return b.progress - a.progress;
      }),
    [players],
  );

  // Only players who have finished, fastest first.
  const finishedPlayers = useMemo(
    () =>
      players
        .filter(
          (p): p is Player & { finished_at: string } => p.finished_at !== null,
        )
        .sort((a, b) => {
          return (
            new Date(a.finished_at).getTime() -
            new Date(b.finished_at).getTime()
          );
        }),
    [players],
  );

  const winner = finishedPlayers[0] ?? null;

  const everyoneFinished =
    players.length > 0 && finishedPlayers.length === players.length;

  // "first" mode ends when anyone finishes; "last" waits for everyone.
  const raceIsOver =
    !!winner && (game?.finish_mode === "first" || everyoneFinished);

  // Which screen to show. Order matters: results beats countdown beats race.
  const phase: "menu" | "lobby" | "countdown" | "race" | "results" = !room
    ? "menu"
    : !game || game.status === "waiting"
      ? "lobby"
      : raceIsOver
        ? "results"
        : countdown > 0
          ? "countdown"
          : "race";

  /* ------------------------------------------------------------------------
   * ACTIONS
   * ---------------------------------------------------------------------- */

  // Validate + clean the display name. Returns null (and shows error) if bad.
  const validName = () => {
    const n = name.trim().slice(0, MAX_NAME_LENGTH);

    if (!/^[A-Za-z]{1,15}$/.test(n)) {
      setError("display name must be 1–15 letters only.");
      return null;
    }

    return n;
  };

  // Switch the UI into a room (after create or join succeeded).
  const enterRoom = (code: string, displayName: string) => {
    localStorage.setItem(NAME_KEY, displayName);

    seenGameNumber.current = 0;

    setGame(null);
    setPlayers([]);
    setCountdown(0);
    setRaceTime(0);
    setError("");
    setRoom(code);
  };

  // CREATE GAME: make a room row, then add myself as the first player.
  const handleCreate = async () => {
    const n = validName();

    if (!n) return;

    setBusy(true);
    setError("");

    try {
      await removeMe(); // leave any old room first

      let code = "";

      // Retry up to 5 times if the random code is already taken (409).
      for (let attempt = 0; ; attempt++) {
        code = makeRoomCode();

        try {
          await request<null>(GAMES_URL, {
            method: "POST",
            headers: MINIMAL,
            body: JSON.stringify({
              room_code: code,
              host_id: me,
            }),
          });

          break;
        } catch (e) {
          if (e instanceof ApiError && e.status === 409 && attempt < 4) {
            continue;
          }

          throw e;
        }
      }

      await request<null>(PLAYERS_URL, {
        method: "POST",
        headers: MINIMAL,
        body: JSON.stringify({
          player_id: me,
          room_code: code,
          display_name: n,
        }),
      });

      enterRoom(code, n);
    } catch (e) {
      console.error("GROUP CREATE ERROR:", e);

      setError("couldn't create the game. try again.");
    } finally {
      setBusy(false);
    }
  };

  // JOIN GAME: check the room exists / is waiting / isn't full, then add me.
  const handleJoin = async () => {
    const n = validName();

    if (!n) return;

    const code = codeInput.trim().toUpperCase();

    if (!/^[A-Z0-9]{6}$/.test(code)) {
      setError("game codes are 6 letters or numbers.");
      return;
    }

    setBusy(true);
    setError("");

    try {
      const g = await fetchGame(code);

      if (!g) {
        setError("no game found with that code.");
        return;
      }

      if (g.status !== "waiting") {
        setError("that game has already started.");
        return;
      }

      const existing = await fetchPlayers(code);

      if (
        existing.length >= MAX_PLAYERS &&
        !existing.some((p) => p.player_id === me)
      ) {
        setError("that game is full.");
        return;
      }

      await removeMe();

      try {
        await request<null>(PLAYERS_URL, {
          method: "POST",
          headers: MINIMAL,
          body: JSON.stringify({
            player_id: me,
            room_code: code,
            display_name: n,
          }),
        });
      } catch (e) {
        // 409 = unique constraint on (room_code, display_name)
        if (e instanceof ApiError && e.status === 409) {
          setError("that name is already taken in this game.");
          return;
        }

        throw e;
      }

      enterRoom(code, n);
    } catch (e) {
      console.error("GROUP JOIN ERROR:", e);

      setError("couldn't join the game. try again.");
    } finally {
      setBusy(false);
    }
  };

  // LEAVE: clear local state right away, then clean up the database.
  const handleLeave = async () => {
    const currentRoom = room;
    const hostId = game?.host_id;

    setRoom(null);
    setGame(null);
    setPlayers([]);
    setRaceTime(0);
    setError("");

    if (!currentRoom) return;

    try {
      await leaveRoom(currentRoom, hostId);
    } catch (e) {
      console.error("GROUP LEAVE ERROR:", e);
    }
  };

  // Leave the room AND return to the solo screen.
  const handleExit = async () => {
    await handleLeave();
    onExit();
  };

  // START GAME (host only): pick prompts + start time, flip status to playing.
  const handleStart = async () => {
    if (!room || !game || !isHost) return;

    if (players.length < MIN_PLAYERS) {
      setError(`you need at least ${MIN_PLAYERS} players to start.`);
      return;
    }

    setBusy(true);
    setError("");

    try {
      const prompts = makePrompts(TARGET_WORDS, difficulty);

      // Official race start = now + countdown. Everyone gets this SAME
      // timestamp from the database, so all clocks line up.
      const startedAt = new Date(
        Date.now() + COUNTDOWN_SECONDS * 1000,
      ).toISOString();

      // Clear last round's progress/finish times BEFORE the game flips on.
      await resetPlayers(room);

      // Count one game per player in the global counter.
      for (let i = 0; i < players.length; i++) {
        await countGamePlayed(setGamesPlayed);
      }

      // This write is what makes every other computer start.
      await patchGame(room, {
        status: "playing",
        prompts,
        game_number: game.game_number + 1,
        finish_mode: finishMode,
        started_at: startedAt,
      });

      await loadGamesPlayed(setGamesPlayed);
    } catch (e) {
      console.error("GROUP START ERROR:", e);

      setError("couldn't start the game. try again.");
    } finally {
      setBusy(false);
    }
  };

  // PLAY AGAIN (host only): back to the lobby with everyone's progress reset.
  const handleBackToLobby = async () => {
    if (!room || !isHost) return;

    setBusy(true);

    try {
      await patchGame(room, {
        status: "waiting",
      });

      await resetPlayers(room);
      setRaceTime(0);
    } catch (e) {
      console.error("GROUP LOBBY ERROR:", e);

      setError("couldn't go back to the lobby.");
    } finally {
      setBusy(false);
    }
  };

  // SUBMIT A WORD: validate, advance locally, then sync to the database.
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();

    // Ignore submissions before the official start time.
    if (!game?.started_at || Date.now() < new Date(game.started_at).getTime()) {
      return;
    }

    const prompt = game.prompts?.[index];

    if (!prompt || index >= TARGET_WORDS) {
      return;
    }

    const word = input.trim().toLowerCase();

    const fragment = prompt.fragment;

    // --- validation rules (each shows a message and stops) ---
    if (word.length <= fragment.length) {
      setMessage(`your word must be at least ${fragment.length + 1} letters.`);
      return;
    }

    if (!/^[a-z]+$/.test(word)) {
      setMessage("use letters only.");
      return;
    }

    if (!word.includes(fragment)) {
      setMessage(`your word needs "${fragment.toUpperCase()}".`);
      return;
    }

    if (!isValidWord(word)) {
      setMessage("that word isn't in the dictionary.");
      return;
    }

    if (used.has(word)) {
      setMessage("you already used that word.");
      return;
    }

    // --- word accepted ---
    const next = index + 1;

    setUsed((current) => {
      const updated = new Set(current);

      updated.add(word);

      return updated;
    });

    setIndex(next);
    setInput("");
    setMessage(next >= TARGET_WORDS ? "" : "good word!");

    // --- sync to database (queued so order is guaranteed) ---
    if (next >= TARGET_WORDS) {
      // 1) write progress = 20 so other screens show 20/20
      // 2) call the SQL function, which stamps finished_at = now() on the server
      queueSave(() => saveProgress(TARGET_WORDS));
      queueSave(saveFinished);
    } else {
      queueSave(() => saveProgress(next));
    }
  };

  /* ------------------------------------------------------------------------
   * RENDER HELPERS
   * ---------------------------------------------------------------------- */

  // For my own row during the race, use my local index (instant) instead of
  // the polled value (up to 1s old). Everyone else uses the polled value.
  const progressOf = (p: Player) =>
    phase === "race" && p.player_id === me ? index : p.progress;

  // Finish time = server finished_at minus the shared started_at.
  const getElapsedSeconds = (p: Player) => {
    if (!game?.started_at || !p.finished_at) {
      return null;
    }

    const start = new Date(game.started_at).getTime();
    const finish = new Date(p.finished_at).getTime();

    if (!Number.isFinite(start) || !Number.isFinite(finish)) {
      return null;
    }

    return Math.max(0, (finish - start) / 1000);
  };

  const formatTime = (seconds: number | null) => {
    if (seconds === null) return "—";

    return `${seconds.toFixed(2)}s`;
  };

  // Progress bars for every player (used in race + results screens).
  const renderScoreboard = () => (
    <div className="mp-board">
      {(phase === "results" ? ranked : players).map((p) => {
        const count = Math.min(TARGET_WORDS, progressOf(p));

        const elapsed = getElapsedSeconds(p);

        const isWinner =
          phase === "results" && winner?.player_id === p.player_id;

        return (
          <div
            key={p.player_id}
            className={p.player_id === me ? "mp-row mp-me" : "mp-row"}
          >
            <span className="mp-name">
              {isWinner && (
                <span
                  style={{
                    marginRight: "6px",
                    fontSize: "15px",
                  }}
                  aria-label="winner"
                >
                  👑
                </span>
              )}

              {p.display_name}
            </span>

            <div className="mp-bar">
              <i
                style={{
                  width: `${(count / TARGET_WORDS) * 100}%`,
                }}
              />
            </div>

            {/* Finished players show their time; others show "n/20" */}
            <span className="mp-count">
              {elapsed !== null
                ? formatTime(elapsed)
                : `${count}/${TARGET_WORDS}`}
            </span>
          </div>
        );
      })}
    </div>
  );

  /* ------------------------------------------------------------------------
   * RENDER
   * ---------------------------------------------------------------------- */
  return (
    <section className="card mp-screen">
      <div className="mp-stats">
        total games played by all users{" "}
        <strong>{gamesPlayed.toLocaleString()}</strong>
      </div>

      <div className="mp-top">
        <button type="button" className="lb-skip" onClick={handleExit}>
          ← back to solo
        </button>

        {room && phase !== "menu" && (
          <button type="button" className="lb-skip" onClick={handleLeave}>
            leave game
          </button>
        )}
      </div>

      {/* ============ MENU: enter name, create or join ============ */}
      {phase === "menu" && (
        <div className="mp-menu">
          <div className="results-header">
            <small>multiplayer</small>

            <h2>rush{TARGET_WORDS}</h2>

            <p>
              everyone gets the same letters. first to {TARGET_WORDS} words
              wins.
            </p>
          </div>

          <div className="divider" />

          <div className="setting">
            <small>display name</small>

            <input
              className="group-input"
              value={name}
              maxLength={MAX_NAME_LENGTH}
              onChange={(e) =>
                setName(e.target.value.replace(/[^a-zA-Z]/g, ""))
              }
              placeholder="your name"
              autoComplete="off"
            />
          </div>

          <button
            type="button"
            className="play-again"
            onClick={handleCreate}
            disabled={busy}
          >
            create game
          </button>

          <div className="divider" />

          <div className="setting">
            <small>game code</small>

            <input
              className="group-input"
              value={codeInput}
              maxLength={6}
              onChange={(e) =>
                setCodeInput(
                  e.target.value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase(),
                )
              }
              placeholder="ABC123"
              autoComplete="off"
            />
          </div>

          <button
            type="button"
            className="play-again"
            onClick={handleJoin}
            disabled={busy || codeInput.length !== 6}
          >
            join game
          </button>

          {error && <div className="message">{error}</div>}
        </div>
      )}

      {/* ============ LOBBY: wait for players, host picks settings ============ */}
      {phase === "lobby" && room && (
        <div className="mp-lobby">
          <div className="results-header">
            <small>game code</small>

            <h2 className="mp-code">{room}</h2>

            <button
              type="button"
              className="lb-skip"
              onClick={() => navigator.clipboard?.writeText(room)}
            >
              copy code
            </button>
          </div>

          <div className="divider" />

          <div className="group-players">
            <small>
              players ({players.length}/{MAX_PLAYERS})
            </small>

            {players.map((p) => (
              <div className="group-player" key={p.player_id}>
                <span>
                  {p.display_name}
                  {p.player_id === me ? " (you)" : ""}
                </span>

                {game?.host_id === p.player_id && (
                  <strong className="mp-tag">host</strong>
                )}
              </div>
            ))}
          </div>

          <div className="divider" />

          {/* Only the host sees settings + start button */}
          {isHost ? (
            <>
              <div className="setting">
                <small>finish mode</small>

                <div
                  className="option-grid"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(2, 1fr)",
                  }}
                >
                  {(
                    [
                      {
                        value: "first",
                        label: "first to finish",
                        hint: "game ends when someone finishes",
                      },
                      {
                        value: "last",
                        label: "everyone finishes",
                        hint: "wait for everyone",
                      },
                    ] as const
                  ).map((option) => (
                    <button
                      type="button"
                      key={option.value}
                      className={
                        finishMode === option.value
                          ? "option selected"
                          : "option"
                      }
                      onClick={() => setFinishMode(option.value)}
                    >
                      <strong>{option.label}</strong>

                      <span>{option.hint}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="divider" />

              <div className="setting">
                <small>difficulty</small>

                <div
                  className="option-grid"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(2, 1fr)",
                  }}
                >
                  {(
                    [
                      {
                        value: "superEasy",
                        label: "easy",
                        hint: "5,000+ words",
                      },
                      {
                        value: "hard",
                        label: "hard",
                        hint: "300–900+ words",
                      },
                    ] as const
                  ).map((option) => (
                    <button
                      type="button"
                      key={option.value}
                      className={
                        difficulty === option.value
                          ? "option selected"
                          : "option"
                      }
                      onClick={() => setDifficulty(option.value)}
                    >
                      <strong>{option.label}</strong>

                      <span>{option.hint}</span>
                    </button>
                  ))}
                </div>
              </div>

              <button
                type="button"
                className="play-again"
                onClick={handleStart}
                disabled={busy || players.length < MIN_PLAYERS}
              >
                {players.length < MIN_PLAYERS
                  ? `waiting for players (${players.length}/${MIN_PLAYERS})`
                  : "start game"}
              </button>
            </>
          ) : (
            <p className="rule">waiting for the host to start the game...</p>
          )}

          {(error || syncError) && (
            <div className="message">{error || syncError}</div>
          )}
        </div>
      )}

      {/* ============ COUNTDOWN: "get ready" 3..2..1 ============ */}
      {phase === "countdown" && (
        <div className="mp-countdown-screen">
          <small>get ready</small>

          <div className="mp-countdown">{countdown}</div>

          <p className="rule">
            {game?.finish_mode === "last"
              ? `everyone must reach ${TARGET_WORDS} words`
              : `first to ${TARGET_WORDS} words wins`}
          </p>
        </div>
      )}

      {/* ============ RACE: type words, watch the scoreboard ============ */}
      {phase === "race" && (
        <div className="mp-race">
          {/* Live race clock */}
          <div
            style={{
              textAlign: "center",
              fontSize: "22px",
              fontWeight: 700,
              marginBottom: "18px",
            }}
          >
            {raceTime.toFixed(2)}s
          </div>

          {index >= TARGET_WORDS ? (
            // I'm done; waiting for the server to confirm / others to finish.
            <div className="results-header">
              <small>you finished!</small>

              <h2>
                {TARGET_WORDS}/{TARGET_WORDS}
              </h2>

              <p>
                {game?.finish_mode === "last"
                  ? "waiting for everyone else..."
                  : "confirming the winner..."}
              </p>
            </div>
          ) : (
            <>
              <div className="prompt">
                <small>
                  WORD {index + 1} OF {TARGET_WORDS}
                </small>

                <strong>
                  {game?.prompts?.[index]?.fragment.toUpperCase()}
                </strong>

                <p>put these letters in order anywhere in your word</p>
              </div>

              <form onSubmit={handleSubmit}>
                <div className="entry">
                  <input
                    id="mp-word"
                    value={input}
                    onChange={(e) =>
                      setInput(
                        e.target.value.replace(/[^a-zA-Z]/g, "").toLowerCase(),
                      )
                    }
                    inputMode="text"
                    autoFocus
                    autoComplete="off"
                    placeholder="type a word..."
                  />

                  <button type="submit">enter</button>
                </div>

                <div className="message">{message}</div>
              </form>
            </>
          )}

          <div className="divider" />

          {renderScoreboard()}

          {syncError && <div className="message">{syncError}</div>}
        </div>
      )}

      {/* ============ RESULTS: winner + final times ============ */}
      {phase === "results" && winner && (
        <div className="mp-results">
          <div className="results-header">
            <small>{winner.player_id === me ? "you won!" : "game over"}</small>

            <h2>👑 {winner.display_name} wins</h2>

            <p>
              {game?.finish_mode === "last"
                ? "everyone finished"
                : `first to ${TARGET_WORDS} words`}
            </p>
          </div>

          <div className="divider" />

          {renderScoreboard()}

          <div className="divider" />

          {isHost ? (
            <button
              type="button"
              className="play-again"
              onClick={handleBackToLobby}
              disabled={busy}
            >
              play again (back to lobby)
            </button>
          ) : (
            <p className="rule">
              waiting for the host to start another game...
            </p>
          )}

          {error && <div className="message">{error}</div>}
        </div>
      )}
    </section>
  );
}
