import type { FormEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

const SUPABASE_URL = "https://frnjbjhigceptzwtmyax.supabase.co";
const SUPABASE_KEY = "sb_publishable_mB2ZU7RWDpQdPA-mIh8tKw_oxs1_2_B";

const PLAYERS_URL = `${SUPABASE_URL}/rest/v1/group_players`;
const GAMES_URL = `${SUPABASE_URL}/rest/v1/group_games`;

const COUNTER_URL =
  "https://countapi.mileshilliard.com/api/v1/hit/word_bomb_solo_games_7f3c9";

const COUNTER_GET_URL =
  "https://countapi.mileshilliard.com/api/v1/get/word_bomb_solo_games_7f3c9";

const PLAYER_ID_KEY = "wordtimer_group_player_id";
const NAME_KEY = "wordtimer_group_name";

export const TARGET_WORDS = 20;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;
const MAX_NAME_LENGTH = 15;
const POLL_MS = 1000;
const COUNTDOWN_SECONDS = 3;

export type GroupDifficulty = "superEasy" | "hard";

export type PromptItem = {
  fragment: string;
  examples: string[];
};

type Player = {
  player_id: string;
  room_code: string;
  display_name: string;
  joined_at: string;
  progress: number;
  finished_at: string | null;
};

type Game = {
  room_code: string;
  status: "waiting" | "playing";
  host_id: string;
  prompts: PromptItem[] | null;
  game_number: number;
  finish_mode: "first" | "last";
  started_at: string | null;
};

type Props = {
  onExit: () => void;
  makePrompts: (count: number, difficulty: GroupDifficulty) => PromptItem[];
  isValidWord: (word: string) => boolean;
};

class ApiError extends Error {
  status: number;

  constructor(status: number, body: string) {
    super(`request failed (${status}): ${body}`);
    this.status = status;
  }
}

const AUTH_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
};

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

const MINIMAL = {
  Prefer: "return=minimal",
};

async function loadGamesPlayed(
  setGamesPlayed: React.Dispatch<React.SetStateAction<number>>,
) {
  try {
    const response = await fetch(COUNTER_GET_URL);

    if (!response.ok) return;

    const data = await response.json();

    setGamesPlayed(Number(data.value) || 0);
  } catch {}
}

async function countGamePlayed(
  setGamesPlayed: React.Dispatch<React.SetStateAction<number>>,
) {
  try {
    const response = await fetch(COUNTER_URL);

    if (!response.ok) return;

    const data = await response.json();

    setGamesPlayed(Number(data.value) || 0);
  } catch {}
}

function getPlayerId() {
  let id = localStorage.getItem(PLAYER_ID_KEY);

  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(PLAYER_ID_KEY, id);
  }

  return id;
}

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  return Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map((v) => chars[v % chars.length])
    .join("");
}

async function fetchGame(room: string) {
  const rows = await request<Game[]>(
    `${GAMES_URL}?room_code=eq.${enc(
      room,
    )}&select=room_code,status,host_id,prompts,game_number,finish_mode,started_at&limit=1`,
  );

  return rows[0] ?? null;
}

function fetchPlayers(room: string) {
  return request<Player[]>(
    `${PLAYERS_URL}?room_code=eq.${enc(
      room,
    )}&select=player_id,room_code,display_name,joined_at,progress,finished_at&order=joined_at.asc`,
  );
}

function removeMe() {
  return request<null>(`${PLAYERS_URL}?player_id=eq.${enc(getPlayerId())}`, {
    method: "DELETE",
  });
}

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

function saveProgress(progress: number) {
  return request<null>(`${PLAYERS_URL}?player_id=eq.${enc(getPlayerId())}`, {
    method: "PATCH",
    headers: MINIMAL,
    body: JSON.stringify({
      progress,
    }),
  });
}

function saveFinished() {
  return request<null>(`${PLAYERS_URL}?player_id=eq.${enc(getPlayerId())}`, {
    method: "PATCH",
    headers: MINIMAL,
    body: JSON.stringify({
      progress: TARGET_WORDS,
      finished_at: new Date().toISOString(),
    }),
  });
}

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

