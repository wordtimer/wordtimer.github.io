import type { Dispatch, FormEvent, SetStateAction } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

/* ==========================================================================
 * CONFIG / CONSTANTS
 * ========================================================================== */

const SUPABASE_URL = "https://frnjbjhigceptzwtmyax.supabase.co";
const SUPABASE_KEY = "sb_publishable_mB2ZU7RWDpQdPA-mIh8tKw_oxs1_2_B";

const PLAYERS_URL = `${SUPABASE_URL}/rest/v1/group_players`;
const GAMES_URL = `${SUPABASE_URL}/rest/v1/group_games`;

// Games-played counter. Both are Supabase RPC functions called with POST.
const COUNTER_GET_URL =
  "https://frnjbjhigceptzwtmyax.supabase.co/rest/v1/rpc/get_games_played"; // read only
const COUNTER_HIT_URL =
  "https://frnjbjhigceptzwtmyax.supabase.co/rest/v1/rpc/count_games_played"; // adds p_amount

const PLAYER_ID_KEY = "wordtimer_group_player_id";
const NAME_KEY = "wordtimer_group_name";

export const TARGET_WORDS = 20; // words needed to finish rush / sixrush / startEnd / math
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const ALPHABET_TARGET = ALPHABET.length; // 26 letters to finish alphabet
const ROOM_CODE_LENGTH = 4;
const TIMED_LIVES_DEFAULT = 3;
const TIMED_LIFE_OPTIONS = [1, 2, 3, 4, 5];
const TURN_TIME_OPTIONS = [5, 10, 20, 60];
const SURVIVAL_TIME = 60;
const SURVIVAL_SKIP_SECONDS = 15;
const TIMED_SHORT_TIME_DEFAULT = 5;
const TIMED_SHORT_AFTER_WORDS_PER_PLAYER = 20;
const PROMPT_POOL_SIZE = 60; // fragments generated for alphabet / timed (they wrap)
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 16;
const MAX_NAME_LENGTH = 15;
const POLL_MS = 1000;
const TIMED_POLL_MS = 500; // poll faster during timed so the potato moves quickly
const COUNTDOWN_SECONDS = 3;
const TIMEOUT_GRACE_MS = 300; // host waits a hair past the deadline before failing a turn
const BACKUP_GRACE_MS = 2000; // non-host clients step in if the host is stalled

/* ==========================================================================
 * SHARED CLOCK
 * Every device estimates (serverTime - localTime) and uses now() instead of
 * Date.now(), so deadlines written by one device mean the same thing on all.
 * Requires the server_now() SQL function (see notes).
 * ========================================================================== */

let clockOffset = 0; // serverNow - localNow, in ms
let bestSample = { rtt: Infinity, at: 0 };

// now(): takes nothing, returns the current time in milliseconds on the shared
// clock. It is the device's Date.now() plus clockOffset, the measured gap to
// the server. Every deadline in the game is computed from this, never from
// Date.now() directly, so a player with a wrong device clock still agrees with
// everyone else about when a turn ends.
const now = () => Date.now() + clockOffset;

// nowIso(): takes nothing, returns now() as an ISO timestamp string. This is
// the format the database stores in columns such as updated_at and endedAt.
const nowIso = () => new Date(now()).toISOString();

// syncClock(samples = 1): takes how many measurements to make, returns a
// Promise that resolves to nothing. For each sample it records the local time
// (t0), calls the server_now RPC, records the local time again (t1), and reads
// the server's time. It assumes the server read its clock halfway through the
// round trip, so the offset is server - (t0 + t1) / 2. It keeps the sample with
// the smallest round-trip time (the most accurate one) and replaces it once it
// is more than two minutes old. A failed request is skipped, so the game falls
// back to the local clock if the server can't be reached.
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

      // keep the lowest-latency sample, but let old samples expire
      if (rtt <= bestSample.rtt || t1 - bestSample.at > 120_000) {
        bestSample = { rtt, at: t1 };
        clockOffset = server - (t0 + t1) / 2;
      }
    } catch {
      // falls back to the local clock
    }
  }
}

/* ==========================================================================
 * TYPES
 * ========================================================================== */

export type GroupDifficulty = "superEasy" | "hard";

// rush / sixrush / alphabet / startEnd / math are races. timed is hot potato.
// survival is shared-clock elimination. startEnd matches the first and last
// letters of a word; math answers arithmetic questions with whole numbers.
export type GroupMode =
  | "rush"
  | "sixrush"
  | "alphabet"
  | "timed"
  | "survival"
  | "startEnd"
  | "math";

// PromptItem.fragment meaning depends on the mode:
//   word modes: the letters to include ("ing")
//   startEnd:   "start-end" ("b-a")
//   math modes: the problem text ("7 × 8"), and examples[0] is the answer ("56")
export type PromptItem = {
  fragment: string;
  examples: string[];
};

// Everything about the current hot-potato turn lives in ONE json value so it
// can be swapped atomically (compare-and-set on game.turn_number).
// Host settings (limit / shorten / maxLives) live here so every client
// computes the next turn from the same rules.
type TurnState = {
  current: string; // player_id whose turn it is
  origin: string; // player who first received this fragment
  prompt: PromptItem; // fragment being passed around
  promptIndex: number; // index into game.prompts (wraps)
  deadline: string;
  skipDeadline: string; // the real end of the current turn
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
  progress: number; // race modes: words/problems. alphabet: letters collected.
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
  {
    value: "startEnd",
    label: "startend",
    hint: `${TARGET_WORDS} words, given start + end`,
  },
  {
    value: "math",
    label: "math",
    hint: `${TARGET_WORDS} arithmetic problems`,
  },
];

// Difficulty hints for startEnd (the fragment pools are sized differently from
// the normal word modes).
const START_END_HINTS: Record<GroupDifficulty, string> = {
  superEasy: "50–500 matching words",
  hard: "500+ matching words",
};

/* ==========================================================================
 * GAME RULE HELPERS (pure)
 * ========================================================================== */

// Math is a race mode whose answer is a whole number.
const isMathMode = (mode: GroupMode): mode is "math" => mode === "math";

// targetOf(mode): takes a GroupMode, returns the progress a player needs to
// finish a race: 26 for alphabet (letters), 20 for everything else (words or
// problems).
// How much "progress" a player needs to finish a race mode.
const targetOf = (mode: GroupMode) =>
  mode === "alphabet" ? ALPHABET_TARGET : TARGET_WORDS;

// promptCountFor(mode): takes a GroupMode, returns how many prompts to
// generate. Rush, sixrush, startEnd and the math modes need exactly 20.
// Alphabet, timed and survival have no fixed length, so they get a pool of 60
// that wraps back to the start (via modulo) if it ever runs out.
// How many fragments to generate. Alphabet, timed, and survival have no fixed length,
// so they get a pool that wraps around if it ever runs out.
const promptCountFor = (mode: GroupMode) =>
  mode === "alphabet" || mode === "timed" || mode === "survival"
    ? PROMPT_POOL_SIZE
    : TARGET_WORDS;

