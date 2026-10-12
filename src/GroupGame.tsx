import type { Dispatch, FormEvent, SetStateAction } from "react";
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
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const ALPHABET_TARGET = ALPHABET.length;
const ROOM_CODE_LENGTH = 4;
const TIMED_LIVES_DEFAULT = 3;
const TIMED_LIFE_OPTIONS = [1, 2, 3, 4, 5];
const TURN_TIME_OPTIONS = [5, 10, 20, 60];
const SURVIVAL_TIME = 60;
const SURVIVAL_SKIP_SECONDS = 15;
const TIMED_SHORT_TIME_DEFAULT = 5;
const TIMED_SHORT_AFTER_WORDS_PER_PLAYER = 20;
const PROMPT_POOL_SIZE = 60;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 16;
const MAX_NAME_LENGTH = 15;
const POLL_MS = 1000;
const TIMED_POLL_MS = 500;
const COUNTDOWN_SECONDS = 3;
const TIMEOUT_GRACE_MS = 300;
const BACKUP_GRACE_MS = 2000;

let clockOffset = 0;
let bestSample = { rtt: Infinity, at: 0 };

// Returns the current time in milliseconds on the shared clock. It is the
// device's Date.now() plus the measured offset from the server, so every
// player's deadlines line up even if their own clocks are wrong.
const now = () => Date.now() + clockOffset;

// Same as now(), but formatted as an ISO timestamp string, which is the
// format the database stores.
const nowIso = () => new Date(now()).toISOString();

