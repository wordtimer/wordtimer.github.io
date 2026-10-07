import type { Dispatch, FormEvent, SetStateAction } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

/* ==========================================================================
 * CONFIG / CONSTANTS
 * ========================================================================== */

const SUPABASE_URL = "https://frnjbjhigceptzwtmyax.supabase.co";
const SUPABASE_KEY = "sb_publishable_mB2ZU7RWDpQdPA-mIh8tKw_oxs1_2_B";

const PLAYERS_URL = `${SUPABASE_URL}/rest/v1/group_players`;
const GAMES_URL = `${SUPABASE_URL}/rest/v1/group_games`;

const COUNTER_URL =
  "https://countapi.mileshilliard.com/api/v1/hit/word_bomb_solo_games_7f3c9"; // +1
const COUNTER_GET_URL =
  "https://countapi.mileshilliard.com/api/v1/get/word_bomb_solo_games_7f3c9"; // read only

const PLAYER_ID_KEY = "wordtimer_group_player_id";
const NAME_KEY = "wordtimer_group_name";

export const TARGET_WORDS = 20; // words needed to finish rush / sixrush
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const ALPHABET_TARGET = ALPHABET.length; // 26 letters to finish alphabet
const TIMED_LIVES_DEFAULT = 3;
const TIMED_LIFE_OPTIONS = [1, 2, 3, 4, 5];
const TURN_TIME_OPTIONS = [5, 10, 20, 60];
const SURVIVAL_TIME = 60;
const SURVIVAL_SKIP_SECONDS = 15;
const TIMED_SHORT_TIME_DEFAULT = 5;
const TIMED_SHORT_AFTER_WORDS_PER_PLAYER = 20;
const PROMPT_POOL_SIZE = 60; // fragments generated for alphabet / timed (they wrap)
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;
const MAX_NAME_LENGTH = 15;
const POLL_MS = 1000;
const TIMED_POLL_MS = 500; // poll faster during timed so the potato moves quickly
const COUNTDOWN_SECONDS = 3;
const TIMEOUT_GRACE_MS = 300; // host waits a hair past the deadline before failing a turn

/* ==========================================================================
 * TYPES
 * ========================================================================== */

export type GroupDifficulty = "superEasy" | "hard";

// rush / sixrush / alphabet are races. timed is hot potato. survival is shared-clock elimination.
export type GroupMode = "rush" | "sixrush" | "alphabet" | "timed" | "survival";

export type PromptItem = {
  fragment: string;
  examples: string[];
};

// Everything about the current hot-potato turn lives in ONE json value so it
// can be swapped atomically (compare-and-set on game.turn_number).
type TurnState = {
  current: string; // player_id whose turn it is
  origin: string; // player who first received this fragment
  prompt: PromptItem; // fragment being passed around
  promptIndex: number; // index into game.prompts (wraps)
  deadline: string;
  skipDeadline: string;
  turnStartedAt: string;
  limit: number;
  order: string[];
  lives: Record<string, number>;
  remaining: Record<string, number>;
  letters: Record<string, string[]>;
  eliminated: string[];
  used: string[];
  totalWords: number;
  lastWord: string;
  lastWordBy: string;
  note: string;
  endedAt: string | null;
  survival: boolean;
};

type Player = {
  player_id: string;
  room_code: string;
  display_name: string;
  joined_at: string;
  progress: number; // rush/sixrush: words. alphabet: letters collected.
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
  game_mode: GroupMode;
  turn_number: number; // bumps on every timed turn change
  turn_state: TurnState | null;
};

type Props = {
  onExit: () => void;
  makePrompts: (
    count: number,
    difficulty: GroupDifficulty,
    mode: GroupMode,
  ) => PromptItem[];
  isValidWord: (word: string) => boolean;
};

const MODE_OPTIONS: { value: GroupMode; label: string; hint: string }[] = [
  { value: "rush", label: "rush", hint: `${TARGET_WORDS} words, fastest time` },
  {
    value: "sixrush",
    label: "sixrush",
    hint: `${TARGET_WORDS} words, 6+ letters`,
  },
  { value: "alphabet", label: "alphabet", hint: "collect all 26 letters" },
  {
    value: "timed",
    label: "timed",
    hint: "hot potato, configurable lives",
  },
  {
    value: "survival",
    label: "survival",
    hint: "1 life, 60s each, 15s turns",
  },
];

/* ==========================================================================
 * GAME RULE HELPERS (pure)
 * ========================================================================== */

// How much "progress" a player needs to finish a race mode.
const targetOf = (mode: GroupMode) =>
  mode === "alphabet" ? ALPHABET_TARGET : TARGET_WORDS;

// How many fragments to generate. Alphabet, timed, and survival have no fixed length,
// so they get a pool that wraps around if it ever runs out.
const promptCountFor = (mode: GroupMode) =>
  mode === "alphabet" || mode === "timed" || mode === "survival"
    ? PROMPT_POOL_SIZE
    : TARGET_WORDS;