// displayPrompt(fragment, mode): takes a prompt fragment and the mode, returns
// the text to show in big letters. startEnd fragments ("b-a") become "B … A";
// math problems and normal fragments are just uppercased.
function displayPrompt(fragment: string, mode: GroupMode) {
  if (mode === "startEnd") {
    const [start, end] = fragment.split("-");

    return `${start.toUpperCase()} … ${(end ?? "").toUpperCase()}`;
  }

  return fragment.toUpperCase();
}

// checkWord(word, fragment, mode, isValidWord, used): takes the typed word
// (already trimmed and lowercased), the required fragment, the mode, a
// dictionary-check function, and anything with a has() method (a Set of used
// words). Returns an error message string for the first rule broken, or null
// if the word is fine. Checks in order: minimum length (6 for sixrush,
// otherwise fragment length + 1), letters only, contains the fragment, exists
// in the dictionary, not already used.
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

// checkStartEnd(word, fragment, isValidWord, used): takes the typed word, a
// one-letter "start-end" fragment, the dictionary check and the used-words set.
// Answers must be at least 3 letters long, start and end with the given letters,
// exist in the dictionary, and not have been used already.
function checkStartEnd(
  word: string,
  fragment: string,
  isValidWord: (w: string) => boolean,
  used: { has: (w: string) => boolean },
): string | null {
  const [start, end = ""] = fragment.split("-");
  const minLength = Math.max(start.length + end.length + 1, 3);

  if (!/^[a-z]+$/.test(word)) return "use letters only.";

  if (word.length < minLength) {
    return "your word must be at least 3 letters long.";
  }

  if (!word.startsWith(start)) {
    return `your word must start with "${start.toUpperCase()}".`;
  }

  if (!word.endsWith(end)) {
    return `your word must end with "${end.toUpperCase()}".`;
  }

  if (!isValidWord(word)) return "that word isn't in the dictionary.";

  if (used.has(word)) return "you already used that word.";

  return null;
}

// checkMath(answer, prompt): takes the typed answer and the PromptItem whose
// examples[0] is the correct answer. Returns an error message, or null if the
// answer is right. Only whole numbers are accepted.
function checkMath(answer: string, prompt: PromptItem): string | null {
  if (!/^\d+$/.test(answer)) return "enter a whole number.";

  if (Number(answer) !== Number(prompt.examples[0])) {
    return "not quite, try again.";
  }

  return null;
}

// Generate math prompts for multiplayer with the same difficulty rules as solo.
// Easy answers can be 0–99; hard keeps the former mathMed ranges.
function randomMathInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function makeMathPrompt(
  difficulty: GroupDifficulty,
  usedExpressions: Set<string> = new Set(),
): PromptItem {
  const applyOperation = (a: number, b: number, operation: number) => {
    if (operation === 0) return { value: a + b, symbol: "+" };
    if (operation === 1) return { value: a - b, symbol: "−" };
    return { value: a * b, symbol: "×" };
  };

  for (let attempt = 0; attempt < 2000; attempt++) {
    let answer = 0;
    let expression = "";
    const operation = randomMathInt(0, 3);
    const useTwoSteps = Math.random() < 0.5;

    if (useTwoSteps && operation !== 3) {
      const min = difficulty === "superEasy" ? 1 : 12;
      const max = difficulty === "superEasy" ? 20 : 45;
      const a = randomMathInt(min, max);
      const b = randomMathInt(min, max);
      const c = randomMathInt(min, max);
      const firstOp = randomMathInt(0, 2);
      const secondOp = randomMathInt(0, 2);
      const first = applyOperation(a, b, firstOp);
      const second = applyOperation(first.value, c, secondOp);
      answer = second.value;
      const limit = difficulty === "superEasy" ? 99 : 500;
      if (
        answer < 0 ||
        answer > limit ||
        first.value < 0 ||
        first.value > limit
      )
        continue;
      expression = `(${a} ${first.symbol} ${b}) ${second.symbol} ${c}`;
    } else if (difficulty === "superEasy") {
      if (operation === 0) {
        const a = randomMathInt(10, 89);
        const b = randomMathInt(1, 99 - a);
        answer = a + b;
        expression = `${a} + ${b}`;
      } else if (operation === 1) {
        const a = randomMathInt(10, 99);
        const b = randomMathInt(1, a - 1);
        answer = a - b;
        expression = `${a} − ${b}`;
      } else if (operation === 2) {
        const a = randomMathInt(2, 12);
        const b = randomMathInt(2, Math.min(12, Math.floor(99 / a)));
        answer = a * b;
        expression = `${a} × ${b}`;
      } else {
        const a = randomMathInt(2, 9);
        const b = randomMathInt(2, 6);
        answer = a ** b;
        if (answer > 99) continue;
        expression = `${a}^${b}`;
      }
    } else if (operation === 0) {
      const a = randomMathInt(25, 199);
      const b = randomMathInt(15, 199);
      answer = a + b;
      if (answer > 500) continue;
      expression = `${a} + ${b}`;
    } else if (operation === 1) {
      const a = randomMathInt(30, 250);
      const b = randomMathInt(10, a - 1);
      answer = a - b;
      expression = `${a} − ${b}`;
    } else if (operation === 2) {
      const a = randomMathInt(12, 25);
      const b = randomMathInt(3, 18);
      answer = a * b;
      if (answer > 500) continue;
      expression = `${a} × ${b}`;
    } else {
      const a = randomMathInt(3, 15);
      const b = randomMathInt(2, 5);
      answer = a ** b;
      if (answer > 500) continue;
      expression = `${a}^${b}`;
    }

    if (usedExpressions.has(expression)) continue;
    return { fragment: expression, examples: [String(answer)] };
  }

  for (let a = 1; a <= 9; a++) {
    for (let b = 1; b <= 9; b++) {
      const expression = `${a} + ${b}`;
      const answer = a + b;
      if (
        answer <= (difficulty === "superEasy" ? 99 : 500) &&
        !usedExpressions.has(expression)
      ) {
        return { fragment: expression, examples: [String(answer)] };
      }
    }
  }
  return { fragment: "1 + 1", examples: ["2"] };
}

function makeMathPrompts(
  count: number,
  difficulty: GroupDifficulty,
): PromptItem[] {
  const usedExpressions = new Set<string>();
  const prompts: PromptItem[] = [];
  while (prompts.length < count) {
    const prompt = makeMathPrompt(difficulty, usedExpressions);
    usedExpressions.add(prompt.fragment);
    prompts.push(prompt);
  }
  return prompts;
}

// checkAnswer(word, prompt, mode, isValidWord, used): the single entry point
// for race-mode answers. Sends math modes to checkMath, startEnd to
// checkStartEnd and everything else to checkWord. Returns an error message or
// null.
function checkAnswer(
  word: string,
  prompt: PromptItem,
  mode: GroupMode,
  isValidWord: (w: string) => boolean,
  used: { has: (w: string) => boolean },
): string | null {
  if (isMathMode(mode)) return checkMath(word, prompt);

  if (mode === "startEnd") {
    return checkStartEnd(word, prompt.fragment, isValidWord, used);
  }

  return checkWord(word, prompt.fragment, mode, isValidWord, used);
}