export default function GroupGame({ onExit, makePrompts, isValidWord }: Props) {
  const me = useMemo(getPlayerId, []);

  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) ?? "");

  const [codeInput, setCodeInput] = useState("");
  const [room, setRoom] = useState<string | null>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [error, setError] = useState("");
  const [syncError, setSyncError] = useState("");
  const [busy, setBusy] = useState(false);

  const [difficulty, setDifficulty] = useState<GroupDifficulty>("superEasy");

  const [finishMode, setFinishMode] = useState<"first" | "last">("first");

  const [index, setIndex] = useState(0);
  const [input, setInput] = useState("");
  const [message, setMessage] = useState("");
  const [used, setUsed] = useState<Set<string>>(new Set());
  const [countdown, setCountdown] = useState(0);

  const [gamesPlayed, setGamesPlayed] = useState(0);

  const seenGameNumber = useRef(0);

  const isHost = !!game && game.host_id === me;

  useEffect(() => {
    loadGamesPlayed(setGamesPlayed);

    const id = window.setInterval(() => {
      loadGamesPlayed(setGamesPlayed);
    }, 5000);

    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!room) return;

    let cancelled = false;

    const tick = async () => {
      try {
        const [g, p] = await Promise.all([fetchGame(room), fetchPlayers(room)]);

        if (cancelled) return;

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

    tick();

    const id = window.setInterval(tick, POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [room]);

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

  useEffect(() => {
    if (!game || game.status !== "playing") return;

    if (seenGameNumber.current === game.game_number) {
      return;
    }

    seenGameNumber.current = game.game_number;

    setIndex(0);
    setInput("");
    setMessage("");
    setUsed(new Set());
    setCountdown(COUNTDOWN_SECONDS);
  }, [game]);

  useEffect(() => {
    if (countdown <= 0) return;

    const id = window.setTimeout(() => setCountdown((c) => c - 1), 1000);

    return () => window.clearTimeout(id);
  }, [countdown]);

  const ranked = useMemo(
    () =>
      [...players].sort((a, b) => {
        if (a.finished_at && b.finished_at) {
          return a.finished_at.localeCompare(b.finished_at);
        }

        if (a.finished_at) return -1;
        if (b.finished_at) return 1;

        return b.progress - a.progress;
      }),
    [players],
  );

  const finishedPlayers = players.filter((p) => p.finished_at);

  const winner = finishedPlayers.length > 0 ? ranked[0] : null;

  const everyoneFinished =
    players.length > 0 && finishedPlayers.length === players.length;

  const raceIsOver =
    !!winner && (game?.finish_mode === "first" || everyoneFinished);

  const phase: "menu" | "lobby" | "countdown" | "race" | "results" = !room
    ? "menu"
    : !game || game.status === "waiting"
      ? "lobby"
      : raceIsOver
        ? "results"
        : countdown > 0
          ? "countdown"
          : "race";

  const validName = () => {
    const n = name.trim().slice(0, MAX_NAME_LENGTH);

    if (!/^[A-Za-z]{1,15}$/.test(n)) {
      setError("display name must be 1–15 letters only.");
      return null;
    }

    return n;
  };

  const enterRoom = (code: string, displayName: string) => {
    localStorage.setItem(NAME_KEY, displayName);

    seenGameNumber.current = 0;

    setGame(null);
    setPlayers([]);
    setCountdown(0);
    setError("");
    setRoom(code);
  };

  const handleCreate = async () => {
    const n = validName();

    if (!n) return;

    setBusy(true);
    setError("");

    try {
      await removeMe();

      let code = "";

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

  const handleLeave = async () => {
    const currentRoom = room;
    const hostId = game?.host_id;

    setRoom(null);
    setGame(null);
    setPlayers([]);
    setError("");

    if (!currentRoom) return;

    try {
      await leaveRoom(currentRoom, hostId);
    } catch (e) {
      console.error("GROUP LEAVE ERROR:", e);
    }
  };

  const handleExit = async () => {
    await handleLeave();
    onExit();
  };

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

      const startedAt = new Date().toISOString();

      await resetPlayers(room);

      for (let i = 0; i < players.length; i++) {
        await countGamePlayed(setGamesPlayed);
      }

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

  const handleBackToLobby = async () => {
    if (!room || !isHost) return;

    setBusy(true);

    try {
      await patchGame(room, {
        status: "waiting",
      });

      await resetPlayers(room);
    } catch (e) {
      console.error("GROUP LOBBY ERROR:", e);

      setError("couldn't go back to the lobby.");
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();

    const prompt = game?.prompts?.[index];

    if (!prompt || index >= TARGET_WORDS) {
      return;
    }

    const word = input.trim().toLowerCase();

    const fragment = prompt.fragment;

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

    const next = index + 1;

    setUsed((current) => {
      const updated = new Set(current);

      updated.add(word);

      return updated;
    });

    setIndex(next);
    setInput("");
    setMessage(next >= TARGET_WORDS ? "" : "good word!");

    if (next >= TARGET_WORDS) {
      saveFinished().catch((e) => console.error("FINISH SAVE ERROR:", e));
    } else {
      saveProgress(next).catch((e) => console.error("PROGRESS SAVE ERROR:", e));
    }
  };

  const progressOf = (p: Player) =>
    phase === "race" && p.player_id === me ? index : p.progress;

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

      {phase === "race" && (
        <div className="mp-race">
          {index >= TARGET_WORDS ? (
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