// Returns an error message, or null if the word is fine.
function checkWord(
  word: string,
  fragment: string,
  mode: GroupMode,
  isValidWord: (w: string) => boolean,
  used: { has: (w: string) => boolean },
): string | null {
  const minLength =
    mode === "sixrush" ? Math.max(fragment.length + 1, 6) : fragment.length + 1;

  if (word.length < minLength) {
    return `your word must be at least ${minLength} letters.`;
  }

  if (!/^[a-z]+$/.test(word)) return "use letters only.";

  if (!word.includes(fragment)) {
    return `your word needs "${fragment.toUpperCase()}".`;
  }

  if (!isValidWord(word)) return "that word isn't in the dictionary.";

  if (used.has(word)) return "you already used that word.";

  return null;
}

/* ---- hot potato transitions ---------------------------------------------- */

const deadlineFrom = (seconds: number) =>
  new Date(Date.now() + seconds * 1000).toISOString();

const addLetters = (word: string, current: string[]) => {
  const next = new Set(current);
  for (const char of word.toUpperCase()) {
    if (ALPHABET.includes(char)) next.add(char);
  }
  return [...next];
};

function aliveIds(ts: TurnState, present: Set<string>) {
  return new Set(
    ts.order.filter((id) => {
      if (!present.has(id)) return false;
      return ts.survival
        ? (ts.remaining[id] ?? 0) > 0
        : (ts.lives[id] ?? 0) > 0;
    }),
  );
}

function firstAliveFrom(order: string[], alive: Set<string>, startIdx: number) {
  for (let step = 0; step < order.length; step++) {
    const id = order[(startIdx + step) % order.length];
    if (alive.has(id)) return id;
  }
  return null;
}

function withNewFragment(
  ts: TurnState,
  prompts: PromptItem[],
  holder: string,
  note: string,
  mode: GroupMode,
  limit: number,
): TurnState {
  const promptIndex = ts.promptIndex + 1;
  const now = new Date().toISOString();
  const nextLimit =
    mode === "survival"
      ? Math.min(SURVIVAL_SKIP_SECONDS, ts.remaining[holder] ?? SURVIVAL_TIME)
      : limit;

  return {
    ...ts,
    current: holder,
    origin: holder,
    promptIndex,
    prompt: prompts[promptIndex % prompts.length] ?? ts.prompt,
    deadline: deadlineFrom(
      mode === "survival" ? (ts.remaining[holder] ?? SURVIVAL_TIME) : nextLimit,
    ),
    skipDeadline: deadlineFrom(nextLimit),
    turnStartedAt: now,
    note,
  };
}

function recordAcceptedWord(
  ts: TurnState,
  word: string,
  playerId: string,
  nameOf: (id: string) => string,
): TurnState {
  const letters = { ...ts.letters };
  const before = letters[playerId] ?? [];
  let after = addLetters(word, before);
  const lives = { ...ts.lives };
  let note = "";

  if (
    !ts.survival &&
    after.length === ALPHABET_TARGET &&
    (lives[playerId] ?? 0) > 0
  ) {
    lives[playerId] = Math.min(5, (lives[playerId] ?? 0) + 1);
    after = [];
    note = `${nameOf(playerId)} got an extra life`;
  }

  letters[playerId] = after;

  return {
    ...ts,
    used: [...ts.used, word],
    totalWords: ts.totalWords + 1,
    lastWord: word,
    lastWordBy: playerId,
    letters,
    lives,
    note,
  };
}

function solveTimedTurn(
  ts: TurnState,
  word: string,
  prompts: PromptItem[],
  present: Set<string>,
  nameOf: (id: string) => string,
  limit: number,
  shorten: boolean,
): TurnState {
  const base = recordAcceptedWord(ts, word, ts.current, nameOf);
  const alive = aliveIds(base, present);
  const idx = ts.order.indexOf(ts.current);
  const holder = firstAliveFrom(ts.order, alive, idx + 1) ?? ts.current;
  const nextLimit =
    shorten &&
    base.totalWords >= present.size * TIMED_SHORT_AFTER_WORDS_PER_PLAYER
      ? TIMED_SHORT_TIME_DEFAULT
      : limit;

  return withNewFragment(base, prompts, holder, base.note, "timed", nextLimit);
}

function failTimedTurn(
  ts: TurnState,
  prompts: PromptItem[],
  present: Set<string>,
  nameOf: (id: string) => string,
  limit: number,
  shorten: boolean,
): TurnState {
  const current = ts.current;
  const livesLeft = !present.has(current)
    ? 0
    : Math.max(0, (ts.lives[current] ?? 0) - 1);
  const lives = { ...ts.lives, [current]: livesLeft };
  const eliminated =
    livesLeft === 0 && !ts.eliminated.includes(current)
      ? [...ts.eliminated, current]
      : ts.eliminated;

  const base = {
    ...ts,
    lives,
    eliminated,
    endedAt:
      aliveIds({ ...ts, lives, eliminated }, present).size <= 1
        ? new Date().toISOString()
        : ts.endedAt,
    note: !present.has(current)
      ? `${nameOf(current)} left`
      : livesLeft === 0
        ? `${nameOf(current)} is out!`
        : `${nameOf(current)} ran out of time`,
  };

  const alive = aliveIds(base, present);
  if (alive.size <= 1) return base;

  const idx = ts.order.indexOf(current);
  const holder = firstAliveFrom(ts.order, alive, idx + 1) ?? current;
  const nextLimit =
    shorten &&
    base.totalWords >= present.size * TIMED_SHORT_AFTER_WORDS_PER_PLAYER
      ? TIMED_SHORT_TIME_DEFAULT
      : limit;

  return withNewFragment(base, prompts, holder, base.note, "timed", nextLimit);
}