/* ---- hot potato transitions ---------------------------------------------- */

// addLetters(word, current): takes a word and a player's collected-letter
// array, returns a new array with every A-Z letter of the word added and no
// duplicates. It puts the old letters in a Set, adds each uppercase character
// that is in ALPHABET, and spreads the Set back into an array.
const addLetters = (word: string, current: string[]) => {
  const next = new Set(current);
  for (const char of word.toUpperCase()) {
    if (ALPHABET.includes(char)) next.add(char);
  }
  return [...next];
};

// timedLimitFor(ts): takes a TurnState, returns the seconds allowed for the
// next timed turn. It returns the short time (5s) once ts.shorten is on and
// totalWords has reached (players x 20); otherwise it returns ts.limit. It
// reads only the rules saved in the turn state, so every client computes the
// same value regardless of who is solving.
// Per-turn limit for timed mode, from the rules stored in the turn state
// (NOT from whichever client happens to be solving).
const timedLimitFor = (ts: TurnState) =>
  ts.shorten &&
  ts.totalWords >= ts.order.length * TIMED_SHORT_AFTER_WORDS_PER_PLAYER
    ? TIMED_SHORT_TIME_DEFAULT
    : ts.limit;

// turnElapsed(ts): takes a TurnState, returns the seconds the current player
// has used on this turn. It is (now() - turnStartedAt) / 1000, never below 0
// and capped at 15 (the survival skip time). Used to charge a survival player's
// time bank.
// Seconds the current player has used on this turn (capped at the skip time).
const turnElapsed = (ts: TurnState) =>
  Math.min(
    SURVIVAL_SKIP_SECONDS,
    Math.max(0, (now() - new Date(ts.turnStartedAt).getTime()) / 1000),
  );

// aliveIds(ts, present): takes a TurnState and a Set of player ids still in
// the room, returns a Set of ids still in the game. A player is alive if they
// are in `present` and have lives left (timed) or time left in their bank
// (survival, when ts.survival is true).
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

// firstAliveFrom(order, alive, startIdx): takes the seating order array, the
// Set of alive ids, and a starting index. Walks the order from startIdx,
// wrapping past the end with modulo, and returns the first id that is alive,
// or null if nobody is. Used to find who gets the next turn.
function firstAliveFrom(order: string[], alive: Set<string>, startIdx: number) {
  for (let step = 0; step < order.length; step++) {
    const id = order[(startIdx + step) % order.length];
    if (alive.has(id)) return id;
  }
  return null;
}

// withNewFragment(ts, prompts, holder, note, mode, limit): takes the current
// TurnState, the prompt list, the id of the player getting the next turn, a
// note to display, the mode, and the per-turn limit. Returns a new TurnState
// for the next turn. It advances promptIndex, picks prompts[promptIndex %
// length], makes `holder` the current and origin player, and takes ONE
// timestamp for the whole turn. It then sets two deadlines: skipDeadline (when
// the turn ends) and deadline (when the holder's main clock ends). In survival
// the skip is min(15, holder's bank) and the deadline is the whole bank; in
// timed both equal `limit`. It also sets turnStartedAt and note.
function withNewFragment(
  ts: TurnState,
  prompts: PromptItem[],
  holder: string,
  note: string,
  mode: GroupMode,
  limit: number,
): TurnState {
  const promptIndex = ts.promptIndex + 1;
  const t = now(); // ONE timestamp for the whole turn
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

// recordAcceptedWord(ts, word, playerId, nameOf): takes the TurnState, the
// accepted word, the id of the player who typed it, and an id-to-name function.
// Returns a new TurnState with the word appended to `used`, totalWords + 1,
// lastWord and lastWordBy set, and that player's letters merged with the
// word's letters. It does NOT change whose turn it is. `nameOf` is accepted but
// not used in the current code, and the local variables `before`, `after`,
// `lives` and `note` are leftovers: `lives` is an unchanged copy of ts.lives
// and `note` is always an empty string, so the returned note is "".
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

// solveTimedTurn(ts, word, prompts, present, nameOf): takes the TurnState, a
// word the current player just got right, the prompt list, a Set of present
// player ids, and an id-to-name function. Returns the next TurnState for timed
// mode: records the word, finds the next alive player after the current seat,
// and calls withNewFragment for them with the timed limit. The note defaults to
// "<name> typed <word>". It is a pure function: the client that answered runs
// it, and patchTurn decides whether the write takes effect.
function solveTimedTurn(
  ts: TurnState,
  word: string,
  prompts: PromptItem[],
  present: Set<string>,
  nameOf: (id: string) => string,
): TurnState {
  const base = recordAcceptedWord(ts, word, ts.current, nameOf);
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

// failTimedTurn(ts, prompts, present, nameOf): takes the TurnState, the prompt
// list, the present-player Set, and an id-to-name function. Returns the next
// TurnState after the current player runs out of time in timed mode. They lose
// one life (all of them if they left the room) and are added to `eliminated`
// at 0. If one or no players remain it sets endedAt and returns without a new
// turn. Otherwise it writes a note ("left", "is out!" or "ran out of time") and
// passes the turn to the next alive player with a new fragment.
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

// solveSurvivalTurn(ts, word, prompts, present, nameOf): same arguments as
// solveTimedTurn. Returns the next TurnState after a correct answer in
// survival. It subtracts turnElapsed from the player's time bank and
// eliminates them if the bank hits 0, then records the word. If one or no
// players are left it sets endedAt and stops. Otherwise the next alive player
// gets a new fragment with a 15 second window.
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
    nameOf,
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

// failSurvivalTurn(ts, prompts, present, nameOf): takes the TurnState, the
// prompt list, the present-player Set, and an id-to-name function. Returns the
// next TurnState when a survival turn hits the 15 second skip. The player is
// charged the time used (their whole bank if they left the room) and is
// eliminated if the bank reaches 0. If one or no players remain it sets endedAt
// and stops. Otherwise it writes a note ("left", "is out!" or "was skipped
// after 15 seconds") and passes the turn on.
function failSurvivalTurn(
  ts: TurnState,
  prompts: PromptItem[],
  present: Set<string>,
  nameOf: (id: string) => string,
): TurnState {
  const current = ts.current;
  const gone = !present.has(current);

  // A player who left loses their whole bank, otherwise they'd stay "alive"
  // in the UI and the turn would be re-failed forever.
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

/* ==========================================================================
 * API HELPERS
 * ========================================================================== */

// ApiError: an Error subclass for failed HTTP calls. The constructor takes the
// status code and response body, builds the message "request failed (status):
// body", and stores the status so callers can react to specific codes, such as
// 409 for a duplicate room code or player name.
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

// request<T>(url, init?): takes a URL and optional fetch options, returns a
// Promise of the parsed JSON body typed as T (or null for an empty body). It is
// the wrapper for every database call. It adds the Supabase auth headers and a
// JSON content type (the caller's own headers override them), throws an
// ApiError with the status and body text if the response is not OK, and parses
// the text with JSON.parse.
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

// callCounter(url, body): takes an RPC URL and a JSON body object, returns a
// Promise of the counter total as a number, or null if anything went wrong.
// POSTs the body with the Supabase auth headers. If the response is not OK it
// returns null; otherwise it reads the JSON (a bare number), converts it with
// Number(), and returns it only if it is finite.
async function callCounter(url: string, body: object): Promise<number | null> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) return null;

  const value = Number(await response.json());

  return Number.isFinite(value) ? value : null;
}

// loadGamesPlayed(setGamesPlayed): takes the state setter for the games-played
// number, returns a Promise that resolves to nothing. Calls the
// get_games_played RPC with an empty body and stores the total if a number came
// back. Errors are ignored because the counter is cosmetic.
async function loadGamesPlayed(
  setGamesPlayed: Dispatch<SetStateAction<number>>,
) {
  try {
    const value = await callCounter(COUNTER_GET_URL, {});

    if (value !== null) setGamesPlayed(value);
  } catch {
    // counter is cosmetic, ignore failures
  }
}

// countGamePlayed(setGamesPlayed, amount = 1): takes the same setter and how
// many games to add (default 1), returns a Promise that resolves to nothing.
// Calls the count_games_played RPC with { p_amount: amount }, which adds that
// number on the server and returns the new total, and stores the total if a
// number came back. Errors are ignored.
async function countGamePlayed(
  setGamesPlayed: Dispatch<SetStateAction<number>>,
  amount = 1,
) {
  try {
    const value = await callCounter(COUNTER_HIT_URL, { p_amount: amount });

    if (value !== null) setGamesPlayed(value);
  } catch {
    // counter is cosmetic, ignore failures
  }
}

// getPlayerId(): takes nothing, returns this browser's permanent player id
// (a string). Reads a UUID from localStorage under PLAYER_ID_KEY; if none
// exists it creates one with crypto.randomUUID() and saves it, so a player
// keeps the same identity across page reloads.
function getPlayerId() {
  let id = localStorage.getItem(PLAYER_ID_KEY);

  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(PLAYER_ID_KEY, id);
  }

  return id;
}