// Measures how far this device's clock is from the server's. For each sample
// it calls the server_now function, times the round trip, and assumes the
// server read its clock halfway through, so offset = server - midpoint. It
// keeps the sample with the lowest round-trip time (the most accurate one) and
// replaces it after two minutes. If a request fails, the local clock is used.
async function syncClock(samples = 1) {
  for (let i = 0; i < samples; i++) {
    const t0 = Date.now();

    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/server_now`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });

      const t1 = Date.now();

      if (!res.ok) continue;

      const server = Number(await res.json());

      if (!Number.isFinite(server)) continue;

      const rtt = t1 - t0;

      if (rtt <= bestSample.rtt || t1 - bestSample.at > 120_000) {
        bestSample = { rtt, at: t1 };
        clockOffset = server - (t0 + t1) / 2;
      }
    } catch { }
  }
}

export type GroupDifficulty = "superEasy" | "hard";

export type GroupMode = "rush" | "sixrush" | "alphabet" | "timed" | "survival";

export type PromptItem = {
  fragment: string;
  examples: string[];
};

type TurnState = {
  current: string;
  origin: string;
  prompt: PromptItem;
  promptIndex: number;
  deadline: string;
  skipDeadline: string;
  turnStartedAt: string;
  limit: number;
  shorten: boolean;
  maxLives: number;
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
  game_mode: GroupMode;
  turn_number: number;
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

// Returns how much progress a player needs to finish a race: 26 letters for
// alphabet mode, otherwise 20 words.
const targetOf = (mode: GroupMode) =>
  mode === "alphabet" ? ALPHABET_TARGET : TARGET_WORDS;

// Returns how many prompts to generate for a mode. Rush and sixrush need
// exactly 20. Alphabet, timed and survival have no fixed length, so they get a
// pool of 60 that wraps back to the start if it ever runs out.
const promptCountFor = (mode: GroupMode) =>
  mode === "alphabet" || mode === "timed" || mode === "survival"
    ? PROMPT_POOL_SIZE
    : TARGET_WORDS;

// Validates a submitted word and returns an error message, or null if it is
// fine. It checks in order: minimum length (6 for sixrush, otherwise one more
// than the fragment), letters only, contains the fragment, exists in the
// dictionary, and has not been used before. The `used` argument only needs a
// has() method, so it accepts a Set.
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

// Merges the letters of a word into a player's collected-letter list. It
// puts the existing letters in a Set, adds each uppercase letter of the word,
// and returns the result as an array without duplicates.
const addLetters = (word: string, current: string[]) => {
  const next = new Set(current);
  for (const char of word.toUpperCase()) {
    if (ALPHABET.includes(char)) next.add(char);
  }
  return [...next];
};

// Returns the seconds allowed per turn in timed mode. It uses the rules saved
// in the turn state, not any one player's settings, so every client agrees. The
// time drops to the short value once speed-up is on and total words reach
// (players x 20).
const timedLimitFor = (ts: TurnState) =>
  ts.shorten &&
    ts.totalWords >= ts.order.length * TIMED_SHORT_AFTER_WORDS_PER_PLAYER
    ? TIMED_SHORT_TIME_DEFAULT
    : ts.limit;

// Returns how many seconds the current player has used on this turn. It
// subtracts the turn start from the shared clock, never goes below 0, and caps
// the result at the 15 second skip time.
const turnElapsed = (ts: TurnState) =>
  Math.min(
    SURVIVAL_SKIP_SECONDS,
    Math.max(0, (now() - new Date(ts.turnStartedAt).getTime()) / 1000),
  );

// Returns the set of players still in the game. A player counts as alive if
// they are still in the room and have lives left (timed) or time left in their
// bank (survival).
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

// Finds who gets the next turn. It walks the seating order starting at
// startIdx, wrapping around the end of the list with modulo, and returns the
// first player who is alive, or null if nobody is.
function firstAliveFrom(order: string[], alive: Set<string>, startIdx: number) {
  for (let step = 0; step < order.length; step++) {
    const id = order[(startIdx + step) % order.length];
    if (alive.has(id)) return id;
  }
  return null;
}

// Builds the turn state for the next turn. It advances the prompt index
// (wrapping around the prompt list), makes the chosen player the holder, and
// takes one timestamp for the whole turn. It then computes two deadlines: the
// skip deadline (when the turn ends) and the main deadline (when their clock
// runs out). In survival the turn is at most 15 seconds and limited by the
// player's bank; in timed both use the per-turn limit.
function withNewFragment(
  ts: TurnState,
  prompts: PromptItem[],
  holder: string,
  note: string,
  mode: GroupMode,
  limit: number,
): TurnState {
  const promptIndex = ts.promptIndex + 1;
  const t = now();
  const bank = ts.remaining[holder] ?? SURVIVAL_TIME;
  const turnSeconds =
    mode === "survival" ? Math.min(SURVIVAL_SKIP_SECONDS, bank) : limit;
  const bankSeconds = mode === "survival" ? bank : limit;

  return {
    ...ts,
    current: holder,
    origin: holder,
    promptIndex,
    prompt: prompts[promptIndex % prompts.length] ?? ts.prompt,
    deadline: new Date(t + bankSeconds * 1000).toISOString(),
    skipDeadline: new Date(t + turnSeconds * 1000).toISOString(),
    turnStartedAt: new Date(t).toISOString(),
    note,
  };
}

// Records a correct word in the turn state without changing whose turn it
// is. It adds the word to the shared used list, increases the total word count,
// stores the last word and who typed it, and adds the word's letters to that
// player's alphabet collection. It returns a new state object and does not
// modify the old one.
function recordAcceptedWord(
  ts: TurnState,
  word: string,
  playerId: string,
): TurnState {
  const letters = { ...ts.letters };
  letters[playerId] = addLetters(word, letters[playerId] ?? []);

  return {
    ...ts,
    used: [...ts.used, word],
    totalWords: ts.totalWords + 1,
    lastWord: word,
    lastWordBy: playerId,
    letters,
    note: "",
  };
}

// Computes the next state after a player answers correctly in timed mode. It
// records the word, finds the next alive player after the current seat, and
// hands them a new fragment with a fresh timer. The pure function is run by the
// client that answered, and the database write decides if it takes effect.
function solveTimedTurn(
  ts: TurnState,
  word: string,
  prompts: PromptItem[],
  present: Set<string>,
  nameOf: (id: string) => string,
): TurnState {
  const base = recordAcceptedWord(ts, word, ts.current);
  const alive = aliveIds(base, present);
  const idx = ts.order.indexOf(ts.current);
  const holder = firstAliveFrom(ts.order, alive, idx + 1) ?? ts.current;

  return withNewFragment(
    base,
    prompts,
    holder,
    base.note || `${nameOf(ts.current)} typed ${word}`,
    "timed",
    timedLimitFor(base),
  );
}

// Computes the next state when the current player runs out of time in timed
// mode. They lose one life, or all of them if they left the room. They are added
// to the elimination list when lives reach 0. If one or no players remain, it
// sets endedAt and returns without a new turn. Otherwise the turn passes to the
// next alive player with a new fragment.
function failTimedTurn(
  ts: TurnState,
  prompts: PromptItem[],
  present: Set<string>,
  nameOf: (id: string) => string,
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
        ? nowIso()
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

  return withNewFragment(
    base,
    prompts,
    holder,
    base.note,
    "timed",
    timedLimitFor(base),
  );
}

// Computes the next state after a correct answer in survival mode. It
// subtracts the time used this turn from the player's bank and eliminates them
// if the bank hits 0. After recording the word, it ends the game if one or no
// players are left. Otherwise the next alive player gets a fragment with a
// 15 second window.
function solveSurvivalTurn(
  ts: TurnState,
  word: string,
  prompts: PromptItem[],
  present: Set<string>,
  nameOf: (id: string) => string,
): TurnState {
  const left = Math.max(0, (ts.remaining[ts.current] ?? 0) - turnElapsed(ts));
  const remaining = { ...ts.remaining, [ts.current]: left };
  const eliminated =
    left <= 0 && !ts.eliminated.includes(ts.current)
      ? [...ts.eliminated, ts.current]
      : ts.eliminated;

  const base = recordAcceptedWord(
    { ...ts, remaining, eliminated },
    word,
    ts.current,
  );
  const alive = aliveIds(base, present);
  const idx = ts.order.indexOf(ts.current);
  const holder = firstAliveFrom(ts.order, alive, idx + 1) ?? ts.current;

  if (alive.size <= 1) {
    return { ...base, endedAt: nowIso() };
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

// Computes the next state when a survival turn hits the 15 second skip. The
// player is charged the time used, or their whole bank if they left the room
// (otherwise they would stay "alive" and be skipped forever). They are
// eliminated if the bank reaches 0. If one or no players remain it sets endedAt
// and stops. Otherwise the turn passes to the next alive player.
function failSurvivalTurn(
  ts: TurnState,
  prompts: PromptItem[],
  present: Set<string>,
  nameOf: (id: string) => string,
): TurnState {
  const current = ts.current;
  const gone = !present.has(current);

  const remaining = {
    ...ts.remaining,
    [current]: gone
      ? 0
      : Math.max(0, (ts.remaining[current] ?? 0) - turnElapsed(ts)),
  };
  const out = (remaining[current] ?? 0) <= 0;
  const eliminated =
    out && !ts.eliminated.includes(current)
      ? [...ts.eliminated, current]
      : ts.eliminated;

  const base = {
    ...ts,
    remaining,
    eliminated,
    endedAt:
      aliveIds({ ...ts, remaining, eliminated }, present).size <= 1
        ? nowIso()
        : ts.endedAt,
    note: gone
      ? `${nameOf(current)} left`
      : out
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

// An Error type for failed API calls. It carries the HTTP status code so
// callers can react to specific cases, such as 409 (a duplicate room code or
// player name).
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

// Wrapper around fetch for all database calls. It adds the Supabase auth and
// JSON headers (callers can override them), throws an ApiError with the status
// and response body when the request fails, and parses the JSON response. An
// empty response body becomes null.
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

// Reads the global games-played total from the counter API and stores it in
// state. It does a GET and uses the value field of the JSON response. Errors are
// ignored because the counter is cosmetic.
async function loadGamesPlayed(
  setGamesPlayed: Dispatch<SetStateAction<number>>,
) {
  try {
    const response = await fetch(COUNTER_GET_URL);

    if (!response.ok) return;

    const data = await response.json();

    setGamesPlayed(Number(data.value) || 0);
  } catch { }
}

// Adds one to the global games-played counter. The hit endpoint increments
// the count and returns the new total, which is stored in state. Errors are
// ignored because the counter is cosmetic.
async function countGamePlayed(
  setGamesPlayed: Dispatch<SetStateAction<number>>,
) {
  try {
    const response = await fetch(COUNTER_URL);

    if (!response.ok) return;

    const data = await response.json();

    setGamesPlayed(Number(data.value) || 0);
  } catch { }
}

// Returns this browser's permanent player id. It reads a UUID from
// localStorage, and if none exists yet it creates one and saves it, so a player
// keeps the same identity across page reloads.
function getPlayerId() {
  let id = localStorage.getItem(PLAYER_ID_KEY);

  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(PLAYER_ID_KEY, id);
  }

  return id;
}

// Generates a random 4 letter game code. It takes random bytes from the
// browser's secure random generator and maps each to a letter. The letters I and
// O are left out so codes cannot be confused with 1 and 0.
function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ";

  return Array.from(crypto.getRandomValues(new Uint8Array(ROOM_CODE_LENGTH)))
    .map((v) => chars[v % chars.length])
    .join("");
}

// Loads one game (room) row by its code, selecting only the columns the app
// uses. It returns the row, or null if no such room exists.
async function fetchGame(room: string) {
  const rows = await request<Game[]>(
    `${GAMES_URL}?room_code=eq.${enc(
      room,
    )}&select=room_code,status,host_id,prompts,game_number,finish_mode,started_at,game_mode,turn_number,turn_state&limit=1`,
  );

  return rows[0] ?? null;
}

// Loads every player in a room, ordered by when they joined, so the first
// entry is the longest-present player.
function fetchPlayers(room: string) {
  return request<Player[]>(
    `${PLAYERS_URL}?room_code=eq.${enc(
      room,
    )}&select=player_id,room_code,display_name,joined_at,progress,finished_at&order=joined_at.asc`,
  );
}

// Deletes this browser's player row, removing the player from whichever room
// they were in.
function removeMe() {
  return request<null>(`${PLAYERS_URL}?player_id=eq.${enc(getPlayerId())}`, {
    method: "DELETE",
  });
}

// Resets every player in a room for a new round by setting progress back to 0
// and clearing their finish time.
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

// Updates fields on a room's game row and stamps updated_at with the shared
// clock time.
function patchGame(room: string, body: Record<string, unknown>) {
  return request<null>(`${GAMES_URL}?room_code=eq.${enc(room)}`, {
    method: "PATCH",
    headers: MINIMAL,
    body: JSON.stringify({
      ...body,
      updated_at: nowIso(),
    }),
  });
}

// Writes a new turn state using compare-and-set. The URL filter
// turn_number=eq.N means the update only applies if nobody else has advanced the
// turn since this client read it, such as an answer and a timeout landing at the
// same moment. It asks for the updated row back. It returns that row if the write
// won, or null if another client got there first, in which case the next poll
// shows the winning state.
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
        updated_at: nowIso(),
      }),
    },
  );

  return rows?.[0] ?? null;
}

// Saves this player's progress (words answered, or letters collected in
// alphabet mode) to the database so other players' progress bars update.
function saveProgress(progress: number) {
  return request<null>(`${PLAYERS_URL}?player_id=eq.${enc(getPlayerId())}`, {
    method: "PATCH",
    headers: MINIMAL,
    body: JSON.stringify({
      progress,
    }),
  });
}

// Tells the server this player has finished. It calls the finish_group_player
// function, which stamps finished_at with the server's own clock once progress
// has reached the target, so finish times cannot be skewed by a device's clock.
function saveFinished(target: number) {
  return request<null>(`${SUPABASE_URL}/rest/v1/rpc/finish_group_player`, {
    method: "POST",
    body: JSON.stringify({
      p_player_id: getPlayerId(),
      p_target_words: target,
    }),
  });
}

// Removes this player from a room. If they were the host, it hands host to the
// longest-present remaining player, or deletes the room when nobody is left.
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

// The multiplayer screen. The database is the source of truth: the component
// polls the room and player rows, and derives a single `phase` (menu, lobby,
// countdown, race or results) that decides what is shown. Race modes (rush,
// sixrush, alphabet) are tracked per player locally and synced as progress.
// Timed and survival are turn-based and share one turn state that is swapped
// with compare-and-set writes.
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
  const [modeChoice, setModeChoice] = useState<GroupMode>("rush");
  const [turnTime, setTurnTime] = useState(10);
  const [timedLives, setTimedLives] = useState(TIMED_LIVES_DEFAULT);
  const [shortenTimed, setShortenTimed] = useState(true);

  const [index, setIndex] = useState(0);
  const [input, setInput] = useState("");
  const [message, setMessage] = useState("");
  const [used, setUsed] = useState<Set<string>>(new Set());
  const [letters, setLetters] = useState<Set<string>>(new Set());
  const [countdown, setCountdown] = useState(0);
  const [raceTime, setRaceTime] = useState(0);
  const [gameElapsed, setGameElapsed] = useState(0);
  const [turnLeft, setTurnLeft] = useState(0);
  const [skipLeft, setSkipLeft] = useState(0);

  const [gamesPlayed, setGamesPlayed] = useState(0);

  const seenGameNumber = useRef(0);
  const saveChain = useRef<Promise<unknown>>(Promise.resolve());
  const firedTurn = useRef("");
  const jitter = useRef(Math.random() * 800);

  const isHost = !!game && game.host_id === me;

  const mode: GroupMode = game?.game_mode ?? "rush";
  const isTimed = mode === "timed" || mode === "survival";
  const isSurvival = mode === "survival";
  const target = targetOf(mode);
  const ts = game?.turn_state ?? null;

  // Runs network saves one after another. Each new save is chained onto the
  // previous promise, so an older progress update can never arrive after a newer
  // one. A failed save is logged and does not block later ones.
  const queueSave = (fn: () => Promise<unknown>) => {
    saveChain.current = saveChain.current
      .catch(() => { })
      .then(fn)
      .catch((e) => console.error("SAVE ERROR:", e));
  };

  // Effect: keeps the shared clock accurate. It takes 5 samples on mount, then
  // one every minute, and 2 more whenever the tab becomes visible again, since
  // background tabs can drift or be throttled.
  useEffect(() => {
    syncClock(5);

    const id = window.setInterval(() => syncClock(1), 60_000);

    const onVisible = () => {
      if (document.visibilityState === "visible") syncClock(2);
    };

    document.addEventListener("visibilitychange", onVisible);

    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Effect: loads the global games-played counter on mount and refreshes it
  // every 5 seconds.
  useEffect(() => {
    loadGamesPlayed(setGamesPlayed);

    const id = window.setInterval(() => {
      loadGamesPlayed(setGamesPlayed);
    }, 5000);

    return () => window.clearInterval(id);
  }, []);

  const pollMs =
    isTimed && game?.status === "playing" ? TIMED_POLL_MS : POLL_MS;

  // Effect: polls the room and its players while in a room (every 0.5 seconds
  // during a running timed or survival game, otherwise every second). If the
  // game row is gone it returns to the menu. A response older than the local turn
  // number is ignored, so a slow poll cannot undo a turn this client just wrote.
  // The `cancelled` flag discards results that arrive after cleanup.
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

        setGame((cur) =>
          cur &&
            cur.status === "playing" &&
            g.status === "playing" &&
            g.game_number === cur.game_number &&
            g.turn_number < cur.turn_number
            ? cur
            : g,
        );
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

  // Effect: removes the player from the room when the page is closed or
  // hidden. It sends a DELETE with keepalive so the browser finishes the request
  // even while the page is unloading.
  useEffect(() => {
    if (!room) return;

    const onHide = () => {
      fetch(`${PLAYERS_URL}?player_id=eq.${enc(me)}`, {
        method: "DELETE",
        keepalive: true,
        headers: AUTH_HEADERS,
      }).catch(() => { });
    };

    window.addEventListener("pagehide", onHide);

    return () => window.removeEventListener("pagehide", onHide);
  }, [room, me]);

  // Effect: resets this player's local state when a new round begins. It
  // compares the game number against the last one seen and clears the word index,
  // input, message, used words and collected letters.
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

  // Effect: clears the text box and message whenever the turn number changes,
  // so a half-typed word does not carry over to the next turn.
  useEffect(() => {
    setInput("");
    setMessage("");
  }, [game?.turn_number]);

  // Effect: drives the pre-game countdown. Every 100 ms it computes the whole
  // seconds left until started_at on the shared clock, and shows 0 once the start
  // time has passed.
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

      const remaining = Math.max(0, start - now());

      setCountdown(Math.ceil(remaining / 1000));
    };

    updateCountdown();

    const id = window.setInterval(updateCountdown, 100);

    return () => window.clearInterval(id);
  }, [game?.status, game?.started_at]);

  // Effect: drives the race stopwatch. Every 50 ms it sets raceTime to the
  // seconds since started_at on the shared clock, so all players see the same
  // time. It stays at 0 during the countdown.
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

      const elapsed = Math.max(0, now() - start);

      setRaceTime(elapsed / 1000);
    };

    updateTime();

    const id = window.setInterval(updateTime, 50);

    return () => window.clearInterval(id);
  }, [game?.status, game?.started_at]);

  // Effect: tracks the total game length for the results screen. It measures
  // from started_at to the current time, or to endedAt once the game has ended,
  // so the number stops counting when the game is over.
  useEffect(() => {
    if (!game || game.status !== "playing" || !game.started_at) {
      setGameElapsed(0);
      return;
    }

    const start = new Date(game.started_at).getTime();
    const update = () => {
      const end = ts?.endedAt ? new Date(ts.endedAt).getTime() : now();
      setGameElapsed(Math.max(0, (end - start) / 1000));
    };

    update();
    const id = window.setInterval(update, 100);
    return () => window.clearInterval(id);
  }, [game?.status, game?.started_at, ts?.endedAt]);

  // Effect: updates the turn timers in timed and survival modes. Every 100 ms it
  // computes the seconds until the survival skip and the seconds left on the
  // main clock. In survival the main clock is the player's bank minus time used
  // this turn, and in timed it is the time to the deadline.
  useEffect(() => {
    if (!isTimed || !ts || game?.status !== "playing") {
      setTurnLeft(0);
      setSkipLeft(0);
      return;
    }

    const turnStart = new Date(ts.turnStartedAt).getTime();
    const skipAt = new Date(ts.skipDeadline).getTime();
    const deadlineAt = new Date(ts.deadline).getTime();
    const bank = ts.remaining[ts.current] ?? 0;

    const update = () => {
      const t = now();

      setSkipLeft(Math.max(0, (skipAt - t) / 1000));
      setTurnLeft(
        isSurvival
          ? Math.max(0, bank - Math.max(0, (t - turnStart) / 1000))
          : Math.max(0, (deadlineAt - t) / 1000),
      );
    };

    update();

    const id = window.setInterval(update, 100);

    return () => window.clearInterval(id);
  }, [isTimed, isSurvival, game?.status, game?.turn_number, ts?.skipDeadline]);

  const playerById = useMemo(
    () => new Map(players.map((p) => [p.player_id, p])),
    [players],
  );

  // Looks up a player's display name by id, falling back to "someone" if they
  // are no longer in the room.
  const nameOf = (id: string) => playerById.get(id)?.display_name ?? "someone";

  const playersRef = useRef(players);
  playersRef.current = players;
  const nameOfRef = useRef(nameOf);
  nameOfRef.current = nameOf;

  const ranked = useMemo(
    () =>
      [...players].sort((a, b) => {
        const aFinished = a.finished_at !== null;
        const bFinished = b.finished_at !== null;

        if (aFinished && bFinished) {
          return (
            new Date(a.finished_at!).getTime() -
            new Date(b.finished_at!).getTime()
          );
        }

        if (aFinished) return -1;
        if (bFinished) return 1;

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

  // Returns a player's survival time bank including the time already used on
  // the current turn, so the display ticks down smoothly. Only the player whose
  // turn it is has a running clock; everyone else shows their stored value.
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

    return Math.max(0, stored - (now() - started) / 1000);
  };

  const myRemaining = liveRemainingFor(me);

  const myTurn =
    !!ts && ts.current === me && (isSurvival ? myRemaining > 0 : myLives > 0);

  const winner = isTimed ? (timedRanking[0] ?? null) : raceWinner;

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

  // Applies a freshly written turn row to local state right away, so the player
  // who made the move sees it instantly instead of waiting for the next poll. It
  // refuses to go backwards by ignoring rows with an older turn number.
  const applyTurnRow = (row: Pick<Game, "turn_state" | "turn_number">) => {
    setGame((cur) =>
      cur && row.turn_number >= cur.turn_number
        ? { ...cur, turn_state: row.turn_state, turn_number: row.turn_number }
        : cur,
    );
  };

  // Effect: the turn-timeout referee for timed and survival. Every 250 ms it
  // checks whether the current turn's skip deadline plus a grace period has
  // passed, or whether the current player has left the room (host only). The host
  // uses a short grace; every other client uses a longer, randomly jittered grace
  // so a backgrounded host cannot freeze the game. When a turn is late it builds
  // the "fail" state and tries patchTurn. Because patchTurn is compare-and-set,
  // several clients can try and only one write wins. firedTurn prevents retrying
  // the same turn, and is cleared if the request errors.
  useEffect(() => {
    if (
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
    const grace = isHost ? TIMEOUT_GRACE_MS : BACKUP_GRACE_MS + jitter.current;

    const check = () => {
      if (firedTurn.current === turnKey) return;

      if (now() < new Date(game.started_at ?? 0).getTime()) return;

      const present = new Set<string>(
        playersRef.current.map((p) => p.player_id),
      );
      const late = now() >= new Date(ts.skipDeadline).getTime() + grace;
      const absent = !present.has(ts.current);

      if (!late && !(absent && isHost)) return;

      firedTurn.current = turnKey;

      const nameFn = nameOfRef.current;
      const next = isSurvival
        ? failSurvivalTurn(ts, prompts, present, nameFn)
        : failTimedTurn(ts, prompts, present, nameFn);

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
    game?.started_at,
    ts?.skipDeadline,
    timedOver,
  ]);

  // Validates the display name field. The trimmed name must be 1 to 15 letters.
  // It returns the name, or sets an error message and returns null.
  const validName = () => {
    const n = name.trim().slice(0, MAX_NAME_LENGTH);

    if (!/^[A-Za-z]{1,15}$/.test(n)) {
      setError("display name must be 1–15 letters only.");
      return null;
    }

    return n;
  };

  // Moves this client into a room. It remembers the name in localStorage,
  // resets the round and turn tracking refs and clears any old game data, then
  // sets the room code, which starts the polling effect.
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

  // Creates a new game. After validating the name and leaving any previous room,
  // it tries random room codes and inserts a game row, retrying on a 409
  // (duplicate code) up to 5 times. It then inserts this player and enters the
  // room. The busy flag disables the buttons while this runs.
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

  // Joins an existing game by code. It validates the name and the 4 letter
  // code, then checks that the room exists, has not started, and is not full. It
  // removes the player from any old room and inserts them. A 409 from the insert
  // means the name is already taken in that room.
  const handleJoin = async () => {
    const n = validName();

    if (!n) return;

    const code = codeInput.trim().toUpperCase();

    if (!new RegExp(`^[A-Z]{${ROOM_CODE_LENGTH}}$`).test(code)) {
      setError(`game codes are ${ROOM_CODE_LENGTH} letters.`);
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

  // Leaves the current room. It clears the local room state first so the UI
  // returns to the menu immediately, then does the server cleanup (removing the
  // player and handing off or deleting the room) afterward.
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

  // Leaves the room and then returns to the solo screen.
  const handleExit = async () => {
    await handleLeave();
    onExit();
  };

  // Starts the game (host only, with at least 2 players). It generates the shared
  // prompt list and resets players, then re-syncs the clock before choosing the
  // start time, so slow network work does not use up the countdown. The start
  // time is the current shared time plus 3 seconds. For timed and survival it
  // builds the full initial turn state (seating order, lives or time banks, first
  // holder and deadlines). Then it writes status, prompts, mode and start time in
  // one update, which moves every client from the lobby to the countdown. The
  // games-played counter is incremented afterward so it cannot delay the start.
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

      await resetPlayers(room);
      await syncClock(1);

      const startedAtMs = now() + COUNTDOWN_SECONDS * 1000;
      const startedAt = new Date(startedAtMs).toISOString();

      let turnState: TurnState | null = null;

      if (modeChoice === "timed" || modeChoice === "survival") {
        const order = players.map((p) => p.player_id);
        const isSurvivalMode = modeChoice === "survival";
        const initialLimit = isSurvivalMode ? SURVIVAL_TIME : turnTime;
        const firstTurnSeconds = isSurvivalMode
          ? SURVIVAL_SKIP_SECONDS
          : initialLimit;

        turnState = {
          current: order[0],
          origin: order[0],
          prompt: prompts[0],
          promptIndex: 0,
          deadline: new Date(startedAtMs + initialLimit * 1000).toISOString(),
          skipDeadline: new Date(
            startedAtMs + firstTurnSeconds * 1000,
          ).toISOString(),
          turnStartedAt: startedAt,
          limit: initialLimit,
          shorten: shortenTimed,
          maxLives: isSurvivalMode ? 1 : timedLives,
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

      void (async () => {
        for (let i = 0; i < players.length; i++) {
          await countGamePlayed(setGamesPlayed);
        }
        await loadGamesPlayed(setGamesPlayed);
      })();
    } catch (e) {
      console.error("GROUP START ERROR:", e);

      setError("couldn't start the game. try again.");
    } finally {
      setBusy(false);
    }
  };

  // Sends everyone back to the lobby after a game (host only). It sets the game
  // status back to waiting, clears the turn state, and resets every player's
  // progress.
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

  // Handles a word submission in race modes (rush, sixrush, alphabet). It ignores
  // input during the countdown, then validates the word with checkWord against the
  // player's own position in the prompt list. All of this is local: it updates the
  // word index, used words and letters immediately. It then saves progress through
  // the save queue. When the player finishes, progress is saved first and the
  // finish function second, because the server only stamps the finish time if
  // progress has already reached the target.
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();

    if (!game?.started_at || now() < new Date(game.started_at).getTime()) {
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

    const nextIndex = index + 1;

    const nextLetters = new Set(letters);

    for (const char of word.toUpperCase()) {
      nextLetters.add(char);
    }

    const nextProgress = mode === "alphabet" ? nextLetters.size : nextIndex;
    const justFinished = nextProgress >= target;

    setUsed((current) => {
      const updated = new Set(current);
      updated.add(word);
      return updated;
    });

    setIndex(nextIndex);
    setLetters(nextLetters);
    setInput("");
    setMessage(justFinished ? "" : "good word!");

    if (justFinished) {
      queueSave(async () => {
        await saveProgress(target);
        await saveFinished(target);
      });
    } else {
      queueSave(() => saveProgress(nextProgress));
    }
  };

  // Handles a word submission in timed and survival modes. It only works on the
  // player's own turn, after the countdown, and before the skip deadline plus a
  // small grace. The word is checked against the shared used-word list. If it is
  // valid, it builds the next turn state with solveTimedTurn or solveSurvivalTurn
  // and writes it with patchTurn. A successful write is applied locally right
  // away. If the write loses the race to another client, the next poll shows the
  // real state.
  const handleTimedSubmit = (event: FormEvent) => {
    event.preventDefault();

    if (!room || !game || !ts || !myTurn || timedOver) return;

    if (!game.started_at || now() < new Date(game.started_at).getTime()) {
      return;
    }

    if (now() > new Date(ts.skipDeadline).getTime() + TIMEOUT_GRACE_MS) {
      setMessage("too late!");
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
      : solveTimedTurn(ts, word, game.prompts ?? [], present, nameOf);

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

  // Returns a player's progress for the scoreboard. For this player during a
  // race it uses the local value, which is always current, instead of the
  // database value that may lag behind the last save.
  const progressOf = (p: Player) =>
    phase === "race" && p.player_id === me ? myProgress : p.progress;

  // Returns how many seconds a player took to finish, as finished_at minus
  // started_at. It returns null if the game has not started, the player has not
  // finished, or either timestamp is invalid.
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

  // Formats a number of seconds as text with two decimals and an "s" suffix, or
  // a dash when there is no value.
  const formatTime = (seconds: number | null) => {
    if (seconds === null) return "—";

    return `${seconds.toFixed(2)}s`;
  };

  // Renders the race scoreboard. Each player gets a row with their name, a
  // progress bar filled to progress divided by the target, and either a count
  // (such as 7/20) or their finish time once done. During play it lists players in
  // join order and on the results screen it uses the ranked order. The winner gets
  // a crown, and the current player's row gets an extra class to highlight it.
  const renderScoreboard = () => (
    // RACE SCOREBOARD: one row per player. During the race rows are in join
    // order; on the results screen they are sorted by finish time / progress.
    <div className="mp-board">
      {(phase === "results" ? ranked : players).map((p) => {
        const count = Math.min(target, progressOf(p));

        const elapsed = getElapsedSeconds(p);

        const isWinner =
          phase === "results" && winner?.player_id === p.player_id;

        return (
          // One player's row (extra "mp-me" class highlights the local player)
          <div
            key={p.player_id}
            className={p.player_id === me ? "mp-row mp-me" : "mp-row"}
          >
            {/* Left column: the player's display name, with a crown if they won */}
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

            {/* Middle column: progress bar filled to count / target */}
            <div className="mp-bar">
              <i style={{ width: `${(count / target) * 100}%` }} />
            </div>

            {/* Right column: finish time once done (e.g. 31.42s), otherwise the
                running count (e.g. 7/20 words, or 12/26 letters in alphabet) */}
            <span className="mp-count">
              {elapsed !== null ? formatTime(elapsed) : `${count}/${target}`}
            </span>
          </div>
        );
      })}
    </div>
  );

  // Renders the scoreboard for timed and survival. Each row shows the name, a bar
  // for lives left (timed) or time bank left (survival), and hearts or seconds.
  // Eliminated players are dimmed and labelled "out", the player holding the turn
  // gets an arrow, and the winner gets a crown on the results screen. During play
  // it uses seating order; at the end it uses the elimination ranking.
  const renderTimedBoard = () => {
    if (!ts) return null;

    const rows = phase === "results" ? timedRanking : timedSeats;
    const maxLives = Math.max(1, ts.maxLives ?? timedLives);

    return (
      // TIMED / SURVIVAL SCOREBOARD: one row per player showing what they have
      // left (lives in timed, seconds in survival).
      <div className="mp-board">
        {rows.map((p) => {
          const lives = ts.lives[p.player_id] ?? 0;
          const remaining = isSurvival
            ? liveRemainingFor(p.player_id)
            : (ts.remaining[p.player_id] ?? 0);
          const out = isSurvival ? remaining <= 0 : lives <= 0;
          const holdingTurn =
            phase === "race" && !out && ts.current === p.player_id;

          return (
            // One player's row: highlighted if it's me, dimmed to 45% if eliminated
            <div
              key={p.player_id}
              className={p.player_id === me ? "mp-row mp-me" : "mp-row"}
              style={out ? { opacity: 0.45 } : undefined}
            >
              {/* Left column: name, with a crown for the winner (results) or a
                  ▶ arrow for whoever currently holds the turn (during play) */}
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

              {/* Middle column: bar showing time bank left out of 60s (survival)
                  or lives left out of the max (timed) */}
              <div className="mp-bar">
                <i
                  style={{
                    width: `${isSurvival
                      ? Math.max(
                        0,
                        Math.min(100, (remaining / SURVIVAL_TIME) * 100),
                      )
                      : Math.max(0, Math.min(100, (lives / maxLives) * 100))
                      }%`,
                  }}
                />
              </div>

              {/* Right column: "out" if eliminated, otherwise seconds left with
                  one decimal (survival) or a row of hearts (timed) */}
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
      ? `last player standing wins. ${ts?.maxLives ?? timedLives} lives each.`
      : game?.finish_mode === "last"
        ? mode === "alphabet"
          ? "everyone must collect all 26 letters"
          : `everyone must reach ${TARGET_WORDS} words`
        : mode === "alphabet"
          ? "first to collect all 26 letters wins"
          : `first to ${TARGET_WORDS} words wins`;

  return (
    // MULTIPLAYER CARD: a single card whose contents change by `phase`
    // (menu -> lobby -> countdown -> race -> results). Only one phase block below
    // is visible at a time.
    <section className="card mp-screen">
      {/* Global counter: total games played by all users (always visible) */}
      <div className="mp-stats">
        <span>
          total games played by all users{" "}
          <strong>{gamesPlayed.toLocaleString()}</strong>
        </span>
      </div>

      {/* Top navigation row */}
      <div className="mp-top">
        {/* Leaves any room and goes back to the solo game */}
        <button type="button" className="lb-skip" onClick={handleExit}>
          ← back to solo
        </button>

        {/* Only shown while inside a room: leaves the room but stays in
            multiplayer (returns to the menu) */}
        {room && phase !== "menu" && (
          <button type="button" className="lb-skip" onClick={handleLeave}>
            leave game
          </button>
        )}
      </div>

      {/* PHASE: MENU. The first multiplayer screen, shown when you're not in a
          room. You enter a display name, then either create a game or join one
          with a 4 letter code. */}
      {phase === "menu" && (
        <div className="mp-menu">
          {/* Heading and one-line description */}
          <div className="results-header">
            <small>multiplayer</small>

            <h2>wordtimer</h2>

            <p>everyone gets the same letters. pick a mode and race.</p>
          </div>

          <div className="divider" />

          {/* Display name box (letters only, max 15, remembered from last time) */}
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

          {/* "create game" button: makes a new room and makes you the host */}
          <button
            type="button"
            className="play-again"
            onClick={handleCreate}
            disabled={busy}
          >
            create game
          </button>

          <div className="divider" />

          {/* Game code box: type a friend's 4 letter code (auto-uppercased) */}
          <div className="setting">
            <small>game code</small>

            <input
              className="group-input"
              value={codeInput}
              maxLength={ROOM_CODE_LENGTH}
              onChange={(e) =>
                setCodeInput(
                  e.target.value.replace(/[^a-zA-Z]/g, "").toUpperCase(),
                )
              }
              placeholder="ABCD"
              autoComplete="off"
            />
          </div>

          {/* "join game" button: disabled until all 4 code letters are entered */}
          <button
            type="button"
            className="play-again"
            onClick={handleJoin}
            disabled={busy || codeInput.length !== ROOM_CODE_LENGTH}
          >
            join game
          </button>

          {/* Error message (bad name, no such game, game full, name taken, etc.) */}
          {error && <div className="message">{error}</div>}
        </div>
      )}

      {/* PHASE: LOBBY. The waiting room before a game starts. Everyone sees the
          code and player list; only the host sees the game settings. */}
      {phase === "lobby" && room && (
        <div className="mp-lobby">
          {/* The room's 4 letter code in large text, with a copy button */}
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

          {/* Player list: count out of the max (e.g. 3/8), then one row per
              player with "(you)" next to your own name and a "host" tag next to
              the host */}
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

          {/* Host sees the settings and start button; everyone else just sees a
              waiting message */}
          {isHost ? (
            <>
              {/* MODE PICKER (host only): rush, sixrush, alphabet, timed, survival
                  in a 2-column grid, each with a short description */}
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

              {/* MODE-SPECIFIC SETTINGS: timed shows lives / turn time / speed-up,
                  survival has no extra settings, and the race modes show the
                  finish-mode choice */}
              {modeChoice === "timed" ? (
                <>
                  {/* Lives per player (1–5 hearts) */}
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

                  {/* Seconds allowed per turn (5s, 10s, 20s, 60s) */}
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

                  {/* Speed-up toggle: on/off, with the threshold scaled by player
                      count (e.g. "after 60 prompts → 5s" for 3 players) */}
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
                // Survival has no extra settings, so this renders an empty block
                <div className="setting"></div>
              ) : (
                // Race modes only: finish mode
                <div className="setting">
                  <small>finish mode</small>

                  {/* Two choices: end as soon as someone finishes, or wait until
                      everyone has finished */}
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

              {/* DIFFICULTY PICKER (host only): easy (5,000+ words) or hard
                  (500–2,500 words) */}
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
                        hint: "500–2,500 words",
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

              {/* START BUTTON (host only): disabled until 2+ players have joined;
                  the label shows "waiting for players (1/2)" until then */}
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
            // Non-hosts only see this waiting message
            <p className="rule">waiting for the host to start the game...</p>
          )}

          {/* Error or connection-problem message */}
          {(error || syncError) && (
            <div className="message">{error || syncError}</div>
          )}
        </div>
      )}

      {/* PHASE: COUNTDOWN. The 3-2-1 screen shown to everyone before a game
          begins. */}
      {phase === "countdown" && (
        <div className="mp-countdown-screen">
          {/* "get ready · <mode name>" label */}
          <small>
            get ready ·{" "}
            {MODE_OPTIONS.find((o) => o.value === mode)?.label ?? mode}
          </small>

          {/* Big countdown number (3, 2, 1) */}
          <div className="mp-countdown">{countdown}</div>

          {/* One-line goal for the chosen mode (e.g. "first to 20 words wins") */}
          <p className="rule">{goalText}</p>
        </div>
      )}

      {/* PHASE: RACE (rush / sixrush / alphabet). Everyone types at their own
          pace through the same list of letters; the scoreboard shows everyone's
          progress live. */}
      {phase === "race" && !isTimed && (
        <div className="mp-race">
          {/* Shared race stopwatch (seconds since the start, two decimals) */}
          <div className="timer">{raceTime.toFixed(2)}s</div>

          {iFinished ? (
            // Shown once YOU have finished: a "you finished!" banner with your
            // final count, and a status line explaining what happens next
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
              {/* PROMPT: progress label ("WORD 3 OF 20" or "LETTERS 5 OF 26"),
                  the big letter fragment to use, and an instruction line
                  (mentions 6+ letters in sixrush) */}
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

              {/* ANSWER FORM: text box (letters only, auto-lowercased), enter
                  button, and a feedback line ("good word!" or an error) */}
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

          {/* Alphabet mode only: A–Z grid where your collected letters are
              highlighted */}
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

          {/* Live scoreboard: every player's progress bar and count */}
          {renderScoreboard()}

          {/* Connection problem warning (only shows if polling fails) */}
          {syncError && <div className="message">{syncError}</div>}
        </div>
      )}

      {/* PHASE: RACE (timed / survival). Turn-based "hot potato": one player at a
          time holds the fragment and must answer before their clock runs out. */}
      {phase === "race" && isTimed && ts && (
        <div className="mp-race">
          {/* Main clock: the current turn's countdown (timed) or the current
              player's remaining time bank (survival), with one decimal */}
          <div className="timer">{turnLeft.toFixed(1)}s</div>

          {/* Survival only: countdown to the automatic 15-second turn skip */}
          {isSurvival && (
            <div className="mp-survival-top">
              <strong>turn skips in {Math.ceil(skipLeft)}s</strong>
            </div>
          )}

          {/* Last word box: who typed the most recent word and what it was, or a
              placeholder before the first word */}
          <div className="mp-last">
            {ts.lastWord ? (
              <>
                <small>{nameOf(ts.lastWordBy)} typed</small>
                <strong>{ts.lastWord}</strong>
              </>
            ) : (
              <small>no words typed yet</small>
            )}
          </div>

          {/* PROMPT: the label says whose turn it is ("YOUR TURN", "<NAME>'S
              TURN", or "YOU'RE OUT. WATCHING" if you're eliminated), then the big
              fragment, then a hint line */}
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

          {/* ANSWER FORM: only appears on YOUR turn. The key resets the input box
              each turn so it starts empty and refocused. */}
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

              {/* Feedback line for your own answers (errors, "too late!") */}
              <div className="message">{message}</div>
            </form>
          )}

          {/* Event note visible to everyone (e.g. "Sam ran out of time", "Sam is
              out!", "Sam was skipped after 15 seconds") */}
          {ts.note && <div className="message">{ts.note}</div>}

          <div className="divider" />

          {/* Scoreboard: each player's lives (timed) or time bank (survival) */}
          {renderTimedBoard()}

          {/* Timed only (not survival): your personal A–Z bonus tracker */}
          {!isSurvival && (
            <>
              <div className="divider" />

              {/* Heading with your collected-letter count (e.g. 9/26) */}
              <div className="section-heading">
                <div>
                  <small>alphabet bonus</small>
                  <h2>get a life</h2>
                </div>
                <strong>{(ts.letters[me] ?? []).length}/26</strong>
              </div>

              {/* A–Z grid with your collected letters highlighted */}
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

              {/* Explanation of the extra-life rule */}
              <p className="rule">
                collect all 26 letters from your words to gain an extra life.
              </p>
            </>
          )}

          {/* Connection problem warning (only shows if polling fails) */}
          {syncError && <div className="message">{syncError}</div>}
        </div>
      )}

      {/* PHASE: RESULTS (a winner exists). Shows who won and the final standings. */}
      {phase === "results" && winner && (
        <div className="mp-results">
          {/* Headline: "you won!" if it's you, otherwise "game over"; then the
              winner's name with a crown, and a line explaining how they won */}
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

          {/* Timed / survival only: summary stats (total words typed by everyone
              and how long the game lasted) */}
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

          {/* Final standings: elimination order for timed/survival, or finish
              order with times for the race modes */}
          {isTimed ? renderTimedBoard() : renderScoreboard()}

          <div className="divider" />

          {/* Host gets a "play again" button that sends everyone back to the
              lobby; everyone else sees a waiting message */}
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

          {/* Error message (e.g. couldn't go back to the lobby) */}
          {error && <div className="message">{error}</div>}
        </div>
      )}

      {/* PHASE: RESULTS (no winner). Fallback screen, e.g. when everyone left or
          nobody was left standing. The host still gets a way back to the lobby. */}
      {phase === "results" && !winner && (
        <div className="mp-results">
          <div className="results-header">
            <small>game over</small>
            <h2>no winner</h2>
          </div>

          {/* Host-only button to return to the lobby */}
          {isHost && (
            <button
              type="button"
              className="play-again"
              onClick={handleBackToLobby}
              disabled={busy}
            >
              back to lobby
            </button>
          )}
        </div>
      )}
    </section>
  );
}