function solveSurvivalTurn(
  ts: TurnState,
  word: string,
  prompts: PromptItem[],
  present: Set<string>,
  nameOf: (id: string) => string,
): TurnState {
  const elapsed = Math.min(
    SURVIVAL_SKIP_SECONDS,
    Math.max(0, (Date.now() - new Date(ts.turnStartedAt).getTime()) / 1000),
  );
  const remaining = {
    ...ts.remaining,
    [ts.current]: Math.max(0, (ts.remaining[ts.current] ?? 0) - elapsed),
  };
  const base = recordAcceptedWord(
    { ...ts, remaining },
    word,
    ts.current,
    nameOf,
  );
  const alive = aliveIds(base, present);
  const idx = ts.order.indexOf(ts.current);
  const holder = firstAliveFrom(ts.order, alive, idx + 1) ?? ts.current;

  if (alive.size <= 1) {
    return { ...base, endedAt: new Date().toISOString() };
  }

  return withNewFragment(
    base,
    prompts,
    holder,
    base.note,
    "survival",
    SURVIVAL_SKIP_SECONDS,
  );
}

function failSurvivalTurn(
  ts: TurnState,
  prompts: PromptItem[],
  present: Set<string>,
  nameOf: (id: string) => string,
): TurnState {
  const elapsed = Math.min(
    SURVIVAL_SKIP_SECONDS,
    Math.max(0, (Date.now() - new Date(ts.turnStartedAt).getTime()) / 1000),
  );
  const current = ts.current;
  const remaining = {
    ...ts.remaining,
    [current]: Math.max(0, (ts.remaining[current] ?? 0) - elapsed),
  };
  const eliminated =
    (remaining[current] ?? 0) <= 0 && !ts.eliminated.includes(current)
      ? [...ts.eliminated, current]
      : ts.eliminated;

  const base = {
    ...ts,
    remaining,
    eliminated,
    endedAt:
      aliveIds({ ...ts, remaining, eliminated }, present).size <= 1
        ? new Date().toISOString()
        : ts.endedAt,
    note:
      (remaining[current] ?? 0) <= 0
        ? `${nameOf(current)} is out!`
        : `${nameOf(current)} was skipped after 15 seconds`,
  };

  const alive = aliveIds(base, present);
  if (alive.size <= 1) return base;

  const idx = ts.order.indexOf(current);
  const holder = firstAliveFrom(ts.order, alive, idx + 1) ?? current;

  return withNewFragment(
    base,
    prompts,
    holder,
    base.note,
    "survival",
    SURVIVAL_SKIP_SECONDS,
  );
}

/* ==========================================================================
 * API HELPERS
 * ========================================================================== */

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
  setGamesPlayed: Dispatch<SetStateAction<number>>,
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