// makeRoomCode(): takes nothing, returns a random 4-letter room code. Draws 4
// secure random bytes and maps each onto an alphabet that leaves out I and O.
// 4 letters, no I or O so they can't be confused with 1 or 0.
function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ";

  return Array.from(crypto.getRandomValues(new Uint8Array(ROOM_CODE_LENGTH)))
    .map((v) => chars[v % chars.length])
    .join("");
}

// fetchGame(room): takes a room code, returns a Promise of the Game row or
// null if no such room exists. Selects only the columns the app uses.
async function fetchGame(room: string) {
  const rows = await request<Game[]>(
    `${GAMES_URL}?room_code=eq.${enc(
      room,
    )}&select=room_code,status,host_id,prompts,game_number,finish_mode,started_at,game_mode,turn_number,turn_state&limit=1`,
  );

  return rows[0] ?? null;
}

// fetchPlayers(room): takes a room code, returns a Promise of every Player in
// that room, ordered by joined_at ascending (the longest-present player first).
function fetchPlayers(room: string) {
  return request<Player[]>(
    `${PLAYERS_URL}?room_code=eq.${enc(
      room,
    )}&select=player_id,room_code,display_name,joined_at,progress,finished_at&order=joined_at.asc`,
  );
}

// removeMe(): takes nothing, returns a Promise. Sends a DELETE for this
// browser's player row, removing the player from whatever room they were in.
function removeMe() {
  return request<null>(`${PLAYERS_URL}?player_id=eq.${enc(getPlayerId())}`, {
    method: "DELETE",
  });
}

// resetPlayers(room): takes a room code, returns a Promise. Sends a PATCH to
// every player in the room setting progress to 0 and finished_at to null, ready
// for a new round.
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

// patchGame(room, body): takes a room code and an object of fields to change,
// returns a Promise. Sends a PATCH to the room's game row with those fields
// plus updated_at set from the shared clock.
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

// patchTurn(room, expectedTurn, next): takes a room code, the turn_number this
// client last saw, and the new TurnState. Returns a Promise of the updated row
// ({turn_state, turn_number}) or null. This is the compare-and-set write: the
// URL filter turn_number=eq.expectedTurn makes the update apply only if nobody
// else advanced the turn first. It writes turn_state and turn_number + 1 and
// asks for the row back. A row means this client won; null means another
// client got there first and the next poll will show their state.
// Compare-and-set for hot potato. The `turn_number=eq.N` filter means the
// update only applies if nobody else advanced the turn first (e.g. the solver
// and a timeout firing at the same moment). Returns the new row, or
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
        updated_at: nowIso(),
      }),
    },
  );

  return rows?.[0] ?? null;
}

// saveProgress(progress): takes a number (words answered, or letters collected
// in alphabet mode), returns a Promise. PATCHes this player's progress so
// everyone else's progress bar updates.
function saveProgress(progress: number) {
  return request<null>(`${PLAYERS_URL}?player_id=eq.${enc(getPlayerId())}`, {
    method: "PATCH",
    headers: MINIMAL,
    body: JSON.stringify({
      progress,
    }),
  });
}

// saveFinished(target): takes the finish target (20 or 26), returns a Promise.
// Calls the finish_group_player RPC with this player's id and the target. The
// server stamps finished_at with its own clock, but only if the saved progress
// has already reached the target, so a device clock can't skew finish times.
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

// leaveRoom(room, hostId): takes a room code and the current host's id (or
// undefined), returns a Promise. Removes this player. If they were the host it
// fetches the remaining players and hands host to the longest-present one, or
// deletes the room if nobody is left. Non-hosts stop after removing themselves.
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

// GroupGame({ onExit, makePrompts, isValidWord }): the multiplayer screen.
// Takes three props from the parent: onExit (return to solo), makePrompts
// (builds the shared prompt list) and isValidWord (dictionary check). It
// returns JSX. The database is the source of truth: the component polls the
// room and player rows and derives one `phase` (menu, lobby, countdown, race
// or results) that decides what is drawn. Race modes are tracked locally per
// player and synced as progress; timed and survival share one TurnState that
// is swapped with compare-and-set writes.
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
  const firedTurn = useRef(""); // which turn I already tried to time out
  const jitter = useRef(Math.random() * 800); // spreads out backup timeouts

  const isHost = !!game && game.host_id === me;

  const mode: GroupMode = game?.game_mode ?? "rush";
  const isTimed = mode === "timed" || mode === "survival";
  const isSurvival = mode === "survival";
  const isMath = isMathMode(mode);
  const target = targetOf(mode);
  const ts = game?.turn_state ?? null;

  // unitName: what a player is answering in race modes ("words" or "problems"),
  // used in the goal and results text.
  const unitName = isMath ? "problems" : "words";

  // inputFilter: characters allowed in the answer box. Math modes take digits
  // only; every other mode takes letters only.
  const inputFilter = isMath ? /[^0-9]/g : /[^a-zA-Z]/g;

  // queueSave(fn): takes a function that returns a Promise, returns nothing.
  // Chains fn onto saveChain so progress saves run strictly one after another;
  // an older save can never land after a newer one. A failed save is logged
  // and does not block later saves.
  const queueSave = (fn: () => Promise<unknown>) => {
    saveChain.current = saveChain.current
      .catch(() => {})
      .then(fn)
      .catch((e) => console.error("SAVE ERROR:", e));
  };

  /* ------------------------------------------------------------------------
   * EFFECTS
   * ---------------------------------------------------------------------- */

  // Effect 1, clock sync. Runs once on mount (empty dependency list). Takes 5
  // clock samples straight away, then 1 more every 60 seconds, and 2 more
  // whenever the tab becomes visible again, because background tabs can drift
  // or be throttled. Cleanup clears the interval and removes the
  // visibilitychange listener.
  // Keep the shared clock fresh: on mount, every minute, and when the tab
  // comes back to the foreground.
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

  // Effect 2, games-played counter. Runs once on mount. Loads the global total
  // immediately, then reloads it every 5 seconds so the header number keeps
  // up. Cleanup clears the interval.
  useEffect(() => {
    loadGamesPlayed(setGamesPlayed);

    const id = window.setInterval(() => {
      loadGamesPlayed(setGamesPlayed);
    }, 5000);

    return () => window.clearInterval(id);
  }, []);

  // Poll the room + players. Faster while a timed/survival game is running.
  const pollMs =
    isTimed && game?.status === "playing" ? TIMED_POLL_MS : POLL_MS;

  // Effect 3, polling. Re-runs when `room` or `pollMs` changes; does nothing if
  // you are not in a room. Defines tick(), which fetches the game row and the
  // player list together. If the game row is gone it returns you to the menu
  // with "that game was closed."; otherwise it updates `game` (keeping the
  // current value when the fetched row has an older turn_number in the same
  // round, so a slow poll can't undo a turn this client just wrote) and
  // `players`, and clears syncError. A failed fetch sets "connection problem,
  // retrying...". Runs tick() once immediately, then every pollMs. Cleanup sets
  // a `cancelled` flag so late responses are dropped and clears the interval.
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

        // Ignore a stale poll that started before one of our own turn writes.
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

  // Effect 4, leave on page close. Re-runs when `room` or `me` changes; does
  // nothing if you are not in a room. Adds a pagehide listener that sends a
  // DELETE for your player row with keepalive: true, so the browser finishes
  // the request even while the page is unloading. Cleanup removes the listener.
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

  // Effect 5, new-round reset. Re-runs when game.game_number changes. If the
  // number differs from the last one seen (seenGameNumber), it stores the new
  // number and resets your local race state: word index, input, message, used
  // words and collected letters. No cleanup.
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

  // Effect 6, clear input on a new turn. Re-runs when game.turn_number changes.
  // Clears the text box and message so a half-typed word doesn't carry over to
  // the next turn. No cleanup.
  // Timed: clear the box whenever the potato moves.
  useEffect(() => {
    setInput("");
    setMessage("");
  }, [game?.turn_number]);

  // Effect 7, pre-game countdown. Re-runs when game.status or game.started_at
  // changes. If the game isn't playing or has no start time it sets countdown
  // to 0 and stops. Otherwise, every 100 ms it sets countdown to the whole
  // seconds left until started_at on the shared clock (never below 0; an
  // invalid timestamp gives 0). Cleanup clears the interval.
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

      const remaining = Math.max(0, start - now());

      setCountdown(Math.ceil(remaining / 1000));
    };

    updateCountdown();

    const id = window.setInterval(updateCountdown, 100);

    return () => window.clearInterval(id);
  }, [game?.status, game?.started_at]);

  // Effect 8, race stopwatch. Re-runs when game.status or game.started_at
  // changes. If the game isn't playing or has no start time it sets raceTime to
  // 0 and stops. Otherwise, every 50 ms it sets raceTime to the seconds since
  // started_at on the shared clock (0 during the countdown), so every player
  // sees the same time. Cleanup clears the interval.
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

      const elapsed = Math.max(0, now() - start);

      setRaceTime(elapsed / 1000);
    };

    updateTime();

    const id = window.setInterval(updateTime, 50);

    return () => window.clearInterval(id);
  }, [game?.status, game?.started_at]);

  // Effect 9, total game length. Re-runs when game.status, game.started_at or
  // ts.endedAt changes. If the game isn't playing or has no start time it sets
  // gameElapsed to 0 and stops. Otherwise, every 100 ms it sets gameElapsed to
  // the time from started_at to endedAt, or to now if the game hasn't ended, so
  // the number freezes when the game ends. Shown on the timed/survival results
  // screen. Cleanup clears the interval.
  // Total multiplayer game length.
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

  // Effect 10, turn timers (timed and survival). Re-runs when isTimed,
  // isSurvival, game.status, game.turn_number or ts.skipDeadline changes. If the
  // mode isn't timed/survival, there is no turn state, or the game isn't
  // playing, it sets turnLeft and skipLeft to 0 and stops. Otherwise, every 100
  // ms it sets skipLeft to the seconds until skipDeadline, and turnLeft to the
  // holder's bank minus time used this turn (survival) or the seconds until
  // deadline (timed). Neither goes below 0. Cleanup clears the interval.
  // Timed: seconds left on the current turn (and until the survival skip).
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

  /* ------------------------------------------------------------------------
   * DERIVED DATA
   * ---------------------------------------------------------------------- */

  const playerById = useMemo(
    () => new Map(players.map((p) => [p.player_id, p])),
    [players],
  );

  // nameOf(id): takes a player id, returns that player's display name, or
  // "someone" if they are no longer in the room.
  const nameOf = (id: string) => playerById.get(id)?.display_name ?? "someone";

  // Refs so the timeout effect always sees fresh players/names without
  // restarting its interval on every poll.
  const playersRef = useRef(players);
  playersRef.current = players;
  const nameOfRef = useRef(nameOf);
  nameOfRef.current = nameOf;

  // ---- race modes ----
  // ranked: players sorted for the results screen: finished players first by
  // finish time, then unfinished players by progress (highest first).
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

  // finishedPlayers: only players with a finish time, earliest first.
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
  // timedRanking: survivors first, then eliminated players in reverse order of
  // elimination (last out ranks higher). The first entry is the winner.
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

  // timedSeats: players in seating order, used by the board during play.
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

  // liveRemainingFor(playerId): takes a player id, returns their survival time
  // bank in seconds including time already used on the current turn, so the
  // display ticks down smoothly. Only the player holding the turn has a running
  // clock; everyone else (and timed mode) shows the stored value.
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

  // ---- my progress in a race ----
  const myProgress = mode === "alphabet" ? letters.size : index;
  const iFinished = myProgress >= target;

  const currentPrompt =
    game?.prompts && game.prompts.length > 0
      ? game.prompts[index % game.prompts.length]
      : undefined;

  // phase: which screen to draw, derived from state. No room -> menu; no game
  // or status waiting -> lobby; game over -> results; countdown still running ->
  // countdown; otherwise race.
  const phase: "menu" | "lobby" | "countdown" | "race" | "results" = !room
    ? "menu"
    : !game || game.status === "waiting"
      ? "lobby"
      : (isTimed ? timedOver : raceIsOver)
        ? "results"
        : countdown > 0
          ? "countdown"
          : "race";

  // applyTurnRow(row): takes a {turn_state, turn_number} row returned by
  // patchTurn, returns nothing. Writes it into local `game` state straight away
  // so the player who moved sees it instantly instead of waiting for the next
  // poll. Ignores rows with an older turn_number so state never goes backwards.
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
   * EFFECT: turn timeouts.
   * The host is the primary referee (short grace). Every other client is a
   * backup with a longer, jittered grace, so a backgrounded/throttled host
   * can't freeze the game. patchTurn's compare-and-set makes it safe for
   * several clients to try: only one write wins.
   * ---------------------------------------------------------------------- */
  // Effect 11, timeout referee. Re-runs when isHost, room, isTimed, isSurvival,
  // game number, turn number, status, started_at, skipDeadline or timedOver
  // changes. Does nothing unless you are in a room with a running timed or
  // survival game that is not already over. Builds a turnKey from the game and
  // turn numbers and picks a grace period: 300 ms for the host, 2000 ms plus
  // random jitter for everyone else. Every 250 ms (and once immediately) it
  // runs check(), which returns early if this turn was already handled
  // (firedTurn), the countdown hasn't finished, or the turn isn't late yet. A
  // turn is late once skipDeadline plus the grace has passed; the host also
  // acts if the current player has left the room. When it fires it sets
  // firedTurn, builds the fail state with failSurvivalTurn or failTimedTurn, and
  // calls patchTurn; a winning row is applied with applyTurnRow, and on error it
  // logs and clears firedTurn so it can retry. Players and nameOf are read
  // through refs so a poll doesn't restart the interval. Cleanup clears the
  // interval.
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

      // don't referee during the pre-game countdown
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

  /* ------------------------------------------------------------------------
   * ACTIONS
   * ---------------------------------------------------------------------- */

  // validName(): takes nothing (reads the `name` state), returns the trimmed
  // name or null. The name is cut to 15 characters and must be 1 to 15 letters;
  // on failure it sets an error message and returns null.
  const validName = () => {
    const n = name.trim().slice(0, MAX_NAME_LENGTH);

    if (!/^[A-Za-z]{1,15}$/.test(n)) {
      setError("display name must be 1–15 letters only.");
      return null;
    }

    return n;
  };

  // enterRoom(code, displayName): takes a room code and the player's name,
  // returns nothing. Saves the name to localStorage, resets seenGameNumber and
  // firedTurn, clears game, players, countdown, race time and error, then sets
  // `room`, which starts the polling effect.
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

  // handleCreate(): takes nothing, returns a Promise. Validates the name, sets
  // busy, removes the player from any old room, then tries random room codes
  // and POSTs a game row, retrying on a 409 (duplicate code) for up to 5
  // attempts. It then POSTs this player into the room and calls enterRoom. On
  // failure it sets "couldn't create the game. try again."; busy is always
  // cleared at the end.
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

  // handleJoin(): takes nothing (reads name and codeInput), returns a Promise.
  // Validates the name and the 4-letter code, then checks that the room exists,
  // is still waiting, and is not full (MAX_PLAYERS, unless you are already in
  // it). It removes the player from any old room and POSTs them into this one;
  // a 409 from that insert means the name is already taken. On success it calls
  // enterRoom. The player-count check happens before the insert, so two people
  // joining at the same moment can both pass it.
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

  // handleLeave(): takes nothing, returns a Promise. Clears the local room,
  // game, players, race time and error first, so the UI returns to the menu
  // instantly, then calls leaveRoom to remove the player on the server and hand
  // off or delete the room.
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

  // handleExit(): takes nothing, returns a Promise. Leaves the room, then calls
  // the parent's onExit to return to the solo screen.
  const handleExit = async () => {
    await handleLeave();
    onExit();
  };

  // handleStart(): takes nothing, returns a Promise. Host only, and needs at
  // least MIN_PLAYERS players. Generates the shared prompt list with
  // makePrompts, resets every player, then re-syncs the clock before choosing
  // the start time (now + 3 seconds), so slow network work doesn't eat the
  // countdown. For timed and survival it builds the full initial TurnState
  // (seating order, lives or time banks, first holder, deadlines). It then
  // writes status, prompts, game number, mode, finish mode, start time, turn
  // number and turn state in one patchGame call, which moves every client from
  // the lobby to the countdown. The games-played counter is bumped afterwards in
  // one call with amount = the number of players (not awaited), so it can't
  // delay the start.
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
      const prompts = isMathMode(modeChoice)
        ? makeMathPrompts(promptCountFor(modeChoice), difficulty)
        : makePrompts(promptCountFor(modeChoice), difficulty, modeChoice);

      // Do the slow network work BEFORE stamping the start time, so the
      // countdown isn't eaten by it.
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

      // Cosmetic counter: runs after the game is live, never delays the start.
      void countGamePlayed(setGamesPlayed, players.length);
    } catch (e) {
      console.error("GROUP START ERROR:", e);

      setError("couldn't start the game. try again.");
    } finally {
      setBusy(false);
    }
  };

  // handleBackToLobby(): takes nothing, returns a Promise. Host only. Sets the
  // game back to "waiting" with no turn state and turn number 0, then resets
  // every player's progress and finish time, so everyone returns to the lobby.
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

  // handleSubmit(event): takes a form event, returns nothing. Answer
  // submission for race modes (rush, sixrush, alphabet, startEnd and the math
  // modes). Ignored before the start time or once you have finished. Validates
  // with checkAnswer against your own position in the prompt list (a word, a
  // start/end word or a math answer depending on the mode). If accepted it
  // updates your index, used words and letters locally and immediately, then
  // saves progress through the save queue. When you finish, progress is saved
  // first and the finish RPC second, because the server only stamps finished_at
  // if progress already reached the target.
  // SUBMIT AN ANSWER (rush / sixrush / alphabet / startEnd / math)
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();

    if (!game?.started_at || now() < new Date(game.started_at).getTime()) {
      return;
    }

    if (!currentPrompt || iFinished) return;

    const word = input.trim().toLowerCase();

    const problem = checkAnswer(word, currentPrompt, mode, isValidWord, used);

    if (problem) {
      setMessage(problem);
      return;
    }

    // --- word accepted ---
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
    setMessage(justFinished ? "" : isMath ? "correct!" : "good word!");

    if (justFinished) {
      // Progress must be written BEFORE the finish RPC, otherwise the server
      // sees progress < target and doesn't stamp finished_at. Running both on
      // the save queue also stops older saves from landing afterwards.
      queueSave(async () => {
        await saveProgress(target);
        await saveFinished(target);
      });
    } else {
      queueSave(() => saveProgress(nextProgress));
    }
  };

  // handleTimedSubmit(event): takes a form event, returns nothing. Word
  // submission for timed and survival. Only works on your own turn, after the
  // countdown, and before skipDeadline plus the grace (otherwise it shows "too
  // late!"). Checks the word with checkWord against the shared ts.used list. If
  // valid it builds the next TurnState with solveTimedTurn or solveSurvivalTurn,
  // clears the input, and writes it with patchTurn. A winning write is applied
  // locally with applyTurnRow; if the write loses the race the next poll shows
  // the real state, and a failed request shows "couldn't send that word."
  // SUBMIT A WORD (timed / survival): only works on my turn.
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

  /* ------------------------------------------------------------------------
   * RENDER HELPERS
   * ---------------------------------------------------------------------- */

  // progressOf(p): takes a Player, returns their progress number. During a race
  // your own row uses the local myProgress (always current) instead of the
  // database value, which can lag behind the last save.
  const progressOf = (p: Player) =>
    phase === "race" && p.player_id === me ? myProgress : p.progress;

  // getElapsedSeconds(p): takes a Player, returns how many seconds they took to
  // finish (finished_at minus started_at), or null if the game hasn't started,
  // the player hasn't finished, or a timestamp is invalid.
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

  // formatTime(seconds): takes a number or null, returns a string such as
  // "12.34s" (two decimals), or "—" for null.
  const formatTime = (seconds: number | null) => {
    if (seconds === null) return "—";

    return `${seconds.toFixed(2)}s`;
  };

  // renderScoreboard(): takes nothing, returns JSX. The race scoreboard: one
  // row per player with their name, a progress bar filled to progress / target,
  // and either a count (such as 7/20) or their finish time once done. Rows are
  // in join order during play and in `ranked` order on the results screen. The
  // winner gets a crown and your own row gets an extra class.
  // Progress bars for race modes.
  const renderScoreboard = () => (
    // RACE SCOREBOARD: container for one row per player
    <div className="mp-board">
      {(phase === "results" ? ranked : players).map((p) => {
        const count = Math.min(target, progressOf(p));

        const elapsed = getElapsedSeconds(p);

        const isWinner =
          phase === "results" && winner?.player_id === p.player_id;

        return (
          // One player's row ("mp-me" highlights the local player)
          <div
            key={p.player_id}
            className={p.player_id === me ? "mp-row mp-me" : "mp-row"}
          >
            {/* Name column, with a crown on the winner */}
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

            {/* Progress bar filled to count / target */}
            <div className="mp-bar">
              <i style={{ width: `${(count / target) * 100}%` }} />
            </div>

            {/* Finish time once done, otherwise the running count (7/20, 12/26) */}
            <span className="mp-count">
              {elapsed !== null ? formatTime(elapsed) : `${count}/${target}`}
            </span>
          </div>
        );
      })}
    </div>
  );

  // renderTimedBoard(): takes nothing, returns JSX (or null with no turn
  // state). The timed/survival scoreboard: one row per player with their name,
  // a bar for lives left (timed) or time bank left out of 60s (survival), and
  // hearts or seconds. Eliminated players are dimmed and labelled "out", the
  // player holding the turn gets a ▶ arrow, and the winner gets a crown on the
  // results screen. Uses seating order during play and the elimination ranking
  // at the end.
  const renderTimedBoard = () => {
    if (!ts) return null;

    const rows = phase === "results" ? timedRanking : timedSeats;
    const maxLives = Math.max(1, ts.maxLives ?? timedLives);

    return (
      // TIMED / SURVIVAL SCOREBOARD: container for one row per player
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
            // One player's row; dimmed to 45% opacity if eliminated
            <div
              key={p.player_id}
              className={p.player_id === me ? "mp-row mp-me" : "mp-row"}
              style={out ? { opacity: 0.45 } : undefined}
            >
              {/* Name column: crown for the winner (results), ▶ for the turn holder (play) */}
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

              {/* Bar: time bank left out of 60s (survival) or lives left out of max (timed) */}
              <div className="mp-bar">
                <i
                  style={{
                    width: `${
                      isSurvival
                        ? Math.max(
                            0,
                            Math.min(100, (remaining / SURVIVAL_TIME) * 100),
                          )
                        : Math.max(0, Math.min(100, (lives / maxLives) * 100))
                    }%`,
                  }}
                />
              </div>

              {/* "out", seconds left with one decimal (survival), or hearts (timed) */}
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

  // goalText: the one-line goal shown on the countdown screen, chosen by mode
  // (survival, timed, or race with first/last finish mode and alphabet or
  // word/problem target).
  const goalText = isSurvival
    ? "one life each. 60 seconds total per player. turns auto-skip after 15 seconds."
    : isTimed
      ? `last player standing wins. ${ts?.maxLives ?? timedLives} lives each.`
      : game?.finish_mode === "last"
        ? mode === "alphabet"
          ? "everyone must collect all 26 letters"
          : `everyone must reach ${TARGET_WORDS} ${unitName}`
        : mode === "alphabet"
          ? "first to collect all 26 letters wins"
          : `first to ${TARGET_WORDS} ${unitName} wins`;

  /* ------------------------------------------------------------------------
   * RENDER
   * ---------------------------------------------------------------------- */
  return (
    // MULTIPLAYER CARD: one card whose contents change with `phase` (menu ->
    // lobby -> countdown -> race -> results). Only one phase block below shows
    // at a time.
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
        {/* Leaves any room and returns to the solo game */}
        <button type="button" className="lb-skip" onClick={handleExit}>
          ← back to solo
        </button>

        {/* Only inside a room: leaves the room but stays in multiplayer (back to the menu) */}
        {room && phase !== "menu" && (
          <button type="button" className="lb-skip" onClick={handleLeave}>
            leave game
          </button>
        )}
      </div>

      {/* ============ MENU ============ */}
      {/* MENU: first multiplayer screen, shown when you're not in a room. Enter a
          display name, then create a game or join one with a 4-letter code. */}
      {phase === "menu" && (
        <div className="mp-menu">
          {/* Heading and one-line description */}
          <div className="results-header">
            <small>multiplayer</small>

            <h2>wordtimer</h2>

            <p>everyone gets the same letters. pick a mode and race.</p>
          </div>

          <div className="divider" />

          {/* Display name box: letters only, max 15, remembered from last time */}
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

          {/* Creates a new room and makes you the host */}
          <button
            type="button"
            className="play-again"
            onClick={handleCreate}
            disabled={busy}
          >
            create game
          </button>

          <div className="divider" />

          {/* Game code box: type a friend's 4-letter code (auto-uppercased) */}
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

          {/* Join button: disabled until all 4 code letters are entered */}
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

      {/* ============ LOBBY ============ */}
      {/* LOBBY: the waiting room. Everyone sees the code and player list; only
          the host sees the game settings and start button. */}
      {phase === "lobby" && room && (
        <div className="mp-lobby">
          {/* The room's 4-letter code in large text, with a copy button */}
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

          {/* Player list: count out of the max (e.g. 3/16), one row per player,
              "(you)" beside your name and a "host" tag beside the host */}
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

          {/* Host sees settings and the start button; everyone else sees a waiting message */}
          {isHost ? (
            <>
              {/* MODE PICKER (host only): rush, sixrush, alphabet, timed, survival,
                  startend and the three math modes in a 2-column grid, each with
                  a short description */}
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
                  survival has none, race modes show the finish-mode choice */}
              {modeChoice === "timed" ? (
                <>
                  {/* Lives per player (1-5 hearts) */}
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

                  {/* Speed-up toggle: on/off, threshold scales with player count
                      (e.g. "after 60 prompts → 5s" for 3 players) */}
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

                  {/* Two choices: end when someone finishes, or wait for everyone */}
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

              {/* DIFFICULTY PICKER (host only): math uses this same easy/hard
                  choice to control question difficulty; word modes use their
                  fragment pools, and start/end has its own pool-size hints. */}
              {
                <>
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

                          <span>
                            {isMathMode(modeChoice)
                              ? option.value === "superEasy"
                                ? "answers up to 99"
                                : "harder calculations"
                              : modeChoice === "startEnd"
                                ? START_END_HINTS[option.value]
                                : option.hint}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              }

              {/* START BUTTON (host only): disabled until 2+ players have joined;
                  the label reads "waiting for players (1/2)" until then */}
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

      {/* ============ COUNTDOWN ============ */}
      {/* COUNTDOWN: the 3-2-1 screen shown to everyone before a game begins */}
      {phase === "countdown" && (
        <div className="mp-countdown-screen">
          {/* "get ready · <mode name>" label */}
          <small>
            get ready ·{" "}
            {MODE_OPTIONS.find((o) => o.value === mode)?.label ?? mode}
          </small>

          {/* Big countdown number (3, 2, 1) */}
          <div className="mp-countdown">{countdown}</div>

          {/* One-line goal for the chosen mode */}
          <p className="rule">{goalText}</p>
        </div>
      )}

      {/* ============ RACE (rush / sixrush / alphabet / startEnd / math) ============ */}
      {/* RACE (rush / sixrush / alphabet / startEnd / math): everyone answers at
          their own pace through the same prompt list; the scoreboard shows live
          progress. */}
      {phase === "race" && !isTimed && (
        <div className="mp-race">
          {/* Shared race stopwatch (seconds since the start, two decimals) */}
          <div className="timer">{raceTime.toFixed(2)}s</div>

          {iFinished ? (
            // Shown once YOU have finished: banner with your final count and
            // what happens next
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
              {/* PROMPT: progress label ("WORD 3 OF 20" / "PROBLEM 3 OF 20" /
                  "LETTERS 5 OF 26"), the big fragment (or "ST … ED" / the math
                  problem), and an instruction line */}
              <div className="prompt">
                <small>
                  {mode === "alphabet"
                    ? `LETTERS ${letters.size} OF ${ALPHABET_TARGET}`
                    : `${isMath ? "PROBLEM" : "WORD"} ${index + 1} OF ${TARGET_WORDS}`}
                </small>

                <strong>
                  {currentPrompt
                    ? displayPrompt(currentPrompt.fragment, mode)
                    : ""}
                </strong>

                <p>
                  {isMath
                    ? "type the answer. whole numbers only."
                    : mode === "startEnd"
                      ? "use a dictionary word (3+ letters) that starts and ends with these letters"
                      : mode === "sixrush"
                        ? "put these letters in your word. 6+ letters."
                        : "put these letters in order anywhere in your word"}
                </p>
              </div>

              {/* ANSWER FORM: text box (letters only, or digits only in math,
                  lowercased), enter button, and a feedback line ("good word!" or
                  an error) */}
              <form onSubmit={handleSubmit}>
                <div className="entry">
                  <input
                    id="mp-word"
                    value={input}
                    onChange={(e) =>
                      setInput(
                        e.target.value.replace(inputFilter, "").toLowerCase(),
                      )
                    }
                    inputMode={isMath ? "numeric" : "text"}
                    autoFocus
                    autoComplete="off"
                    placeholder={
                      isMath ? "type the answer..." : "type a word..."
                    }
                  />

                  <button type="submit">enter</button>
                </div>

                <div className="message">{message}</div>
              </form>
            </>
          )}

          {/* Alphabet only: A-Z grid with your collected letters highlighted */}
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

          {/* Connection warning (only if polling fails) */}
          {syncError && <div className="message">{syncError}</div>}
        </div>
      )}

      {/* ============ RACE (timed / hot potato) ============ */}
      {/* RACE (timed / survival): turn-based hot potato. One player holds the
          fragment at a time and must answer before their clock runs out. */}
      {phase === "race" && isTimed && ts && (
        <div className="mp-race">
          {/* Main clock: the turn's countdown (timed) or the holder's remaining bank (survival) */}
          <div className="timer">{turnLeft.toFixed(1)}s</div>

          {/* Survival only: countdown to the automatic 15-second turn skip */}
          {isSurvival && (
            <div className="mp-survival-top">
              <strong>turn skips in {Math.ceil(skipLeft)}s</strong>
            </div>
          )}

          {/* Last word box: who typed the most recent word, or a placeholder */}
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

          {/* PROMPT: label says whose turn it is ("YOUR TURN", "<NAME>'S TURN",
              or "YOU'RE OUT. WATCHING"), then the big fragment and a hint line */}
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

          {/* ANSWER FORM: only on YOUR turn. The key resets the input each turn. */}
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

              {/* Feedback for your own answers (errors, "too late!") */}
              <div className="message">{message}</div>
            </form>
          )}

          {/* Event note visible to everyone ("X ran out of time", "X is out!") */}
          {ts.note && <div className="message">{ts.note}</div>}

          <div className="divider" />

          {/* Scoreboard: lives (timed) or time bank (survival) for each player */}
          {renderTimedBoard()}

          {/* Timed only: your personal A-Z bonus tracker */}
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

              {/* A-Z grid with your collected letters highlighted */}
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

              {/* Extra-life rule */}
              <p className="rule">
                collect all 26 letters from your words to gain an extra life.
              </p>
            </>
          )}

          {/* Connection warning (only if polling fails) */}
          {syncError && <div className="message">{syncError}</div>}
        </div>
      )}

      {/* ============ RESULTS ============ */}
      {/* RESULTS (a winner exists): who won and the final standings */}
      {phase === "results" && winner && (
        <div className="mp-results">
          {/* Headline: "you won!" or "game over", the winner's name with a crown,
              and a line explaining how they won */}
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
                      : `first to ${TARGET_WORDS} ${unitName}`}
            </p>
          </div>

          <div className="divider" />

          {/* Timed / survival only: total words typed and game length */}
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

          {/* Final standings: elimination order (timed/survival) or finish order with times (races) */}
          {isTimed ? renderTimedBoard() : renderScoreboard()}

          <div className="divider" />

          {/* Host gets a "play again" button back to the lobby; others see a waiting message */}
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

      {/* RESULTS (no winner): fallback, e.g. everyone left. The host can still
          return to the lobby. */}
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