async function countGamePlayed(
  setGamesPlayed: Dispatch<SetStateAction<number>>,
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
    )}&select=room_code,status,host_id,prompts,game_number,finish_mode,started_at,game_mode,turn_number,turn_state&limit=1`,
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

// Compare-and-set for hot potato. The `turn_number=eq.N` filter means the
// update only applies if nobody else advanced the turn first (e.g. the solver
// and the host's timeout firing at the same moment). Returns the new row, or
// null if we lost the race (which is fine: the poll will show the winner's state).
async function patchTurn(room: string, expectedTurn: number, next: TurnState) {
  const rows = await request<Pick<Game, "turn_state" | "turn_number">[] | null>(
    `${GAMES_URL}?room_code=eq.${enc(
      room,
    )}&turn_number=eq.${expectedTurn}&select=turn_state,turn_number`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        turn_state: next,
        turn_number: expectedTurn + 1,
        updated_at: new Date().toISOString(),
      }),
    },
  );

  return rows?.[0] ?? null;
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

// Server stamps finished_at = now() once progress >= target.
// (alphabet passes 26, the others pass 20)
function saveFinished(target: number) {
  return request<null>(`${SUPABASE_URL}/rest/v1/rpc/finish_group_player`, {
    method: "POST",
    body: JSON.stringify({
      p_player_id: getPlayerId(),
      p_target_words: target,
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

/* ==========================================================================
 * COMPONENT
 * ========================================================================== */

export default function GroupGame({ onExit, makePrompts, isValidWord }: Props) {
  const me = useMemo(getPlayerId, []);

  // ---- menu state ----
  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) ?? "");
  const [codeInput, setCodeInput] = useState("");

  // ---- room state (synced from Supabase by polling) ----
  const [room, setRoom] = useState<string | null>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);

  // ---- UI feedback ----
  const [error, setError] = useState("");
  const [syncError, setSyncError] = useState("");
  const [busy, setBusy] = useState(false);

  // ---- host settings (only used by the host when starting) ----
  const [difficulty, setDifficulty] = useState<GroupDifficulty>("superEasy");
  const [finishMode, setFinishMode] = useState<"first" | "last">("first");
  const [modeChoice, setModeChoice] = useState<GroupMode>("rush");
  const [turnTime, setTurnTime] = useState(10);
  const [timedLives, setTimedLives] = useState(TIMED_LIVES_DEFAULT);
  const [shortenTimed, setShortenTimed] = useState(true);

  // ---- my local race state ----
  const [index, setIndex] = useState(0); // words I've answered (race modes)
  const [input, setInput] = useState("");
  const [message, setMessage] = useState("");
  const [used, setUsed] = useState<Set<string>>(new Set());
  const [letters, setLetters] = useState<Set<string>>(new Set()); // alphabet
  const [countdown, setCountdown] = useState(0);
  const [raceTime, setRaceTime] = useState(0);
  const [gameElapsed, setGameElapsed] = useState(0);
  const [turnLeft, setTurnLeft] = useState(0); // timed: seconds left this turn
  const [skipLeft, setSkipLeft] = useState(0); // survival only: seconds until 15s skip

  const [gamesPlayed, setGamesPlayed] = useState(0);

  const seenGameNumber = useRef(0);
  const saveChain = useRef<Promise<unknown>>(Promise.resolve());
  const firedTurn = useRef(""); // host: which turn I already tried to time out

  const isHost = !!game && game.host_id === me;

  const mode: GroupMode = game?.game_mode ?? "rush";
  const isTimed = mode === "timed" || mode === "survival";
  const isSurvival = mode === "survival";
  const target = targetOf(mode);
  const ts = game?.turn_state ?? null;

  const queueSave = (fn: () => Promise<unknown>) => {
    saveChain.current = saveChain.current
      .catch(() => {})
      .then(fn)
      .catch((e) => console.error("SAVE ERROR:", e));
  };

  /* ------------------------------------------------------------------------
   * EFFECTS
   * ---------------------------------------------------------------------- */

  useEffect(() => {
    loadGamesPlayed(setGamesPlayed);

    const id = window.setInterval(() => {
      loadGamesPlayed(setGamesPlayed);
    }, 5000);

    return () => window.clearInterval(id);
  }, []);

  // Poll the room + players. Faster while a timed game is running.
  const pollMs =
    isTimed && game?.status === "playing" ? TIMED_POLL_MS : POLL_MS;

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

    const id = window.setInterval(tick, pollMs);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [room, pollMs]);

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

  // Reset MY local state whenever a new round begins.
  useEffect(() => {
    if (!game) return;

    if (game.game_number !== seenGameNumber.current) {
      seenGameNumber.current = game.game_number;

      setIndex(0);
      setInput("");
      setMessage("");
      setUsed(new Set());
      setLetters(new Set());
    }
  }, [game?.game_number]);

  // Timed: clear the box whenever the potato moves.
  useEffect(() => {
    setInput("");
    setMessage("");
  }, [game?.turn_number]);

  // Countdown to started_at.
  useEffect(() => {
    if (!game || game.status !== "playing" || !game.started_at) {
      setCountdown(0);
      return;
    }

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

  // Race clock (race modes).
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

  // Total multiplayer game length.
  useEffect(() => {
    if (!game || game.status !== "playing" || !game.started_at) {
      setGameElapsed(0);
      return;
    }

    const start = new Date(game.started_at).getTime();
    const update = () => {
      const end = ts?.endedAt ? new Date(ts.endedAt).getTime() : Date.now();
      setGameElapsed(Math.max(0, (end - start) / 1000));
    };

    update();
    const id = window.setInterval(update, 100);
    return () => window.clearInterval(id);
  }, [game?.status, game?.started_at, ts?.endedAt]);

  // Timed: seconds left on the current turn (and the 15s skip clock in survival).
  useEffect(() => {
    if (!isTimed || !ts || game?.status !== "playing") {
      setTurnLeft(0);
      setSkipLeft(0);
      return;
    }

    const deadline = new Date(ts.deadline).getTime();
    const skipDeadline = new Date(ts.skipDeadline).getTime();
    const turnStart = new Date(ts.turnStartedAt).getTime();
    const holderRemaining = ts.remaining[ts.current] ?? 0;

    const update = () => {
      const now = Date.now();

      if (isSurvival) {
        setTurnLeft(Math.max(0, holderRemaining - (now - turnStart) / 1000));
        setSkipLeft(Math.max(0, (skipDeadline - now) / 1000));
      } else {
        setTurnLeft(Math.max(0, (deadline - now) / 1000));
        setSkipLeft(0);
      }
    };

    update();

    const id = window.setInterval(update, 100);

    return () => window.clearInterval(id);
  }, [
    isTimed,
    isSurvival,
    ts?.deadline,
    ts?.skipDeadline,
    ts?.turnStartedAt,
    ts?.current,
    game?.status,
  ]);

  /* ------------------------------------------------------------------------
   * DERIVED DATA
   * ---------------------------------------------------------------------- */

  const playerById = useMemo(
    () => new Map(players.map((p) => [p.player_id, p])),
    [players],
  );

  const nameOf = (id: string) => playerById.get(id)?.display_name ?? "someone";

  // ---- race modes ----
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

  const finishedPlayers = useMemo(
    () =>
      players
        .filter(
          (p): p is Player & { finished_at: string } => p.finished_at !== null,
        )
        .sort(
          (a, b) =>
            new Date(a.finished_at).getTime() -
            new Date(b.finished_at).getTime(),
        ),
    [players],
  );

  const raceWinner = finishedPlayers[0] ?? null;

  const everyoneFinished =
    players.length > 0 && finishedPlayers.length === players.length;

  const raceIsOver =
    !!raceWinner && (game?.finish_mode === "first" || everyoneFinished);

  // ---- timed ----
  // Winner first, then everyone else by how late they were knocked out.
  const timedRanking = useMemo(() => {
    if (!ts) return [] as Player[];

    const ids = [
      ...ts.order.filter((id) => {
        if (!playerById.has(id)) return false;
        return isSurvival
          ? (ts.remaining[id] ?? 0) > 0
          : (ts.lives[id] ?? 0) > 0;
      }),
      ...[...ts.eliminated].reverse(),
    ];

    return ids.map((id) => playerById.get(id)).filter((p): p is Player => !!p);
  }, [ts, playerById, isSurvival]);

  const timedAliveCount = ts
    ? ts.order.filter((id) =>
        isSurvival ? (ts.remaining[id] ?? 0) > 0 : (ts.lives[id] ?? 0) > 0,
      ).length
    : 0;

  const timedOver = isTimed && !!ts && timedAliveCount <= 1;

  const timedSeats = useMemo(
    () =>
      ts
        ? ts.order
            .map((id) => playerById.get(id))
            .filter((p): p is Player => !!p)
        : [],
    [ts, playerById],
  );

  const myLives = ts?.lives[me] ?? 0;

  const liveRemainingFor = (playerId: string) => {
    if (!ts || !isSurvival) {
      return ts?.remaining[playerId] ?? 0;
    }

    const stored = ts.remaining[playerId] ?? 0;

    if (ts.current !== playerId) {
      return stored;
    }

    const started = new Date(ts.turnStartedAt).getTime();

    if (!Number.isFinite(started)) {
      return stored;
    }

    return Math.max(0, stored - (Date.now() - started) / 1000);
  };

  const myRemaining = liveRemainingFor(me);

  const myTurn =
    !!ts && ts.current === me && (isSurvival ? myRemaining > 0 : myLives > 0);

  const winner = isTimed ? (timedRanking[0] ?? null) : raceWinner;

  // ---- my progress in a race ----
  const myProgress = mode === "alphabet" ? letters.size : index;
  const iFinished = myProgress >= target;

  const currentPrompt =
    game?.prompts && game.prompts.length > 0
      ? game.prompts[index % game.prompts.length]
      : undefined;

  const phase: "menu" | "lobby" | "countdown" | "race" | "results" = !room
    ? "menu"
    : !game || game.status === "waiting"
      ? "lobby"
      : (isTimed ? timedOver : raceIsOver)
        ? "results"
        : countdown > 0
          ? "countdown"
          : "race";

  /* ------------------------------------------------------------------------
   * EFFECT (host only): hot-potato timeouts.
   * The host's client is the referee for "time ran out" so exactly one
   * machine decides it. patchTurn's compare-and-set covers the case where
   * the solver submits at the very last moment.
   * ---------------------------------------------------------------------- */
  useEffect(() => {
    if (
      !isHost ||
      !room ||
      !game ||
      !ts ||
      !isTimed ||
      game.status !== "playing" ||
      timedOver
    ) {
      return;
    }

    const turnKey = `${game.game_number}:${game.turn_number}`;
    const expected = game.turn_number;
    const prompts = game.prompts ?? [];

    const check = () => {
      if (firedTurn.current === turnKey) return;

      const present = new Set<string>(players.map((p) => p.player_id));
      const deadline = isSurvival ? ts.skipDeadline : ts.deadline;
      const expired =
        Date.now() >= new Date(deadline).getTime() + TIMEOUT_GRACE_MS;

      if (present.has(ts.current) && !expired) return;

      firedTurn.current = turnKey;

      const next = isSurvival
        ? failSurvivalTurn(ts, prompts, present, nameOf)
        : failTimedTurn(ts, prompts, present, nameOf, turnTime, shortenTimed);

      patchTurn(room, expected, next)
        .then((row) => {
          if (row) applyTurnRow(row);
        })
        .catch((e) => {
          console.error("TIMEOUT ERROR:", e);
          firedTurn.current = "";
        });
    };

    check();

    const id = window.setInterval(check, 250);
    return () => window.clearInterval(id);
  }, [
    isHost,
    room,
    isTimed,
    isSurvival,
    game?.game_number,
    game?.turn_number,
    game?.status,
    ts?.deadline,
    ts?.skipDeadline,
    players,
    timedOver,
    turnTime,
    shortenTimed,
  ]);

  // Apply a freshly written turn row locally so the actor sees it instantly
  // instead of waiting for the next poll.
  const applyTurnRow = (row: Pick<Game, "turn_state" | "turn_number">) => {
    setGame((cur) =>
      cur && row.turn_number >= cur.turn_number
        ? { ...cur, turn_state: row.turn_state, turn_number: row.turn_number }
        : cur,
    );
  };

  /* ------------------------------------------------------------------------
   * ACTIONS
   * ---------------------------------------------------------------------- */

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
    firedTurn.current = "";

    setGame(null);
    setPlayers([]);
    setCountdown(0);
    setRaceTime(0);
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
    setRaceTime(0);
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

  // START GAME (host only)
  const handleStart = async () => {
    if (!room || !game || !isHost) return;

    if (players.length < MIN_PLAYERS) {
      setError(`you need at least ${MIN_PLAYERS} players to start.`);
      return;
    }

    setBusy(true);
    setError("");

    try {
      const prompts = makePrompts(
        promptCountFor(modeChoice),
        difficulty,
        modeChoice,
      );

      const startedAt = new Date(
        Date.now() + COUNTDOWN_SECONDS * 1000,
      ).toISOString();

      let turnState: TurnState | null = null;

      if (modeChoice === "timed" || modeChoice === "survival") {
        const order = players.map((p) => p.player_id);
        const isSurvivalMode = modeChoice === "survival";
        const initialLimit = isSurvivalMode ? SURVIVAL_TIME : turnTime;

        turnState = {
          current: order[0],
          origin: order[0],
          prompt: prompts[0],
          promptIndex: 0,
          deadline: new Date(
            new Date(startedAt).getTime() + initialLimit * 1000,
          ).toISOString(),
          skipDeadline: new Date(
            new Date(startedAt).getTime() +
              (isSurvivalMode ? SURVIVAL_SKIP_SECONDS : initialLimit) * 1000,
          ).toISOString(),
          turnStartedAt: startedAt,
          limit: initialLimit,
          order,
          lives: Object.fromEntries(
            order.map((id) => [id, isSurvivalMode ? 1 : timedLives]),
          ),
          remaining: Object.fromEntries(order.map((id) => [id, SURVIVAL_TIME])),
          letters: Object.fromEntries(order.map((id) => [id, []])),
          eliminated: [],
          used: [],
          totalWords: 0,
          lastWord: "",
          lastWordBy: "",
          note: "",
          endedAt: null,
          survival: isSurvivalMode,
        };
      }

      await resetPlayers(room);

      for (let i = 0; i < players.length; i++) {
        await countGamePlayed(setGamesPlayed);
      }

      firedTurn.current = "";

      await patchGame(room, {
        status: "playing",
        prompts,
        game_number: game.game_number + 1,
        game_mode: modeChoice,
        finish_mode:
          modeChoice === "timed" || modeChoice === "survival"
            ? "first"
            : finishMode,
        started_at: startedAt,
        turn_number:
          modeChoice === "timed" || modeChoice === "survival" ? 1 : 0,
        turn_state: turnState,
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
        turn_state: null,
        turn_number: 0,
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

  // SUBMIT A WORD (rush / sixrush / alphabet)
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();

    if (!game?.started_at || Date.now() < new Date(game.started_at).getTime()) {
      return;
    }

    if (!currentPrompt || iFinished) return;

    const word = input.trim().toLowerCase();

    const problem = checkWord(
      word,
      currentPrompt.fragment,
      mode,
      isValidWord,
      used,
    );

    if (problem) {
      setMessage(problem);
      return;
    }

    // --- word accepted ---
    const nextIndex = index + 1;

    const nextLetters = new Set(letters);

    for (const char of word.toUpperCase()) nextLetters.add(char);

    const nextProgress = mode === "alphabet" ? nextLetters.size : nextIndex;

    setUsed((current) => {
      const updated = new Set(current);

      updated.add(word);

      return updated;
    });

    setIndex(nextIndex);
    setLetters(nextLetters);
    setInput("");
    setMessage(nextProgress >= target ? "" : "good word!");

    if (nextProgress >= target) {
      queueSave(() => saveProgress(target));
      queueSave(() => saveFinished(target));
    } else {
      queueSave(() => saveProgress(nextProgress));
    }
  };

  // SUBMIT A WORD (timed / survival): only works on my turn.
  const handleTimedSubmit = (event: FormEvent) => {
    event.preventDefault();

    if (!room || !game || !ts || !myTurn || timedOver) return;

    if (!game.started_at || Date.now() < new Date(game.started_at).getTime()) {
      return;
    }

    const word = input.trim().toLowerCase();

    const problem = checkWord(
      word,
      ts.prompt.fragment,
      "timed",
      isValidWord,
      new Set(ts.used),
    );

    if (problem) {
      setMessage(problem);
      return;
    }

    const present = new Set<string>(players.map((p) => p.player_id));
    const next = isSurvival
      ? solveSurvivalTurn(ts, word, game.prompts ?? [], present, nameOf)
      : solveTimedTurn(
          ts,
          word,
          game.prompts ?? [],
          present,
          nameOf,
          turnTime,
          shortenTimed,
        );

    setInput("");

    patchTurn(room, game.turn_number, next)
      .then((row) => {
        if (row) applyTurnRow(row);
      })
      .catch((e) => {
        console.error("TIMED SUBMIT ERROR:", e);
        setMessage("couldn't send that word. try again.");
      });
  };

  /* ------------------------------------------------------------------------
   * RENDER HELPERS
   * ---------------------------------------------------------------------- */

  const progressOf = (p: Player) =>
    phase === "race" && p.player_id === me ? myProgress : p.progress;

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

  // Progress bars for race modes.
  const renderScoreboard = () => (
    <div className="mp-board">
      {(phase === "results" ? ranked : players).map((p) => {
        const count = Math.min(target, progressOf(p));

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
                  style={{ marginRight: "6px", fontSize: "15px" }}
                  aria-label="winner"
                >
                  👑
                </span>
              )}

              {p.display_name}
            </span>

            <div className="mp-bar">
              <i style={{ width: `${(count / target) * 100}%` }} />
            </div>

            <span className="mp-count">
              {elapsed !== null ? formatTime(elapsed) : `${count}/${target}`}
            </span>
          </div>
        );
      })}
    </div>
  );

  const renderTimedBoard = () => {
    if (!ts) return null;

    const rows = phase === "results" ? timedRanking : timedSeats;

    return (
      <div className="mp-board">
        {rows.map((p) => {
          const lives = ts.lives[p.player_id] ?? 0;
          const remaining = liveRemainingFor(p.player_id);
          const out = isSurvival ? remaining <= 0 : lives <= 0;
          const holdingTurn =
            phase === "race" && !out && ts.current === p.player_id;

          return (
            <div
              key={p.player_id}
              className={p.player_id === me ? "mp-row mp-me" : "mp-row"}
              style={out ? { opacity: 0.45 } : undefined}
            >
              <span className="mp-name">
                {phase === "results" && winner?.player_id === p.player_id && (
                  <span style={{ marginRight: "6px", fontSize: "15px" }}>
                    👑
                  </span>
                )}
                {holdingTurn && (
                  <span
                    style={{ marginRight: "6px" }}
                    aria-label="has the turn"
                  >
                    ▶
                  </span>
                )}
                {p.display_name}
              </span>

              <div className="mp-bar">
                <i
                  style={{
                    width: `${
                      isSurvival
                        ? Math.max(
                            0,
                            Math.min(100, (remaining / SURVIVAL_TIME) * 100),
                          )
                        : Math.max(
                            0,
                            Math.min(
                              100,
                              (lives / Math.max(1, timedLives)) * 100,
                            ),
                          )
                    }%`,
                  }}
                />
              </div>

              <span className="mp-count">
                {isSurvival
                  ? out
                    ? "out"
                    : `${remaining.toFixed(1)}s`
                  : out
                    ? "out"
                    : "♥".repeat(lives)}
              </span>
            </div>
          );
        })}
      </div>
    );
  };

  const goalText = isSurvival
    ? "one life each. 60 seconds total per player. turns auto-skip after 15 seconds."
    : isTimed
      ? `last player standing wins. ${timedLives} lives each.`
      : game?.finish_mode === "last"
        ? mode === "alphabet"
          ? "everyone must collect all 26 letters"
          : `everyone must reach ${TARGET_WORDS} words`
        : mode === "alphabet"
          ? "first to collect all 26 letters wins"
          : `first to ${TARGET_WORDS} words wins`;

  /* ------------------------------------------------------------------------
   * RENDER
   * ---------------------------------------------------------------------- */
  return (
    <section className="card mp-screen">
      <div className="mp-stats">
        <span>
          total games played by all users{" "}
          <strong>{gamesPlayed.toLocaleString()}</strong>
        </span>
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

      {/* ============ MENU ============ */}
      {phase === "menu" && (
        <div className="mp-menu">
          <div className="results-header">
            <small>multiplayer</small>

            <h2>wordtimer</h2>

            <p>everyone gets the same letters. pick a mode and race.</p>
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

      {/* ============ LOBBY ============ */}
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
                <small>mode</small>

                <div
                  className="option-grid"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(2, 1fr)",
                  }}
                >
                  {MODE_OPTIONS.map((option) => (
                    <button
                      type="button"
                      key={option.value}
                      className={
                        modeChoice === option.value
                          ? "option selected"
                          : "option"
                      }
                      onClick={() => setModeChoice(option.value)}
                    >
                      <strong>{option.label}</strong>

                      <span>{option.hint}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="divider" />

              {modeChoice === "timed" ? (
                <>
                  <div className="setting">
                    <small>lives per player</small>
                    <div className="option-grid time-options">
                      {TIMED_LIFE_OPTIONS.map((value) => (
                        <button
                          type="button"
                          key={value}
                          className={
                            timedLives === value ? "option selected" : "option"
                          }
                          onClick={() => setTimedLives(value)}
                        >
                          <strong>{value}</strong>
                          <span>♥</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="divider" />

                  <div className="setting">
                    <small>time per turn</small>
                    <div className="option-grid time-options">
                      {TURN_TIME_OPTIONS.map((seconds) => (
                        <button
                          type="button"
                          key={seconds}
                          className={
                            turnTime === seconds ? "option selected" : "option"
                          }
                          onClick={() => setTurnTime(seconds)}
                        >
                          <strong>{seconds}s</strong>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="divider" />

                  <div className="setting">
                    <small>speed up after</small>
                    <button
                      type="button"
                      className={shortenTimed ? "option selected" : "option"}
                      onClick={() => setShortenTimed((value) => !value)}
                    >
                      <strong>{shortenTimed ? "on" : "off"}</strong>
                      <span>
                        {`after ${players.length * TIMED_SHORT_AFTER_WORDS_PER_PLAYER} prompts → ${TIMED_SHORT_TIME_DEFAULT}s`}
                      </span>
                    </button>
                  </div>
                </>
              ) : modeChoice === "survival" ? (
                <div className="setting"></div>
              ) : (
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
              )}

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

      {/* ============ COUNTDOWN ============ */}
      {phase === "countdown" && (
        <div className="mp-countdown-screen">
          <small>
            get ready ·{" "}
            {MODE_OPTIONS.find((o) => o.value === mode)?.label ?? mode}
          </small>

          <div className="mp-countdown">{countdown}</div>

          <p className="rule">{goalText}</p>
        </div>
      )}

      {/* ============ RACE (rush / sixrush / alphabet) ============ */}
      {phase === "race" && !isTimed && (
        <div className="mp-race">
          <div className="timer">{raceTime.toFixed(2)}s</div>

          {iFinished ? (
            <div className="results-header">
              <small>you finished!</small>

              <h2>
                {target}/{target}
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
                  {mode === "alphabet"
                    ? `LETTERS ${letters.size} OF ${ALPHABET_TARGET}`
                    : `WORD ${index + 1} OF ${TARGET_WORDS}`}
                </small>

                <strong>{currentPrompt?.fragment.toUpperCase()}</strong>

                <p>
                  {mode === "sixrush"
                    ? "put these letters in your word. 6+ letters."
                    : "put these letters in order anywhere in your word"}
                </p>
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

          {mode === "alphabet" && (
            <div className="alphabet">
              {ALPHABET.map((letter) => (
                <span
                  className={letters.has(letter) ? "complete" : ""}
                  key={letter}
                >
                  {letter}
                </span>
              ))}
            </div>
          )}

          <div className="divider" />

          {renderScoreboard()}

          {syncError && <div className="message">{syncError}</div>}
        </div>
      )}

      {/* ============ RACE (timed / hot potato) ============ */}
      {phase === "race" && isTimed && ts && (
        <div className="mp-race">
          {isSurvival && (
            <div className="mp-survival-top">
              <strong>turn skips in {Math.ceil(skipLeft)}s</strong>
            </div>
          )}

          <div className="mp-last">
            {ts.lastWord ? (
              <>
                <small>{nameOf(me)} typed</small>
                <strong>{ts.lastWord}</strong>
              </>
            ) : (
              <small>no words typed yet</small>
            )}
          </div>

          <div className="prompt">
            <small>
              {myTurn
                ? "YOUR TURN"
                : (isSurvival ? myRemaining <= 0 : myLives <= 0)
                  ? "YOU'RE OUT. WATCHING"
                  : `${nameOf(ts.current).toUpperCase()}'S TURN`}
            </small>

            <strong>{ts.prompt.fragment.toUpperCase()}</strong>

            <p>
              {myTurn
                ? "put these letters in order anywhere in your word"
                : "waiting for them to answer or run out of time"}
            </p>
          </div>

          {myTurn && (
            <form onSubmit={handleTimedSubmit}>
              <div className="entry">
                <input
                  key={game?.turn_number}
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
          )}

          {ts.note && <div className="message">{ts.note}</div>}

          <div className="divider" />

          {renderTimedBoard()}

          {!isSurvival && (
            <>
              <div className="divider" />

              <div className="section-heading">
                <div>
                  <small>alphabet bonus</small>
                  <h2>get a life</h2>
                </div>
                <strong>{(ts.letters[me] ?? []).length}/26</strong>
              </div>

              <div className="alphabet">
                {ALPHABET.map((letter) => (
                  <span
                    className={
                      (ts.letters[me] ?? []).includes(letter) ? "complete" : ""
                    }
                    key={letter}
                  >
                    {letter}
                  </span>
                ))}
              </div>

              <p className="rule">
                collect all 26 letters from your words to gain an extra life.
              </p>
            </>
          )}

          {syncError && <div className="message">{syncError}</div>}
        </div>
      )}

      {/* ============ RESULTS ============ */}
      {phase === "results" && winner && (
        <div className="mp-results">
          <div className="results-header">
            <small>{winner.player_id === me ? "you won!" : "game over"}</small>

            <h2>👑 {winner.display_name} wins</h2>

            <p>
              {isSurvival
                ? "last player standing with time left"
                : isTimed
                  ? "last player standing"
                  : game?.finish_mode === "last"
                    ? "everyone finished"
                    : mode === "alphabet"
                      ? "first to collect all 26 letters"
                      : `first to ${TARGET_WORDS} words`}
            </p>
          </div>

          <div className="divider" />

          {isTimed && ts && (
            <div className="mp-stats">
              <span>
                total words <strong>{ts.totalWords}</strong>
              </span>
              <span>
                game length <strong>{gameElapsed.toFixed(1)}s</strong>
              </span>
            </div>
          )}

          {isTimed ? renderTimedBoard() : renderScoreboard()}

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
