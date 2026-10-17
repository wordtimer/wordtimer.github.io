import {
  Dispatch,
  SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { DICTIONARY, MODERN_WORDS } from "../assets/dict";
import {
  Leaderboard,
  LeaderboardSubmitModal,
  Period,
  getRunRank,
  getScorePercentile,
  isRankedMode,
  submitScore,
  wouldQualify,
  type RankedMode,
} from "../src/app/leaderboardv2";
import GroupGame, { type GroupDifficulty, type PromptItem } from "./GroupGame";
import "./styles.css";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

const DEFAULT_TIME = 10;
const DEFAULT_TIMED_LIVES = 3;
const TIMED_LIFE_OPTIONS = [1, 2, 3, 4, 5];
const TIMED_SHORT_TIME = 5;
const TIMED_SHORT_AFTER_WORDS_PER_PLAYER = 20;

// Solo anagram mode: seconds on the clock, and the shortest word that counts.
const ANAGRAM_SECONDS = 45;
const ANAGRAM_MIN_LENGTH = 3;

const SUPABASE_KEY = "sb_publishable_mB2ZU7RWDpQdPA-mIh8tKw_oxs1_2_B";

// Games-played counter. Both are Supabase RPC functions called with POST.
const COUNTER_GET_URL =
  "https://frnjbjhigceptzwtmyax.supabase.co/rest/v1/rpc/get_games_played"; // read only
const COUNTER_HIT_URL =
  "https://frnjbjhigceptzwtmyax.supabase.co/rest/v1/rpc/count_games_played"; // adds p_amount

// callCounter(url, body): takes an RPC URL and a JSON body object, returns a
// Promise of the counter total as a number, or null if anything went wrong.
// It POSTs the body with the Supabase auth headers. If the response is not OK
// it returns null. Otherwise it reads the JSON (the RPC returns a bare number),
// converts it with Number(), and returns it only if it is a finite number.
// Both counter functions below go through this.
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
// number, returns a Promise that resolves to nothing. Calls the get_games_played
// RPC with an empty body and stores the total, but only if a number came back.
// Errors are ignored on purpose because the counter is only cosmetic.
async function loadGamesPlayed(
  setGamesPlayed: Dispatch<SetStateAction<number>>,
) {
  try {
    const value = await callCounter(COUNTER_GET_URL, {});

    if (value !== null) setGamesPlayed(value);
  } catch { }
}

// countGamePlayed(setGamesPlayed, amount = 1): takes the state setter and how
// many games to add (default 1), returns a Promise that resolves to nothing.
// Calls the count_games_played RPC with { p_amount: amount }, which adds that
// number on the server and returns the new total, then stores the total if a
// number came back. Errors are ignored because the counter is cosmetic.
async function countGamePlayed(
  setGamesPlayed: Dispatch<SetStateAction<number>>,
  amount = 1,
) {
  try {
    const value = await callCounter(COUNTER_HIT_URL, { p_amount: amount });

    if (value !== null) setGamesPlayed(value);
  } catch { }
}

type Difficulty = "superEasy" | "hard";
type MathMode = "math";
type GameMode =
  | "timed"
  | "zen"
  | "rush"
  | "alphabet"
  | "sevenRush"
  | "startEnd"
  | "daily"
  | "anagram"
  | "wordChange"
  | MathMode;

// Minimum number of dictionary words that must contain a fragment.
const DIFFICULTY_LIMITS: Record<Difficulty, number> = {
  superEasy: 5000,
  hard: 500,
};

// Maximum number of words that may contain a fragment. Easy has no cap; hard
// caps at 2500 so very common fragments are excluded.
const DIFFICULTY_MAX: Record<Difficulty, number> = {
  superEasy: Infinity,
  hard: 2500,
};

const DIFFICULTY_OPTIONS: { value: Difficulty; label: string; hint: string }[] =
  [
    { value: "superEasy", label: "easy", hint: "5,000+ words" },
    { value: "hard", label: "hard", hint: "500–2,500 words" },
  ];

const MODE_OPTIONS: { value: GameMode; label: string; hint: string }[] = [
  { value: "rush", label: "rush", hint: "10 words, fastest time" },
  { value: "sevenRush", label: "sixrush", hint: "10 words, 6+ letters" },
  { value: "timed", label: "timed", hint: "beat the clock" },
  { value: "alphabet", label: "alphabet", hint: "collect 26 letters" },
  { value: "zen", label: "zen", hint: "no timer or lives, not ranked" },
  { value: "startEnd", label: "start/end", hint: "10 words, match both ends" },
  { value: "math", label: "math", hint: "10 arithmetic questions" },
  { value: "daily", label: "daily", hint: "5 words, once a day" },
  {
    value: "anagram",
    label: "anagram",
    hint: `${ANAGRAM_SECONDS}s, words from 7 letters`,
  },
  {
    value: "wordChange",
    label: "word change",
    hint: "1 ladder, 1 letter at a time",
  },
];

const TIME_OPTIONS = [5, 10, 20, 60];

// isValidWord(word): takes a lowercase word, returns true if it is in the main
// dictionary or the modern-words list. Used by the anagram and word change
// checks, and passed to GroupGame as its dictionary check.
const isValidWord = (word: string) =>
  DICTIONARY.has(word) || MODERN_WORDS.has(word);

// noDifficultyMode(mode): takes a GameMode, returns true for modes where the
// easy/hard setting does nothing (anagram, word change and daily). The
// difficulty picker greys out and deselects its buttons for these.
const noDifficultyMode = (mode: GameMode) =>
  mode === "anagram" || mode === "wordChange" || mode === "daily";

// isMathMode(mode): takes a GameMode, returns true only for the math mode. It
// is a type guard, so TypeScript knows the mode is MathMode afterwards.
function isMathMode(mode: GameMode): mode is MathMode {
  return mode === "math";
}

// Keep the existing leaderboard mode keys for saved scores while the game UI
// presents math as one mode whose difficulty is chosen separately. Modes with
// no leaderboard key (zen, anagram, word change) return null, which the rest of
// the code treats as "not ranked".
function leaderboardModeFor(
  mode: GameMode,
  difficulty: Difficulty,
): RankedMode | null {
  if (mode === "math")
    return difficulty === "superEasy" ? "mathEasy" : "mathMed";
  return isRankedMode(mode) ? mode : null;
}

// isRushMode(mode): takes a GameMode, returns true for the modes scored by
// total elapsed time instead of word count (rush, alphabet, sixrush, start/end,
// daily, word change and math). The UI uses it to decide between showing a
// stopwatch and a score. Anagram is not included because it counts down.
function isRushMode(mode: GameMode) {
  return (
    mode === "rush" ||
    mode === "alphabet" ||
    mode === "sevenRush" ||
    mode === "startEnd" ||
    mode === "daily" ||
    mode === "wordChange" ||
    isMathMode(mode)
  );
}

type StartEndPrompt = {
  start: string;
  end: string;
  examples: string[];
  count: number;
};
type MathPrompt = { expression: string; answer: number };

const ALL_WORDS = [...new Set([...DICTIONARY, ...MODERN_WORDS])].filter(
  (word) => /^[a-z]+$/.test(word) && word.length >= 3,
);

// Build start/end combinations from real dictionary words. Each prompt uses
// exactly one starting letter and one ending letter, with answers at least 3
// letters long so every combination has room for a real word between the ends.
function buildStartEndPromptData() {
  const data = new Map<string, StartEndPrompt>();

  for (const word of ALL_WORDS) {
    if (word.length < 3) continue;

    const start = word[0];
    const end = word[word.length - 1];
    const key = `${start}|${end}`;
    let prompt = data.get(key);

    if (!prompt) {
      prompt = { start, end, examples: [], count: 0 };
      data.set(key, prompt);
    }

    prompt.count++;
    if (prompt.examples.length < 12 && !prompt.examples.includes(word)) {
      prompt.examples.push(word);
    }
  }

  return [...data.values()];
}

const START_END_PROMPTS = buildStartEndPromptData();

// Start/end difficulty is based on how many dictionary words match each
// starting-letter / ending-letter pair: easy is 50–500 words; hard is 500+.
function pickStartEndPrompt(difficulty: Difficulty): StartEndPrompt {
  let pool = START_END_PROMPTS.filter((item) =>
    difficulty === "hard"
      ? item.count >= 80 && item.count <= 800
      : item.count >= 800,
  );

  // Safety fallback for unusually small or changed dictionaries.
  if (!pool.length) {
    pool = START_END_PROMPTS.filter((item) => item.count > 0);
  }

  if (!pool.length) {
    return { start: "a", end: "s", examples: ["apples"], count: 1 };
  }

  if (difficulty === "hard") {
    return pool[Math.floor(Math.random() * pool.length)];
  }

  const weightedPool: StartEndPrompt[] = [];
  for (const item of pool) {
    const weight = Math.min(20, Math.max(1, Math.floor(item.count / 100)));
    for (let i = 0; i < weight; i++) weightedPool.push(item);
  }

  return weightedPool[Math.floor(Math.random() * weightedPool.length)];
}

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickMathPrompt(
  difficulty: Difficulty,
  usedExpressions: Set<string> = new Set(),
): MathPrompt {
  const applyOperation = (a: number, b: number, operation: number) => {
    if (operation === 0) return { value: a + b, symbol: "+" };
    if (operation === 1) return { value: a - b, symbol: "−" };
    return { value: a * b, symbol: "×" };
  };

  // Use a bounded number of attempts so an unexpectedly exhausted pool cannot
  // leave the game stuck in an infinite loop.
  for (let attempt = 0; attempt < 2000; attempt++) {
    let answer = 0;
    let expression = "";
    const operation = randomInt(0, 3);

    // About half of prompts are two-step calculations. Easy answers can be
    // anywhere from 0 to 99; hard uses larger numbers and results.
    const useTwoSteps = Math.random() < 0.5;
    if (useTwoSteps && operation !== 3) {
      const easy = difficulty === "superEasy";
      // easy: only the first term can be two digits; the others are 1–9
      const a = easy ? randomInt(1, 99) : randomInt(12, 45);
      const b = easy ? randomInt(1, 9) : randomInt(12, 45);
      const c = easy ? randomInt(1, 9) : randomInt(12, 45);
      const firstOp = randomInt(0, 2);
      const secondOp = randomInt(0, 2);
      const first = applyOperation(a, b, firstOp);
      const second = applyOperation(first.value, c, secondOp);
      answer = second.value;
      const limit = easy ? 99 : 500;
      if (
        answer < 0 ||
        answer > limit ||
        first.value < 0 ||
        first.value > limit
      )
        continue;
      // easy multiplication must stay within 9 × 9
      if (
        easy &&
        ((firstOp === 2 && a > 9) || (secondOp === 2 && first.value > 9))
      )
        continue;
      expression = `(${a} ${first.symbol} ${b}) ${second.symbol} ${c}`;
    } else if (difficulty === "superEasy") {
      if (operation === 0) {
        const b = randomInt(1, 9);
        const a = randomInt(1, 99 - b);
        answer = a + b;
        expression = `${a} + ${b}`;
      } else if (operation === 1) {
        const a = randomInt(10, 99);
        const b = randomInt(1, Math.min(9, a - 1));
        answer = a - b;
        expression = `${a} − ${b}`;
      } else if (operation === 2) {
        const a = randomInt(1, 9);
        const b = randomInt(1, 9);
        answer = a * b;
        expression = `${a} × ${b}`;
      } else {
        const a = randomInt(2, 9);
        const b = randomInt(2, 6);
        answer = a ** b;
        if (answer > 99) continue;
        expression = `${a}^${b}`;

      }
    } else if (operation === 0) {
      const a = randomInt(25, 199);
      const b = randomInt(15, 199);
      answer = a + b;
      if (answer > 500) continue;
      expression = `${a} + ${b}`;
    } else if (operation === 1) {
      const a = randomInt(30, 250);
      const b = randomInt(10, a - 1);
      answer = a - b;
      expression = `${a} − ${b}`;
    } else if (operation === 2) {
      const a = randomInt(12, 25);
      const b = randomInt(3, 18);
      answer = a * b;
      if (answer > 500) continue;
      expression = `${a} × ${b}`;
    } else {
      const a = randomInt(3, 15);
      const b = randomInt(2, 5);
      answer = a ** b;
      if (answer > 500) continue;
      expression = `${a}^${b}`;
    }

    if (usedExpressions.has(expression)) continue;
    return { expression, answer };
  }

  // This fallback is only reached if the used-expression set is nearly full.
  for (let a = 1; a <= 9; a++) {
    for (let b = 1; b <= 9; b++) {
      const expression = `${a} + ${b}`;
      const answer = a + b;
      if (
        answer <= (difficulty === "superEasy" ? 99 : 500) &&
        !usedExpressions.has(expression)
      ) {
        return { expression, answer };
      }
    }
  }
  return { expression: "1 + 1", answer: 2 };
}

type PromptData = {
  count: number;
  longCount: number;
  examples: string[];
  longExamples: string[];
};

// sixrush only uses fragments where at least this share of the difficulty's
// word minimum comes from 6+ letter words
// (easy: 5000 * 0.5 = 2500, hard: 500 * 0.5 = 250)
const SEVEN_RUSH_LONG_RATIO = 0.5;

// addExample(list, word): takes a string array of example answers and a
// candidate word, returns nothing (it changes `list` directly). Pushes the word
// only if the list has fewer than 12 entries and no existing example starts
// with the same first letter, which keeps hints varied.
function addExample(list: string[], word: string) {
  if (list.length < 12 && !list.some((example) => example[0] === word[0])) {
    list.push(word);
  }
}

// buildPromptData(): takes nothing, returns a Map from fragment string to a
// PromptData object. It loops over every unique word in DICTIONARY and
// MODERN_WORDS (skipping words under 2 letters), slices out every 2-letter and
// 3-letter substring (a Set per word stops a fragment being counted twice in
// one word), and for each fragment records: how many words contain it (count),
// how many of those have 6+ letters (longCount), and example words (examples,
// longExamples). Runs once at startup to create PROMPT_DATA.
function buildPromptData() {
  const data = new Map<string, PromptData>();

  for (const word of new Set([...DICTIONARY, ...MODERN_WORDS])) {
    if (word.length < 2) continue;

    const isLong = word.length >= 6;
    const fragments = new Set<string>();

    for (let i = 0; i < word.length - 1; i++) {
      fragments.add(word.slice(i, i + 2));

      if (i + 2 < word.length) {
        fragments.add(word.slice(i, i + 3));
      }
    }

    for (const fragment of fragments) {
      let entry = data.get(fragment);

      if (!entry) {
        entry = { count: 0, longCount: 0, examples: [], longExamples: [] };
        data.set(fragment, entry);
      }

      entry.count++;

      if (entry.examples.length === 0) {
        entry.examples.push(word);
      } else {
        addExample(entry.examples, word);
      }

      if (isLong) {
        entry.longCount++;
        addExample(entry.longExamples, word);
      }
    }
  }

  return data;
}

const PROMPT_DATA = buildPromptData();

/* ---------- daily mode ---------- */
const DAILY_WORDS = 5;
const DAILY_TARGET_COUNT = 4000;
const DAILY_TOLERANCE = 400;
const DAILY_STORAGE_KEY = "wordtimer_daily";

type DailyRecord = { date: string; time: number | null };

// UTC date, so every device gets the same puzzle on the same day.
const todayKey = () => new Date().toISOString().slice(0, 10);

function readDaily(): DailyRecord | null {
  try {
    const raw = JSON.parse(localStorage.getItem(DAILY_STORAGE_KEY) ?? "null");
    return raw && raw.date === todayKey() ? (raw as DailyRecord) : null;
  } catch {
    return null;
  }
}

function writeDaily(record: DailyRecord) {
  try {
    localStorage.setItem(DAILY_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // storage unavailable
  }
}

// small seeded RNG (hash feeding a mixer)
function seededRng(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

// 5 fragments that each appear in roughly 4000 dictionary words, the same for
// everyone on a given UTC day.
function buildDailyPrompts(dateKey: string) {
  const all = [...PROMPT_DATA.entries()]
    .map(([fragment, d]) => ({
      fragment,
      count: d.count,
      examples: d.examples,
    }))
    .sort((a, b) => (a.fragment < b.fragment ? -1 : 1));

  let pool = all.filter(
    (p) => Math.abs(p.count - DAILY_TARGET_COUNT) <= DAILY_TOLERANCE,
  );

  if (pool.length < DAILY_WORDS * 3) {
    pool = [...all]
      .sort(
        (a, b) =>
          Math.abs(a.count - DAILY_TARGET_COUNT) -
          Math.abs(b.count - DAILY_TARGET_COUNT),
      )
      .slice(0, 30)
      .sort((a, b) => (a.fragment < b.fragment ? -1 : 1));
  }

  const rng = seededRng(`wordtimer-daily-${dateKey}`);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, DAILY_WORDS);
}


// buildPromptPool(difficulty, mode?, minimumOverride?): takes a difficulty, an
// optional game mode, and an optional replacement minimum. Returns an array of
// {fragment, count, examples}. It keeps fragments from PROMPT_DATA that appear
// in at least `minimum` words (the override, or DIFFICULTY_LIMITS for the
// difficulty) and in no more than DIFFICULTY_MAX words (so hard, capped at
// 2500, excludes very common fragments). In sixrush mode it also requires
// longCount of at least half the minimum and at least one long example, and
// swaps in the long counts and examples.
function buildPromptPool(
  difficulty: Difficulty,
  mode?: GameMode,
  minimumOverride?: number,
) {
  const minimum = minimumOverride ?? DIFFICULTY_LIMITS[difficulty];
  const maximum = DIFFICULTY_MAX[difficulty];
  const sevenRush = mode === "sevenRush";
  const longMinimum = Math.ceil(minimum * SEVEN_RUSH_LONG_RATIO);

  return [...PROMPT_DATA.entries()]
    .filter(([, data]) => {
      if (data.count < minimum || data.count > maximum) return false;

      if (sevenRush) {
        return data.longCount >= longMinimum && data.longExamples.length > 0;
      }

      return true;
    })
    .map(([fragment, data]) => ({
      fragment,
      count: sevenRush ? data.longCount : data.count,
      examples: sevenRush ? data.longExamples : data.examples,
    }));
}

// pickPrompt(difficulty, mode?): takes a difficulty and an optional mode,
// returns {fragment, examples}. It builds the pool for the difficulty's minimum
// (and maximum), and if that pool is empty it retries with lower minimums (100,
// 20, 1) while keeping the maximum. If everything fails it returns the fallback
// "in". Hard then picks one fragment uniformly at random, with no weighting.
// Easy weights each fragment by min(20, max(1, floor(count / 100))), meaning
// common fragments appear up to 20 times in a list, and picks randomly from
// that weighted list.
function pickPrompt(difficulty: Difficulty, mode?: GameMode) {
  const minimum = DIFFICULTY_LIMITS[difficulty];

  // If the pool is empty (e.g. sixrush on hard), step the minimum down instead
  // of falling straight to "in".
  const minimumsToTry = [minimum, 100, 20, 1];

  let pool: ReturnType<typeof buildPromptPool> = [];

  for (const candidate of minimumsToTry) {
    pool = buildPromptPool(difficulty, mode, candidate);
    if (pool.length) break;
  }

  if (!pool.length) {
    return {
      fragment: "in",
      examples: ["inside", "winter"],
    };
  }

  if (difficulty === "hard") {
    return pool[Math.floor(Math.random() * pool.length)];
  }

  const weightedPool: typeof pool = [];

  for (const item of pool) {
    const weight = Math.min(20, Math.max(1, Math.floor(item.count / 100)));

    for (let i = 0; i < weight; i++) {
      weightedPool.push(item);
    }
  }

  return weightedPool[Math.floor(Math.random() * weightedPool.length)];
}

/* ---------- anagram (solo + multiplayer) ---------- */
const VOWELS = new Set(["a", "e", "i", "o", "u"]);
const PANGRAM_SEEDS = ALL_WORDS.filter(
  (w) => w.length >= 7 && w.length <= 9 && new Set(w).size === 7,
);

// makeAnagramPrompt(): takes nothing, returns a PromptItem whose fragment is
// the 7 shuffled letters and whose examples are up to 12 words that can be made
// from them (pangrams first, then the longest). The letters are taken from a
// real word with 7 distinct letters, so at least one pangram exists. It retries
// (up to 30 times) until the letters include 2+ vowels and allow at least 40
// words, and falls back to "stearin" if nothing qualifies.
function makeAnagramPrompt(): PromptItem {
  for (let attempt = 0; attempt < 30; attempt++) {
    const seed = PANGRAM_SEEDS[Math.floor(Math.random() * PANGRAM_SEEDS.length)];
    if (!seed) break;
    const letters = [...new Set(seed)];
    if (letters.filter((c) => VOWELS.has(c)).length < 2) continue;

    const set = new Set(letters);
    const valid = ALL_WORDS.filter((w) => [...w].every((c) => set.has(c)));
    if (valid.length < 40) continue;

    const pangrams = valid.filter((w) => set.size === new Set(w).size);
    const longest = [...valid].sort((a, b) => b.length - a.length);
    const examples = [...new Set([...pangrams, ...longest])].slice(0, 12);

    for (let i = letters.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [letters[i], letters[j]] = [letters[j], letters[i]];
    }
    return { fragment: letters.join(""), examples };
  }
  return { fragment: "stearin", examples: ["inserts", "stearin"] };
}

/* ---------- word change (solo + multiplayer) ---------- */
type WordGraph = { words: string[]; buckets: Map<string, string[]> };
const wordGraphs = new Map<number, WordGraph>();

// getWordGraph(len): takes a word length, returns a WordGraph for words of that
// length. `words` is every dictionary word of that length; `buckets` maps a
// "wildcard" key (the word with one letter replaced by "_", e.g. "c_t") to every
// word that matches it, so words one letter apart share a bucket. Built once per
// length and cached in wordGraphs.
function getWordGraph(len: number): WordGraph {
  const cached = wordGraphs.get(len);
  if (cached) return cached;

  const words = ALL_WORDS.filter((w) => w.length === len);
  const buckets = new Map<string, string[]>();
  for (const w of words) {
    for (let i = 0; i < len; i++) {
      const key = w.slice(0, i) + "_" + w.slice(i + 1);
      const list = buckets.get(key);
      if (list) list.push(w);
      else buckets.set(key, [w]);
    }
  }
  const graph = { words, buckets };
  wordGraphs.set(len, graph);
  return graph;
}

// neighborsOf(word, g): takes a word and its WordGraph, returns every other
// word that differs from it by exactly one letter, by reading the buckets for
// each wildcard version of the word.
function neighborsOf(word: string, g: WordGraph) {
  const out: string[] = [];
  for (let i = 0; i < word.length; i++) {
    const key = word.slice(0, i) + "_" + word.slice(i + 1);
    for (const w of g.buckets.get(key) ?? []) if (w !== word) out.push(w);
  }
  return out;
}

// makeWordChangePrompt(difficulty): takes a difficulty, returns a PromptItem
// whose fragment is "start-end" and whose examples are one shortest path
// between them (proof the ladder is solvable). Easy uses 4-letter words with
// ladders of 3–4 steps; hard uses 5-letter words with 5–7 steps. It picks a
// random start, runs a breadth-first search, then picks a target whose
// shortest-path distance is in range. If a range fails 150 times it tries a
// wider one, and finally falls back to cold → warm.
function makeWordChangePrompt(difficulty: GroupDifficulty): PromptItem {
  const len = difficulty === "hard" ? 5 : 4;
  const g = getWordGraph(len);
  const ranges =
    difficulty === "hard"
      ? [[5, 7], [4, 7], [3, 7]]
      : [[3, 4], [2, 4]];

  for (const [minSteps, maxSteps] of ranges) {
    for (let attempt = 0; attempt < 150; attempt++) {
      const start = g.words[Math.floor(Math.random() * g.words.length)];
      const parent = new Map<string, string | null>([[start, null]]);
      const depth = new Map<string, number>([[start, 0]]);
      const queue = [start];
      const candidates: string[] = [];

      for (let qi = 0; qi < queue.length; qi++) {
        const cur = queue[qi];
        const d = depth.get(cur)!;
        if (d >= minSteps) candidates.push(cur);
        if (d >= maxSteps) continue;
        for (const n of neighborsOf(cur, g)) {
          if (parent.has(n)) continue;
          parent.set(n, cur);
          depth.set(n, d + 1);
          queue.push(n);
        }
      }
      if (!candidates.length) continue;

      const end = candidates[Math.floor(Math.random() * candidates.length)];
      const path: string[] = [];
      for (let w: string | null = end; w; w = parent.get(w) ?? null) path.push(w);
      path.reverse();
      return { fragment: `${start}-${end}`, examples: path };
    }
  }
  return { fragment: "cold-warm", examples: ["cold", "cord", "card", "ward", "warm"] };
}

// makeGroupPrompts(count, difficulty, mode?): returns the prompt list passed to
// GroupGame. Start/end gets dictionary-backed one-letter endpoint prompts; other
// modes keep using the normal fragment pool. Duplicate prompts are skipped first,
// then allowed as a fallback if the pool runs out.
function makeGroupPrompts(
  count: number,
  difficulty: GroupDifficulty,
  mode?: string,
) {
  if (mode === "anagram") return [makeAnagramPrompt()];

  if (mode === "wordChange") {
    const ladders: PromptItem[] = [];
    const seenLadders = new Set<string>();
    let tries = 0;
    while (ladders.length < count && tries++ < count * 20) {
      const p = makeWordChangePrompt(difficulty);
      if (seenLadders.has(p.fragment)) continue;
      seenLadders.add(p.fragment);
      ladders.push(p);
    }
    while (ladders.length < count) ladders.push(makeWordChangePrompt(difficulty));
    return ladders;
  }

  const seen = new Set<string>();
  const out: PromptItem[] = [];
  let guard = 0;

  // Start/end prompts are generated here too, so multiplayer gets the same
  // one-letter endpoints and dictionary-backed answers as the solo game.
  if (mode === "startEnd") {
    while (out.length < count && guard++ < count * 50) {
      const p = pickStartEndPrompt(difficulty);
      const fragment = `${p.start}-${p.end}`;
      if (seen.has(fragment)) continue;
      seen.add(fragment);
      out.push({ fragment, examples: p.examples });
    }

    while (out.length < count) {
      const p = pickStartEndPrompt(difficulty);
      out.push({ fragment: `${p.start}-${p.end}`, examples: p.examples });
    }

    return out;
  }

  while (out.length < count && guard++ < count * 20) {
    const p = pickPrompt(difficulty);
    if (seen.has(p.fragment)) continue;
    seen.add(p.fragment);
    out.push({ fragment: p.fragment, examples: p.examples });
  }

  while (out.length < count) {
    const p = pickPrompt(difficulty);
    out.push({ fragment: p.fragment, examples: p.examples });
  }

  return out;
}

// logPromptPools(): takes nothing, returns nothing. Debug helper exposed as
// window.logPromptPools(). For every difficulty and for rush versus sixrush it
// builds the prompt pool with the base minimum and prints a console table of how
// many fragments qualify, which shows whether a pool is too small.
// paste in the browser console via window.logPromptPools() to see pool sizes
function logPromptPools() {
  const modes: GameMode[] = ["rush", "sevenRush"];
  const rows: Record<string, number | string>[] = [];

  for (const difficulty of Object.keys(DIFFICULTY_LIMITS) as Difficulty[]) {
    for (const mode of modes) {
      rows.push({
        difficulty,
        mode,
        fragments: buildPromptPool(difficulty, mode).length,
      });
    }
  }

  console.table(rows);
}

if (typeof window !== "undefined") {
  (window as unknown as { logPromptPools: () => void }).logPromptPools =
    logPromptPools;
}

// getRandomExamples(examples): takes a string array, returns a new string array
// of at most 2. If there are 2 or fewer it returns a copy of all of them;
// otherwise it shuffles a copy with a random sort and takes the first two. Used
// for the "you could have put X or Y" message after a missed prompt.
function getRandomExamples(examples: string[]) {
  if (examples.length <= 2) {
    return [...examples];
  }

  const shuffled = [...examples].sort(() => Math.random() - 0.5);

  return shuffled.slice(0, 2);
}

// App(): the whole solo game, takes no props, returns JSX. It holds all game
// state (mode, difficulty, prompt, score, timers, modals, leaderboard data) and
// renders one of three views: the start screen, the active game, or the results
// screen. The multiplayer screen is a separate component (GroupGame) that this
// one swaps in when `screen` is "group".
export default function App() {
  const [screen, setScreen] = useState<"solo" | "group">("solo");
  const [difficulty, setDifficulty] = useState<Difficulty>("superEasy");
  const [percentile, setPercentile] = useState<number | null>(null);
  const [percentileTotal, setPercentileTotal] = useState(0);
  const [percentileLoading, setPercentileLoading] = useState(false);
  const runIdRef = useRef<string | null>(null);
  const [pendingRun, setPendingRun] = useState<{
    runId: string;
    mode: RankedMode;
    difficulty: Difficulty;
    roundTime: number | null;
    score: number;
    allTime: boolean;
    daily: boolean;
  } | null>(null);

  const [boardRefresh, setBoardRefresh] = useState(0);

  const [boardPeriod, setBoardPeriod] = useState<Period>("alltime");

  const [highlightRanks, setHighlightRanks] = useState<{
    alltime: number | null;
    daily: number | null;
  }>({ alltime: null, daily: null });

  const [roundTime, setRoundTime] = useState<number>(DEFAULT_TIME);
  const [timedLives, setTimedLives] = useState(DEFAULT_TIMED_LIVES);
  const [shortenTimed, setShortenTimed] = useState(true);

  const [gameMode, setGameMode] = useState<GameMode>("rush");

  // ---- daily mode (one play per device) ----
  const [dailyRecord, setDailyRecord] = useState<DailyRecord | null>(readDaily);
  const dailyPromptsRef = useRef<
    { fragment: string; count: number; examples: string[] }[]
  >([]);
  const rushTarget = gameMode === "daily" ? DAILY_WORDS : 10;
  const dailyLocked = gameMode === "daily" && dailyRecord?.date === todayKey();

  const wordInputRef = useRef<HTMLInputElement | null>(null);

  const initialPrompt = pickPrompt("superEasy");

  const [prompt, setPrompt] = useState(initialPrompt.fragment);

  const [promptExamples, setPromptExamples] = useState(initialPrompt.examples);
  const [startEndPrompt, setStartEndPrompt] = useState<StartEndPrompt>(() =>
    pickStartEndPrompt(difficulty),
  );
  const [mathPrompt, setMathPrompt] = useState<MathPrompt>(() =>
    pickMathPrompt(difficulty),
  );
  const mathPromptHistoryRef = useRef<Set<string>>(new Set());
  const getNextMathPrompt = () => {
    const next = pickMathPrompt(difficulty, mathPromptHistoryRef.current);
    mathPromptHistoryRef.current.add(next.expression);
    return next;
  };

  // ---- anagram mode: the 7 letters and the seconds left on the clock ----
  const [anagramLetters, setAnagramLetters] = useState("");
  const [anagramLeft, setAnagramLeft] = useState(ANAGRAM_SECONDS);

  // ---- word change mode: start word, target word, and my steps so far ----
  const [wcStart, setWcStart] = useState("");
  const [wcEnd, setWcEnd] = useState("");
  const [wcChain, setWcChain] = useState<string[]>([]);

  // bumps every time a new prompt is shown so the countdown restarts even if
  // the same fragment and the same time value come up twice in a row
  const [promptNonce, setPromptNonce] = useState(0);

  const [started, setStarted] = useState(false);
  const [input, setInput] = useState("");

  const [lives, setLives] = useState(3);

  const [score, setScore] = useState(0);
  const [showLeaderboard, setShowLeaderboard] = useState(false);

  const [showCredits, setShowCredits] = useState(false);
  const [rushWords, setRushWords] = useState(0);
  const [rushStartTime, setRushStartTime] = useState<number | null>(null);

  const [rushElapsed, setRushElapsed] = useState(0);
  const [rushTotalTime, setRushTotalTime] = useState<number | null>(null);

  const [gamesPlayed, setGamesPlayed] = useState(0);
  const [showRules, setShowRules] = useState(false);

  const [time, setTime] = useState(DEFAULT_TIME);

  const [used, setUsed] = useState<Set<string>>(new Set());

  const [letters, setLetters] = useState<Set<string>>(new Set());

  const [message, setMessage] = useState(
    "enter a word containing the letters.",
  );

  const [gameOver, setGameOver] = useState(false);

  const roundStartedAt = useRef(Date.now());

  const [answerTimes, setAnswerTimes] = useState<number[]>([]);

  const [missedPrompts, setMissedPrompts] = useState<
    {
      fragment: string;
      examples: string[];
    }[]
  >([]);

  // Effect 1, games-played counter. Runs once on mount (empty dependency list).
  // Calls loadGamesPlayed so the header shows the global total. No cleanup.
  useEffect(() => {
    loadGamesPlayed(setGamesPlayed);
  }, []);

  // Effect 2, stopwatch for rush, sixrush, alphabet, word change and the other
  // time-scored modes. Re-runs when gameOver, gameMode or rushStartTime changes.
  // Does nothing if the game is over, the mode isn't one of those, or
  // rushStartTime is null. Otherwise it sets rushElapsed to
  // (Date.now() - rushStartTime) / 1000, once right away and then every 100 ms.
  // Cleanup clears the interval.
  useEffect(() => {
    if (gameOver || !isRushMode(gameMode) || rushStartTime === null) {
      return;
    }

    const update = () => {
      setRushElapsed((Date.now() - rushStartTime) / 1000);
    };

    update();

    const id = window.setInterval(update, 100);

    return () => window.clearInterval(id);
  }, [gameOver, gameMode, rushStartTime]);

  // Effect 2b, anagram countdown. Re-runs when started, gameOver, gameMode or
  // rushStartTime changes. Does nothing unless an anagram game is running and
  // rushStartTime is set (anagram reuses it as the start time). Otherwise,
  // every 100 ms it sets anagramLeft to the seconds remaining out of
  // ANAGRAM_SECONDS (never below 0). When it reaches 0 it shows "time's up!"
  // and sets gameOver. Cleanup clears the interval.
  useEffect(() => {
    if (
      !started ||
      gameOver ||
      gameMode !== "anagram" ||
      rushStartTime === null
    ) {
      return;
    }

    const update = () => {
      const left = Math.max(
        0,
        ANAGRAM_SECONDS - (Date.now() - rushStartTime) / 1000,
      );

      setAnagramLeft(left);

      if (left <= 0) {
        setMessage("time's up!");
        setGameOver(true);
      }
    };

    update();

    const id = window.setInterval(update, 100);

    return () => window.clearInterval(id);
  }, [started, gameOver, gameMode, rushStartTime]);

  // Effect 3, per-word countdown (timed mode). Re-runs when started, gameOver,
  // gameMode, time or promptNonce changes. Does nothing if the game hasn't
  // started, is over, isn't timed, or time is 0 or below. Otherwise it schedules
  // one 1000 ms timeout that lowers `time` by one (never below 0). That change
  // re-runs the effect, which schedules the next tick. promptNonce is a
  // dependency so the countdown restarts when a new prompt appears even if
  // `time` is the same. Cleanup clears the timeout.
  // countdown: ticks `time` down once per second in timed mode
  useEffect(() => {
    if (!started || gameOver || gameMode !== "timed" || time <= 0) return;

    const id = window.setTimeout(() => {
      setTime((t) => Math.max(0, t - 1));
    }, 1000);

    return () => window.clearTimeout(id);
  }, [started, gameOver, gameMode, time, promptNonce]);

  // Effect 4, time ran out (timed mode). Re-runs when any of started, time,
  // gameOver, gameMode, prompt, promptExamples, difficulty, roundTime, lives,
  // score or shortenTimed changes. Does nothing unless the game is running in
  // timed mode and `time` is exactly 0. Then it records the missed prompt with
  // two example words (getRandomExamples) and shows "you could have put X or
  // Y" (or "time's up!" with no examples), clears the input, and takes a life.
  // At 0 lives it sets gameOver and stops. Otherwise it picks a new prompt,
  // bumps promptNonce, resets `time` (5 seconds if the speed-up is on and score
  // is 20 or more, otherwise roundTime), and restarts roundStartedAt. No cleanup.
  // time ran out: lose a life, show what could have been played, move on
  useEffect(() => {
    if (!started || gameOver || gameMode !== "timed" || time !== 0) {
      return;
    }

    const examples = getRandomExamples(promptExamples);

    setMissedPrompts((current) => [
      ...current,
      {
        fragment: prompt,
        examples,
      },
    ]);

    if (examples.length >= 2) {
      setMessage(`you could have put ${examples[0]} or ${examples[1]}.`);
    } else if (examples.length === 1) {
      setMessage(`you could have put ${examples[0]}.`);
    } else {
      setMessage("time's up!");
    }

    setInput("");

    const nextLives = lives - 1;
    setLives(nextLives);

    if (nextLives <= 0) {
      setGameOver(true);
      return;
    }

    if (gameMode === "startEnd") {
      setStartEndPrompt(pickStartEndPrompt(difficulty));
    } else if (isMathMode(gameMode)) {
      setMathPrompt(getNextMathPrompt());
    } else {
      const nextPrompt = pickPrompt(difficulty, gameMode);
      setPrompt(nextPrompt.fragment);
      setPromptExamples(nextPrompt.examples);
    }
    setPromptNonce((n) => n + 1);

    setTime(
      shortenTimed && score >= TIMED_SHORT_AFTER_WORDS_PER_PLAYER
        ? TIMED_SHORT_TIME
        : roundTime,
    );

    roundStartedAt.current = Date.now();
  }, [
    started,
    time,
    gameOver,
    gameMode,
    prompt,
    promptExamples,
    difficulty,
    roundTime,
    lives,
    score,
    shortenTimed,
  ]);

  // submit(event): takes a form event, returns nothing. The enter-key handler.
  // Does nothing if the game is over. It validates the lowercased, trimmed word
  // in order: minimum length (6 in sixrush, otherwise prompt length + 1),
  // letters only, present in a dictionary, contains the fragment, not already
  // used; the first failure sets a message and stops. On success it records the
  // answer time, adds the word to the used set, collects its letters, and adds 1
  // to the score. It then checks mode end conditions: 10 words for rush and
  // sixrush, 26 letters for alphabet (both save rushTotalTime and set gameOver).
  // If the game continues it picks the next prompt, bumps promptNonce, resets the
  // timed clock, restarts roundStartedAt, and when all 26 letters are collected
  // clears them (and gives an extra life in timed mode). Anagram and word change
  // use their own handlers below.
  const submit = (event: React.FormEvent) => {
    event.preventDefault();

    if (gameOver) return;

    const word = input.trim().toLowerCase();

    if (isMathMode(gameMode)) {
      if (!/^-?\d+$/.test(word)) {
        setMessage("enter a whole-number answer.");
        return;
      }
      if (Number(word) !== mathPrompt.answer) {
        setMessage("not quite. try again.");
        return;
      }
    }

    const minLength =
      gameMode === "sevenRush"
        ? Math.max(prompt.length + 1, 6)
        : prompt.length + 1;

    if (
      !isMathMode(gameMode) &&
      gameMode !== "startEnd" &&
      word.length < minLength
    ) {
      setMessage(`your word must be at least ${minLength} letters.`);
      return;
    }

    if (!isMathMode(gameMode) && !/^[a-z]+$/.test(word)) {
      setMessage("use letters only.");
      return;
    }

    if (
      !isMathMode(gameMode) &&
      gameMode !== "startEnd" &&
      !DICTIONARY.has(word) &&
      !MODERN_WORDS.has(word)
    ) {
      setMessage("that word isn't in the dictionary.");
      return;
    }

    if (gameMode === "startEnd") {
      if (word.length < 3) {
        setMessage("your word must be at least 3 letters long.");
        return;
      }
      if (!word.startsWith(startEndPrompt.start)) {
        setMessage(
          `your word must start with "${startEndPrompt.start.toUpperCase()}".`,
        );
        return;
      }
      if (!word.endsWith(startEndPrompt.end)) {
        setMessage(
          `your word must end with "${startEndPrompt.end.toUpperCase()}".`,
        );
        return;
      }
      if (!DICTIONARY.has(word) && !MODERN_WORDS.has(word)) {
        setMessage("that word isn't in the dictionary.");
        return;
      }
    } else if (!isMathMode(gameMode) && !word.includes(prompt)) {
      setMessage(`your word needs "${prompt.toUpperCase()}".`);
      return;
    }

    if (!isMathMode(gameMode) && used.has(word)) {
      setMessage("you already used that word.");
      return;
    }

    const answerTime = (Date.now() - roundStartedAt.current) / 1000;

    setAnswerTimes((current) => [...current, answerTime]);

    const nextUsed = new Set(used);
    nextUsed.add(word);

    const nextLetters = new Set(letters);

    for (const char of word.toUpperCase()) {
      if (ALPHABET.includes(char)) {
        nextLetters.add(char);
      }
    }

    setUsed(nextUsed);

    const nextScore = score + 1;
    setScore(nextScore);

    setInput("");

    if (isRushMode(gameMode) && gameMode !== "alphabet") {
      const nextRushWords = rushWords + 1;

      setRushWords(nextRushWords);

      if (nextRushWords >= rushTarget) {
        const totalTime = (Date.now() - (rushStartTime ?? Date.now())) / 1000;

        setRushTotalTime(totalTime);

        if (gameMode === "daily") {
          const record: DailyRecord = { date: todayKey(), time: totalTime };
          writeDaily(record);
          setDailyRecord(record);
        }
        setMessage(
          gameMode === "daily"
            ? "daily complete!"
            : gameMode === "sevenRush"
              ? "sixrush complete!"
              : gameMode === "startEnd"
                ? "start/end complete!"
                : isMathMode(gameMode)
                  ? "math challenge complete!"
                  : "rush complete!",
        );
        setGameOver(true);
        return;
      }
    }

    if (gameMode === "alphabet") {
      if (nextLetters.size === 26) {
        const totalTime = (Date.now() - (rushStartTime ?? Date.now())) / 1000;

        setRushTotalTime(totalTime);
        setLetters(nextLetters);
        setMessage("a–z complete!");
        setGameOver(true);
        return;
      }
    }

    if (gameMode === "startEnd") {
      setStartEndPrompt(pickStartEndPrompt(difficulty));
    } else if (isMathMode(gameMode)) {
      setMathPrompt(getNextMathPrompt());
    } else {
      const nextPrompt =
        gameMode === "daily"
          ? (dailyPromptsRef.current[nextScore] ??
            pickPrompt(difficulty, gameMode))
          : pickPrompt(difficulty, gameMode);
      setPrompt(nextPrompt.fragment);
      setPromptExamples(nextPrompt.examples);
    }
    setPromptNonce((n) => n + 1);

    if (gameMode === "timed") {
      const nextTimedTime =
        shortenTimed && nextScore >= TIMED_SHORT_AFTER_WORDS_PER_PLAYER
          ? TIMED_SHORT_TIME
          : roundTime;
      setTime(nextTimedTime);
    }

    roundStartedAt.current = Date.now();

    if (nextLetters.size === 26) {
      setLetters(new Set());

      if (gameMode === "timed") {
        setLives((value) => value + 1);
        setMessage("a–z complete! you gained a life.");
      } else {
        setMessage("a–z complete!");
      }
    } else {
      setLetters(nextLetters);
      setMessage("good word!");
    }
  };

  // submitAnagram(event): takes a form event, returns nothing. The enter-key
  // handler for anagram mode. Ignored once the game is over or the clock is at
  // 0. Validates the word in order: letters only, at least ANAGRAM_MIN_LENGTH
  // long, every character is one of the 7 letters (repeats allowed), in a
  // dictionary, not already used; the first failure sets a message and stops.
  // On success it scores the word as (length - 2), plus 7 if it uses all 7
  // letters (a pangram), records the answer time, adds the word to `used`, and
  // adds the points to `score`. The game ends from the countdown effect, not here.
  const submitAnagram = (event: React.FormEvent) => {
    event.preventDefault();

    if (gameOver || anagramLeft <= 0) return;

    const word = input.trim().toLowerCase();

    if (!/^[a-z]+$/.test(word)) {
      setMessage("use letters only.");
      return;
    }

    if (word.length < ANAGRAM_MIN_LENGTH) {
      setMessage(`your word must be at least ${ANAGRAM_MIN_LENGTH} letters.`);
      return;
    }

    for (const char of word) {
      if (!anagramLetters.includes(char)) {
        setMessage(`"${char.toUpperCase()}" isn't one of the letters.`);
        return;
      }
    }

    if (!isValidWord(word)) {
      setMessage("that word isn't in the dictionary.");
      return;
    }

    if (used.has(word)) {
      setMessage("you already used that word.");
      return;
    }

    const pangram = [...anagramLetters].every((char) => word.includes(char));
    const points = word.length - 2 + (pangram ? 7 : 0);

    setAnswerTimes((current) => [
      ...current,
      (Date.now() - roundStartedAt.current) / 1000,
    ]);
    roundStartedAt.current = Date.now();

    setUsed((current) => new Set(current).add(word));
    setScore((current) => current + points);
    setInput("");
    setMessage(pangram ? `pangram! +${points}` : `+${points}`);
  };

  // submitWordChange(event): takes a form event, returns nothing. The enter-key
  // handler for word change mode. Ignored once the game is over. The word must
  // be the same length as the current word, differ by exactly one letter, be in
  // a dictionary, and not already be in the chain (start word included); the
  // first failure sets a message and stops. A valid step is added to wcChain. If
  // the step is the target word, it saves rushTotalTime (the final time), adds 1
  // to score and sets gameOver.
  const submitWordChange = (event: React.FormEvent) => {
    event.preventDefault();

    if (gameOver) return;

    const word = input.trim().toLowerCase();
    const current = wcChain[wcChain.length - 1] ?? wcStart;

    if (!/^[a-z]+$/.test(word)) {
      setMessage("use letters only.");
      return;
    }

    if (word.length !== current.length) {
      setMessage(`use a ${current.length}-letter word.`);
      return;
    }

    let diff = 0;
    for (let i = 0; i < word.length; i++) if (word[i] !== current[i]) diff++;

    if (diff === 0) {
      setMessage("that's the same word.");
      return;
    }

    if (diff > 1) {
      setMessage("change exactly one letter.");
      return;
    }

    if (!isValidWord(word)) {
      setMessage("that word isn't in the dictionary.");
      return;
    }

    if ([wcStart, ...wcChain].includes(word)) {
      setMessage("you already used that word.");
      return;
    }

    setAnswerTimes((existing) => [
      ...existing,
      (Date.now() - roundStartedAt.current) / 1000,
    ]);
    roundStartedAt.current = Date.now();

    setInput("");

    if (word !== wcEnd) {
      setWcChain((chain) => [...chain, word]);
      setMessage("good, keep going.");
      return;
    }

    // target reached: stop the stopwatch and end the run
    setRushTotalTime((Date.now() - (rushStartTime ?? Date.now())) / 1000);
    setScore((value) => value + 1);
    setMessage("ladder complete!");
    setGameOver(true);
  };

  // goToStart(): takes nothing, returns nothing. Called when the title is
  // clicked. Turns off started and gameOver and clears the message, input, used
  // words, collected letters, score and the rush timers, so the start screen
  // shows with a clean slate.
  const goToStart = () => {
    setStarted(false);
    setGameOver(false);
    setMessage("");
    setInput("");
    setUsed(new Set());
    setLetters(new Set());
    setScore(0);
    setRushWords(0);
    setRushElapsed(0);
    setRushTotalTime(null);
    setRushStartTime(null);
  };

  // finishGame(): takes nothing, returns nothing. Sets gameOver to true, but only
  // in zen mode and only if the game isn't already over. Zen has no timer or
  // lives, so this button is the only way to end a zen run.
  const finishGame = () => {
    if (gameMode !== "zen" || gameOver) return;

    setGameOver(true);
  };

  // focusWordInput(): takes nothing, returns nothing. Waits one tick with
  // setTimeout so the input exists after React has rendered, then calls focus()
  // on the element stored in wordInputRef.
  const focusWordInput = () => {
    window.setTimeout(() => wordInputRef.current?.focus(), 0);
  };
  // Saves a qualifying run as "anonymous" when the player closes the name modal
  // (or starts a new game) without submitting a name.
  const saveAnonymously = (run: NonNullable<typeof pendingRun>) =>
    submitScore(
      run.runId,
      run.mode,
      run.difficulty,
      run.roundTime,
      run.score,
      "anonymous",
      "#676767",
    )
      .then(() => setBoardRefresh((n) => n + 1))
      .catch((error) => console.error("ANON SAVE ERROR:", error));

  const handleLeaderboardClose = () => {
    if (pendingRun) void saveAnonymously(pendingRun);
    setPendingRun(null);
  };
  // startGame(): takes nothing, returns nothing. Begins a new run with the
  // current settings. Bumps the global counter, creates a new runIdRef UUID for
  // the leaderboard, and clears pendingRun and highlightRanks. Picks the first
  // prompt (7 letters for anagram, a start/target pair for word change) and
  // resets input, lives (to timedLives), score, rush values, used words,
  // letters, answer times, missed prompts and the message. Sets the clock to
  // roundTime for timed mode (0 otherwise) and the anagram clock to
  // ANAGRAM_SECONDS, sets gameOver false and started true, records
  // roundStartedAt, focuses the input, and for rush-style modes and anagram
  // saves rushStartTime so the matching clock effect runs.
  const startGame = () => {
    if (gameMode === "daily") {
      const existing = readDaily();
      if (existing) {
        setDailyRecord(existing);
        return;
      }
      const record: DailyRecord = { date: todayKey(), time: null };
      writeDaily(record); // marked as played the moment it starts
      setDailyRecord(record);
      dailyPromptsRef.current = buildDailyPrompts(todayKey());
    }

    countGamePlayed(setGamesPlayed);

    runIdRef.current = crypto.randomUUID();

    if (pendingRun) void saveAnonymously(pendingRun);
    setPendingRun(null);
    setHighlightRanks({ alltime: null, daily: null });

    const startingLives = timedLives;

    mathPromptHistoryRef.current.clear();
    const now = Date.now();

    if (gameMode === "anagram") {
      const nextAnagram = makeAnagramPrompt();
      setAnagramLetters(nextAnagram.fragment);
      setPromptExamples(nextAnagram.examples);
    } else if (gameMode === "wordChange") {
      // no difficulty picker for this mode: always the 4-letter, short ladders
      const ladder = makeWordChangePrompt("superEasy");
      const [ladderStart, ladderEnd = ""] = ladder.fragment.split("-");
      setWcStart(ladderStart);
      setWcEnd(ladderEnd);
      setWcChain([]);
      setPromptExamples(ladder.examples);
    } else if (gameMode === "startEnd") {
      setStartEndPrompt(pickStartEndPrompt(difficulty));
    } else if (isMathMode(gameMode)) {
      setMathPrompt(getNextMathPrompt());
    } else {
      const nextPrompt =
        gameMode === "daily"
          ? dailyPromptsRef.current[0]
          : pickPrompt(difficulty, gameMode);
      setPrompt(nextPrompt.fragment);
      setPromptExamples(nextPrompt.examples);
    }
    setPromptNonce((n) => n + 1);
    setInput("");
    setLives(startingLives);
    setScore(0);
    setRushWords(0);
    setRushElapsed(0);
    setRushTotalTime(null);
    setAnagramLeft(ANAGRAM_SECONDS);

    if (gameMode === "timed") {
      setTime(roundTime);
    } else {
      setTime(0);
    }

    setUsed(new Set());
    setLetters(new Set());
    setAnswerTimes([]);
    setMissedPrompts([]);
    setMessage(
      gameMode === "anagram"
        ? "make words using only the letters."
        : gameMode === "wordChange"
          ? "change one letter at a time."
          : gameMode === "startEnd"
            ? "enter a word matching both ends."
            : isMathMode(gameMode)
              ? "solve the equation."
              : "enter a word containing the letters.",
    );
    setGameOver(false);
    setStarted(true);

    roundStartedAt.current = now;
    focusWordInput();

    if (isRushMode(gameMode) || gameMode === "anagram") {
      setRushStartTime(now);
    } else {
      setRushStartTime(null);
    }
  };

  // handleLeaderboardSubmit(name, color): takes the player's chosen name and
  // colour, returns a Promise that resolves to nothing. Does nothing if there is
  // no pendingRun. Saves the pending run with submitScore, then fetches its
  // all-time and daily ranks in parallel (only for boards it qualified for;
  // errors become null). Finally it switches gameMode and difficulty to the
  // run's values, stores the ranks in highlightRanks so the matching rows are
  // highlighted, bumps boardRefresh so the boards reload, and clears pendingRun
  // to close the modal.
  const handleLeaderboardSubmit = async (name: string, color: string) => {
    if (!pendingRun) return;

    await submitScore(
      pendingRun.runId,
      pendingRun.mode,
      pendingRun.difficulty,
      pendingRun.roundTime,
      pendingRun.score,
      name,
      color,
    );

    const [allTimeRank, dailyRank] = await Promise.all([
      pendingRun.allTime
        ? getRunRank(pendingRun.runId, "alltime").catch(() => null)
        : null,
      pendingRun.daily
        ? getRunRank(pendingRun.runId, "daily").catch(() => null)
        : null,
    ]);

    setGameMode(
      pendingRun.mode === "mathEasy" || pendingRun.mode === "mathMed"
        ? "math"
        : pendingRun.mode,
    );
    setDifficulty(pendingRun.difficulty);
    setHighlightRanks({
      alltime: allTimeRank,
      daily: dailyRank,
    });
    setBoardRefresh((n) => n + 1);
    setPendingRun(null);
  };

  // reset(): takes nothing, returns nothing. Calls startGame() and then
  // focusWordInput(). Used by the restart (⟳) and play-again buttons.
  const reset = () => {
    startGame();
    focusWordInput();
  };

  // Effect 5, qualify for the leaderboard (ranked games). Re-runs when gameOver,
  // started, gameMode, difficulty, roundTime, score or rushTotalTime changes.
  // Does nothing unless the game is over, started and in a ranked mode (not
  // zen, anagram or word change), there is a run id, and (for rush-style modes)
  // rushTotalTime is set.
  // Clears runIdRef so it runs only once per game, then computes the final score
  // (rounded milliseconds for rush modes, word count for timed) and the
  // round-time argument (only for timed). Asks wouldQualify about the all-time
  // and daily boards in parallel. If either qualifies it sets pendingRun, which
  // opens the name modal. If neither does, it saves the score as "anonymous"
  // with colour #676767 so percentiles stay accurate. Errors are logged. No
  // cleanup.
  useEffect(() => {
    const rankedMode = leaderboardModeFor(gameMode, difficulty);
    if (!gameOver || !started || !rankedMode) return;

    const runId = runIdRef.current;
    if (!runId) return;

    const isRush = isRushMode(gameMode);

    if (isRush && rushTotalTime === null) {
      return;
    }

    runIdRef.current = null;

    const finalScore = isRush ? Math.round((rushTotalTime ?? 0) * 1000) : score;

    const roundTimeArg = gameMode === "timed" ? roundTime : null;

    Promise.all([
      wouldQualify(rankedMode, difficulty, roundTimeArg, finalScore, "alltime"),
      wouldQualify(rankedMode, difficulty, roundTimeArg, finalScore, "daily"),
    ])
      .then(async ([allTime, daily]) => {
        if (allTime || daily) {
          setPendingRun({
            runId,
            mode: rankedMode,
            difficulty,
            roundTime: roundTimeArg,
            score: finalScore,
            allTime,
            daily,
          });

          return;
        }

        await submitScore(
          runId,
          rankedMode,
          difficulty,
          roundTimeArg,
          finalScore,
          "anonymous",
          "#676767",
        );

        console.log("NON-QUALIFYING SCORE SAVED:", finalScore);
      })
      .catch((error) => {
        console.error("LEADERBOARD QUALIFY ERROR:", error);
      });
  }, [
    gameOver,
    started,
    gameMode,
    difficulty,
    roundTime,
    score,
    rushTotalTime,
  ]);

  // Effect 6, percentile (ranked games). Same dependencies as effect 5. Does
  // nothing unless the game is over, started and ranked, and (for rush-style
  // modes) rushTotalTime is set. Computes the same final score, sets
  // percentileLoading and clears the old percentile, then calls
  // getScorePercentile. On success it stores percentile and percentileTotal (or
  // clears them if the result is empty). On failure it logs the error and clears
  // both. percentileLoading is reset either way. No cleanup.
  useEffect(() => {
    const rankedMode = leaderboardModeFor(gameMode, difficulty);
    if (!gameOver || !started || !rankedMode) return;

    const finalScore = isRushMode(gameMode)
      ? Math.round((rushTotalTime ?? 0) * 1000)
      : score;

    if (
      isRushMode(gameMode) && rushTotalTime === null
    ) {
      return;
    }

    const roundTimeArg = gameMode === "timed" ? roundTime : null;

    setPercentileLoading(true);
    setPercentile(null);
    setPercentileTotal(0);

    getScorePercentile(rankedMode, difficulty, roundTimeArg, finalScore)
      .then((result) => {
        if (!result) {
          setPercentile(null);
          setPercentileTotal(0);
          return;
        }

        setPercentile(result.percentile);
        setPercentileTotal(result.total_scores);
      })
      .catch((error) => {
        console.error("PERCENTILE ERROR:", error);
        setPercentile(null);
        setPercentileTotal(0);
      })
      .finally(() => {
        setPercentileLoading(false);
      });
  }, [
    gameOver,
    started,
    gameMode,
    difficulty,
    roundTime,
    score,
    rushTotalTime,
  ]);

  // Effect 7, spacebar starts or restarts a game. Re-runs when started,
  // gameOver, showRules, showLeaderboard, pendingRun, screen, gameMode,
  // difficulty, roundTime or timedLives changes (the long list keeps
  // handleSpacebar from seeing stale settings). Does nothing unless screen is
  // "solo". Adds a keydown listener on window. On Space (not a held key), if no
  // rules/leaderboard modal or submit modal is open and focus isn't in an input,
  // textarea, select, button or editable element, and the game isn't running, it
  // prevents the page from scrolling and calls startGame(). The credits modal is
  // not part of the modal check. Cleanup removes the listener.
  useEffect(() => {
    if (screen !== "solo") return;

    const handleSpacebar = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;

      if (showRules || showLeaderboard || pendingRun) return;

      const target = event.target as HTMLElement | null;

      if (
        target &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName))
      ) {
        return;
      }

      if (!started || gameOver) {
        event.preventDefault();
        startGame();
      }
    };

    window.addEventListener("keydown", handleSpacebar);

    return () => {
      window.removeEventListener("keydown", handleSpacebar);
    };
  }, [
    started,
    gameOver,
    showRules,
    showLeaderboard,
    pendingRun,
    screen,
    gameMode,
    difficulty,
    roundTime,
    timedLives,
  ]);

  // hearts: a string such as "♥♥♥" built from `lives` (minimum zero hearts),
  // memoized so it only recomputes when lives changes.
  const hearts = useMemo(() => "♥".repeat(Math.max(0, lives)), [lives]);

  // averageTime: the mean of answerTimes in seconds, or 0 if none were answered.
  const averageTime =
    answerTimes.length > 0
      ? answerTimes.reduce((sum, value) => sum + value, 0) / answerTimes.length
      : 0;

  // renderDifficulty(): takes nothing, returns JSX. Draws the difficulty picker:
  // maps over DIFFICULTY_OPTIONS to make one button each, highlights the
  // selected one, and calls setDifficulty on click. It is a function so the
  // start screen and results screen can both reuse it. In modes where
  // difficulty does nothing (noDifficultyMode: anagram, word change, daily) the
  // buttons are disabled, dimmed and show no selection. The stored difficulty is
  // left alone, so it comes back when you switch to another mode.
  const renderDifficulty = () => (
    // DIFFICULTY PICKER: easy/hard changes word-pool difficulty for word modes
    // and switches math between one-digit answers and harder calculations.
    <div className="setting">
      <small>difficulty</small>

      <div
        className="option-grid"
        style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)" }}
      >
        {DIFFICULTY_OPTIONS.map((option) => (
          <button
            type="button"
            key={option.value}
            disabled={noDifficultyMode(gameMode)}
            style={noDifficultyMode(gameMode) ? { opacity: 0.4 } : undefined}
            className={
              !noDifficultyMode(gameMode) && difficulty === option.value
                ? "option selected"
                : "option"
            }
            onClick={() => setDifficulty(option.value)}
          >
            {/* Button text: the option name in bold, with a small hint line under it */}
            <strong>{option.label}</strong>
            <span>
              {isMathMode(gameMode)
                ? option.value === "superEasy"
                  ? "answers up to 99"
                  : "harder calculations"
                : gameMode === "startEnd"
                  ? option.value === "hard"
                    ? "80-800 matching words"
                    : "800+ matching words"
                  : option.hint}
            </span>
          </button>
        ))}
      </div>
    </div>
  );

  // renderMode(): takes nothing, returns JSX. Draws the mode picker and the
  // multiplayer button. Buttons sit on a three-column grid; clicking a mode
  // calls setGameMode, and the multiplayer button calls setScreen("group").
  const renderMode = () => (
    // MODE PICKER: a "mode" label, then a grid of mode buttons (rush, sixrush,
    // timed, alphabet, zen, start/end, math, daily, anagram, word change), then
    // a full-width multiplayer button.
    <div className="setting">
      <small>mode</small>

      {/* Three-column grid keeps the expanded mode list readable. */}
      <div
        className="option-grid mode-options"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
        }}
      >
        {MODE_OPTIONS.map((option) => (
          <button
            type="button"
            key={option.value}
            className={gameMode === option.value ? "option selected" : "option"}
            onClick={() => setGameMode(option.value)}
          >
            {/* Mode name in bold with a short description under it */}
            <strong>{option.label}</strong>
            <span>{option.hint}</span>
          </button>
        ))}
      </div>

      {/* Multiplayer button: leaves the solo screen and opens the group game */}
      <button
        type="button"
        className="option group-mode-button"
        onClick={() => setScreen("group")}
      >
        <strong>multiplayer</strong>
        <span>race friends to 20 words</span>
      </button>
    </div>
  );

  // renderTimedLives(): takes nothing, returns JSX. Draws the lives picker (1 to
  // 5) for timed mode. Clicking a number sets timedLives and also switches the
  // mode to timed, since the setting only matters there. Highlighted when timed
  // mode is active and that number is chosen.
  const renderTimedLives = () => (
    // LIVES PICKER (timed mode only): a "lives" label with one button per option
    // (1–5), each showing the number and a heart.
    <div className="setting">
      <small>lives</small>
      <div className="option-grid time-options">
        {TIMED_LIFE_OPTIONS.map((value) => (
          <button
            type="button"
            key={value}
            className={
              gameMode === "timed" && timedLives === value
                ? "option selected"
                : "option"
            }
            onClick={() => {
              setTimedLives(value);
              setGameMode("timed");
            }}
          >
            <strong>{value}</strong>
            <span>♥</span>
          </button>
        ))}
      </div>
    </div>
  );

  // renderTimedSpeedup(): takes nothing, returns JSX. Draws the on/off toggle
  // for the timed-mode speed-up. Clicking it flips shortenTimed, which controls
  // whether the per-word time drops to 5 seconds after 20 prompts.
  const renderTimedSpeedup = () => (
    // SPEED-UP TOGGLE (timed mode only): a single button showing "on" or "off"
    // and the rule it controls ("after 20 prompts → 5s"). Highlighted when on.
    <div className="setting">
      <small>speed up after</small>
      <button
        type="button"
        className={shortenTimed ? "option selected" : "option"}
        onClick={() => setShortenTimed((value) => !value)}
      >
        <strong>{shortenTimed ? "on" : "off"}</strong>
        <span>
          after {TIMED_SHORT_AFTER_WORDS_PER_PLAYER} prompts →{" "}
          {TIMED_SHORT_TIME}s
        </span>
      </button>
    </div>
  );

  // renderTime(): takes nothing, returns JSX. Draws the seconds-per-word picker
  // (5, 10, 20, 60) for timed mode. Choosing a value sets roundTime and also
  // switches the mode to timed.
  const renderTime = () => (
    // TIME-PER-WORD PICKER (timed mode only): a "time per word" label with one
    // button per duration. Highlighted when timed mode is active and that
    // duration is selected.
    <div className="setting">
      <small>time per word</small>

      <div className="option-grid time-options">
        {TIME_OPTIONS.map((seconds) => (
          <button
            type="button"
            key={seconds}
            className={
              gameMode === "timed" && roundTime === seconds
                ? "option selected"
                : "option"
            }
            onClick={() => {
              setRoundTime(seconds);
              setGameMode("timed");
            }}
          >
            <strong>{seconds}s</strong>
          </button>
        ))}
      </div>
    </div>
  );

  // MULTIPLAYER SCREEN: when the player picks multiplayer, the solo UI is
  // replaced by just the header (clickable title that returns to solo) and the
  // GroupGame component.
  if (screen === "group") {
    return (
      <main>
        <header>
          {/* Title "WORDTIMER BETA" (click to go back to the solo screen) */}
          <div className="game-title" onClick={() => setScreen("solo")}>
            <b>WORDTIMER</b>
            <span> BETA</span>
          </div>
        </header>

        {/* The multiplayer game: menu, lobby, countdown, race and results all
            live inside this component */}
        <GroupGame
          onExit={() => setScreen("solo")}
          makePrompts={makeGroupPrompts}
          isValidWord={isValidWord}
        />
      </main>
    );
  }

  // SOLO SCREEN: everything below is the normal single-player UI.
  return (
    <main className={started && !gameOver ? "playing" : undefined}>
      {/* HEADER BAR: the title on the left, live stats on the right */}
      <header>
        {/* Title "WORDTIMER BETA". Clicking it resets everything and returns to
            the start screen */}
        <div className="game-title" onClick={goToStart}>
          <b>WORDTIMER</b>
          <span> BETA</span>
        </div>

        {/* Stats row shown in the header */}
        <div className="stats">
          {/* Global counter: total games played by all users, with thousands
              separators (always visible) */}
          <span>
            total games played by all users{" "}
            <strong>{gamesPlayed.toLocaleString()}</strong>
          </span>

          {/* The stats below only appear once a game has started */}
          {started && (
            <>
              {/* Current score (number of correct words this run) */}
              <span>
                score <strong>{score}</strong>
              </span>

              {/* Timed mode only: remaining lives as a row of hearts ("—" if none) */}
              {gameMode === "timed" && (
                <span className="lives">{hearts || "—"}</span>
              )}

              {/* Rush / sixrush / alphabet / word change etc.: live stopwatch with one decimal */}
              {isRushMode(gameMode) && (
                <span className="timer2">{rushElapsed.toFixed(1)}s</span>
              )}
            </>
          )}
        </div>
      </header>

      {/* RULES MODAL (shown when the "?" button is pressed): a dark overlay with
          a centred card. Clicking the overlay closes it; clicking inside the card
          does not (stopPropagation). */}
      {showRules && (
        <div className="rules-overlay" onClick={() => setShowRules(false)}>
          <div
            className="rules-modal"
            onClick={(event) => event.stopPropagation()}
          >
            {/* Close (×) button in the corner of the modal */}
            <button
              type="button"
              className="rules-close"
              onClick={() => setShowRules(false)}
            >
              ×
            </button>

            {/* Modal heading: small "how to play" label and the title */}
            <small>how to play</small>

            <h2>rules & instructions</h2>

            {/* General rule: find a word containing the fragment, longer than it,
                in the dictionary, no repeats */}
            <p>
              find a word containing the letters/substring shown on screen. your
              word must be at least 1 letter longer than the fragment. words
              must be in the dictionary and cannot be repeated.
            </p>

            {/* Rules for timed mode (per-word clock, lives, A–Z bonus life, speed-up) */}
            <div className="rules-section">
              <strong>timed</strong>

              <p>
                you have the selected amount of time to find a word. running out
                of time costs a life. collect all 26 letters to gain an extra
                life. after 20 prompts, the timer can shorten to 5 seconds.
                wrong words do not cost a life.
              </p>
            </div>

            {/* Rules for rush mode (10 words, fastest total time) */}
            <div className="rules-section">
              <strong>rush</strong>

              <p>
                complete 10 words as quickly as possible. there is no timer per
                word. your final time is your score.
              </p>
            </div>

            {/* Rules for sixrush mode (rush, but every word must be 6+ letters) */}
            <div className="rules-section">
              <strong>sixrush</strong>

              <p>
                complete 10 words as quickly as possible, but every word must be
                at least 6 letters long. your final time is your score.
              </p>
            </div>

            {/* Rules for alphabet mode (keep going until all 26 letters are used) */}
            <div className="rules-section">
              <strong>alphabet</strong>

              <p>keep filling in words until you get all 26 letters</p>
            </div>

            {/* Rules for daily mode */}
            <div className="rules-section">
              <strong>daily</strong>

              <p>
                the same 5 prompts for everyone each day (resets at midnight
                UTC). you only get one attempt per device. fastest time wins
                and daily scores are ranked.
              </p>
            </div>

            {/* Rules for anagram mode (7 letters, countdown, points per word) */}
            <div className="rules-section">
              <strong>anagram</strong>

              <p>
                you get 7 letters and {ANAGRAM_SECONDS} seconds. make as many
                words as you can using only those letters (repeats allowed).
                each word scores its length minus 2, and using all 7 letters
                gives +7. highest score wins and anagram scores are ranked.
              </p>
            </div>

            {/* Rules for word change mode (one ladder, fastest time) */}
            <div className="rules-section">
              <strong>word change</strong>

              <p>
                turn the first word into the target word by changing one letter
                at a time. every step must be a real word. one ladder, and your
                final time is your score. fastest time wins and word change
                scores are ranked.
              </p>
            </div>

            {/* Rules for zen mode (no timer, no lives, not ranked) */}
            <div className="rules-section">
              <strong>zen</strong>

              <p>
                play without a timer or lives. finish whenever you want. zen
                runs are not ranked.
              </p>
            </div>

            {/* Rules for multiplayer (share a code, same letters, first to 20 wins) */}
            <div className="rules-section">
              <strong>BETA multiplayer</strong>

              <p>
                create a game and share the code with friends. everyone gets the
                same letters, and the first player to finish 20 words wins.
              </p>
            </div>

            {/* Explains when the daily leaderboard resets */}
            <div className="rules-section">
              {/* rules modal */}
              <strong>3-day leaderboard</strong>
              <p>scores stay on the 3-day leaderboard for 3 days. all-time scores are kept.</p>

            </div>
          </div>
        </div>
      )}
      {/* CREDITS MODAL (opened from the "credits" button on the start screen):
          same overlay + card pattern as the rules modal. */}
      {showCredits && (
        <div className="rules-overlay" onClick={() => setShowCredits(false)}>
          <div
            className="rules-modal"
            onClick={(event) => event.stopPropagation()}
          >
            {/* Close (×) button */}
            <button
              type="button"
              className="rules-close"
              onClick={() => setShowCredits(false)}
            >
              ×
            </button>

            <h2>credits</h2>

            {/* The creator's name */}
            <div className="rules-section">
              <strong>created by</strong>
              <p>Bryce Wan</p>
            </div>

            {/* Names of the lead playtesters */}
            <div className="rules-section">
              <strong>lead playtesters</strong>
              <p>
                Alex Tybon, Mrs. Denna, Micah Park, Adam Feng, Mr. Hays, Sathvik
                Loka
              </p>
            </div>

            {/* Names of the other playtesters */}
            <div className="rules-section">
              <strong>playtesters</strong>
              <p>
                Shiven Venigalla, Pritvi Aiyar, Jiya Saraiya, Parthiv Mudragada,
                Allison Hadcock, Kyle Bellinder, David Moore, Mr. Grattoni,
                Siddharth Kadiyala, Chloe Kim, Himal Harilal, Aranab Piya,
                Aayush Bennur, Amar Osman, Rishab Burri
              </p>
            </div>
          </div>
        </div>
      )}
      {/* LEADERBOARD MODAL (opened from "view leaderboard" on the start screen):
          lets the player browse the top scores for the currently selected mode and
          difficulty. */}
      {showLeaderboard && (
        <div
          className="rules-overlay"
          onClick={() => setShowLeaderboard(false)}
        >
          <div
            className="rules-modal"
            onClick={(event) => event.stopPropagation()}
          >
            {/* Close (×) button */}
            <button
              type="button"
              className="rules-close"
              onClick={() => setShowLeaderboard(false)}
            >
              ×
            </button>

            <small>leaderboards</small>

            <h2>view leaderboard</h2>

            {/* Period tabs: switch between the all-time and daily boards */}
            <div
              className="option-grid"
              style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)" }}
            >
              <button
                type="button"
                className={
                  boardPeriod === "alltime" ? "option selected" : "option"
                }
                onClick={() => setBoardPeriod("alltime")}
              >
                <strong>all-time</strong>
              </button>

              <button
                type="button"
                className={
                  boardPeriod === "daily" ? "option selected" : "option"
                }
                onClick={() => setBoardPeriod("daily")}
              >
                {/* leaderboard modal tab */}
                <strong>3-day</strong>
                <span>scores last 3 days</span>
              </button>
            </div>

            {/* Board contents: zen has no leaderboard key and shows a "not ranked"
                notice, any other mode shows the
                leaderboard table for the chosen period */}
            {!leaderboardModeFor(gameMode, difficulty) ? (
              <p>
                this mode isn't ranked. pick another mode to view its
                leaderboard.
              </p>
            ) : (
              <Leaderboard
                mode={leaderboardModeFor(gameMode, difficulty)!}
                difficulty={difficulty}
                roundTime={gameMode === "timed" ? roundTime : null}
                period={boardPeriod}
                refreshKey={boardRefresh}
              />
            )}
          </div>
        </div>
      )}

      {/* MAIN CARD: the big central panel. It shows one of three views depending
          on state: START SCREEN (not started), RESULTS SCREEN (game over), or the
          ACTIVE GAME (otherwise). */}
      <section className="card">
        {!started ? (
          <div className="start-screen">
            {/* START SCREEN: intro heading explaining the game */}
            <div className="results-header">
              <small>how to play</small>

              <h2>wordtimer</h2>

              <p>find words containing the letters shown on screen.</p>
            </div>

            <div className="divider" />

            {/* New-game settings: difficulty, mode and (for timed) extra options */}
            <div className="new-game-settings">
              {/* Section title with a "?" button that opens the rules modal */}
              <div className="settings-title">
                <small>new game</small>

                <h2>
                  choose your settings
                  <button
                    type="button"
                    className="rules-button"
                    onClick={() => setShowRules(true)}
                  >
                    ?
                  </button>
                </h2>
              </div>

              {/* Difficulty buttons (easy / hard) */}
              {renderDifficulty()}

              {/* Mode buttons plus the multiplayer button */}
              {renderMode()}

              {/* Timed-only settings: time per word, lives, and the speed-up toggle */}
              {gameMode === "timed" && (
                <>
                  {renderTime()}
                  {renderTimedLives()}
                  {renderTimedSpeedup()}
                </>
              )}

              {/* Main call-to-action: starts the game (spacebar also works) */}
              <button
                type="button"
                className="play-again start-button"
                onClick={startGame}
                disabled={dailyLocked}
              >
                {dailyLocked
                  ? dailyRecord?.time != null
                    ? `today's time: ${dailyRecord.time.toFixed(2)}s · back tomorrow`
                    : "already played today · back tomorrow"
                  : "start game (space)"}
              </button>

              {/* Opens the leaderboard modal */}
              <button
                type="button"
                className="lb-skip"
                onClick={() => setShowLeaderboard(true)}
              >
                view leaderboard
              </button>
              {/* Opens the credits modal */}
              <button
                type="button"
                className="lb-skip"
                onClick={() => setShowCredits(true)}
              >
                credits
              </button>
            </div>
          </div>
        ) : gameOver ? (
          <div className="results-screen">
            {/* RESULTS SCREEN: headline result. The small label says "run
                complete" for rush-style/zen modes or "game over" for timed and
                anagram. */}
            <div className="results-header">
              <small>
                {gameMode === "zen" ||
                  gameMode === "daily" ||
                  gameMode === "rush" ||
                  gameMode === "alphabet" ||
                  gameMode === "sevenRush" ||
                  gameMode === "startEnd" ||
                  gameMode === "wordChange" ||
                  isMathMode(gameMode)
                  ? "run complete"
                  : "game over"}
              </small>

              {/* Big number: final time in seconds (rush-style) or final score
                  (word count for timed, points for anagram) */}
              <h2>
                {isRushMode(gameMode) ? rushTotalTime?.toFixed(2) : score}
              </h2>

              {/* Unit label under the big number */}
              <p>
                {isRushMode(gameMode)
                  ? "seconds"
                  : gameMode === "anagram"
                    ? "points"
                    : "words this run"}
              </p>
            </div>

            {/* Row of stat boxes summarising the run */}
            <div className="final-stats">
              {/* Percentile box (ranked modes only): "calculating...", then
                  "better than X% of runs" with the sample size, or a message if
                  there aren't enough scores yet */}
              {gameMode !== "zen" &&
                leaderboardModeFor(gameMode, difficulty) && (
                  <div className="percentile-box">
                    <small>your performance</small>

                    {percentileLoading ? (
                      <strong>calculating...</strong>
                    ) : percentile !== null && percentileTotal > 0 ? (
                      <>
                        <strong>better than {percentile}% of runs</strong>
                        <span>
                          Compared with {percentileTotal.toLocaleString()}{" "}
                          scores
                        </span>
                      </>
                    ) : (
                      <span>
                        Not enough scores to calculate a percentile yet.
                      </span>
                    )}
                  </div>
                )}
              {/* Average seconds per correct answer ("—" if none were answered) */}
              <div className="stat-box">
                <small>average time</small>

                <strong>
                  {answerTimes.length > 0 ? `${averageTime.toFixed(1)}s` : "—"}
                </strong>
              </div>

              {/* How many prompts were answered correctly */}
              <div className="stat-box">
                <small>answered</small>

                <strong>{answerTimes.length}</strong>
              </div>

              {/* How many prompts were missed (timed mode runs out of time) */}
              <div className="stat-box">
                <small>missed</small>

                <strong>{missedPrompts.length}</strong>
              </div>
            </div>

            {/* Missed prompts list: each row shows the fragment in caps and two
                words that would have worked */}
            {missedPrompts.length > 0 && (
              <div className="missed">
                <small>missed prompts</small>

                {missedPrompts.map((missed, index) => (
                  <div
                    className="missed-item"
                    key={`${missed.fragment}-${index}`}
                  >
                    <strong>{missed.fragment.toUpperCase()}</strong>

                    <span>
                      you could have put {missed.examples.join(" or ")}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Shown instead of the list when nothing was missed */}
            {missedPrompts.length === 0 && (
              <p className="no-missed">no missed prompts!</p>
            )}

            <div className="divider" />

            {/* Leaderboards for this mode (ranked modes only): the daily board
                first, then the all-time board. The player's own rank is
                highlighted if they just submitted a score. */}
            {gameMode !== "zen" && leaderboardModeFor(gameMode, difficulty) && (
              <>
                {/* Daily leaderboard */}
                <Leaderboard
                  mode={leaderboardModeFor(gameMode, difficulty)!}
                  difficulty={difficulty}
                  roundTime={gameMode === "timed" ? roundTime : null}
                  period="daily"
                  refreshKey={boardRefresh}
                  highlightRank={highlightRanks.daily}
                />

                <div className="divider" />

                {/* All-time leaderboard */}
                <Leaderboard
                  mode={leaderboardModeFor(gameMode, difficulty)!}
                  difficulty={difficulty}
                  roundTime={gameMode === "timed" ? roundTime : null}
                  period="alltime"
                  refreshKey={boardRefresh}
                  highlightRank={highlightRanks.alltime}
                />

                <div className="divider" />
              </>
            )}

            {/* New-game settings again, so the player can change options and
                play another round straight from the results screen */}
            <div className="new-game-settings">
              <div className="settings-title">
                <small>new game</small>

                <h2>choose your settings</h2>
              </div>

              {renderDifficulty()}

              {/* Timed-only settings */}
              {gameMode === "timed" && (
                <>
                  {renderTime()}
                  {renderTimedLives()}
                  {renderTimedSpeedup()}
                </>
              )}

              {renderMode()}

              {/* Play-again button; its label changes with the selected mode */}
              <button
                type="button"
                className="play-again"
                onClick={reset}
                disabled={dailyLocked}
              >
                {gameMode === "daily"
                  ? "daily done · back tomorrow"
                  : gameMode === "rush"
                    ? "run again (space)"
                    : gameMode === "sevenRush"
                      ? "run sixrush again (space)"
                      : gameMode === "alphabet"
                        ? "start alphabet"
                        : gameMode === "startEnd"
                          ? "run start/end again (space)"
                          : isMathMode(gameMode)
                            ? "run math challenge again (space)"
                            : gameMode === "anagram"
                              ? "play anagram again (space)"
                              : gameMode === "wordChange"
                                ? "new ladder (space)"
                                : gameMode === "zen"
                                  ? "start zen game"
                                  : "play again"}
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* ACTIVE GAME: top row with the mode's main indicator on the left
                and a restart button on the right */}
            <div className="top">
              <div>
                {/* Small label naming the current mode ("TIME LEFT" for timed) */}
                <small>
                  {gameMode === "rush"
                    ? "RUSH"
                    : gameMode === "sevenRush"
                      ? "SIXRUSH"
                      : gameMode === "alphabet"
                        ? "ALPHABET"
                        : gameMode === "zen"
                          ? "ZEN MODE"
                          : gameMode === "startEnd"
                            ? "START / END"
                            : gameMode === "daily"
                              ? "DAILY"
                              : gameMode === "anagram"
                                ? "ANAGRAM"
                                : gameMode === "wordChange"
                                  ? "WORD CHANGE"
                                  : isMathMode(gameMode)
                                    ? "MATH"
                                    : "TIME LEFT"}
                </small>

                {/* Timed: seconds left for this word (turns red at 3s or less) */}
                {gameMode === "timed" && (
                  <div className={time <= 3 ? "timer danger" : "timer"}>
                    {time}s
                  </div>
                )}

                {/* Zen: an infinity symbol since there's no timer */}
                {gameMode === "zen" && <div className="timer">∞</div>}

                {/* Anagram: seconds left on the whole round (red at 5s or less) */}
                {gameMode === "anagram" && (
                  <div className={anagramLeft <= 5 ? "timer danger" : "timer"}>
                    {anagramLeft.toFixed(1)}s
                  </div>
                )}

                {/* Word change: running stopwatch for the single ladder */}
                {gameMode === "wordChange" && (
                  <div className="timer">{rushElapsed.toFixed(1)}s</div>
                )}

                {/* Rush / sixrush: words completed out of 10 (word change has no
                    word count, so it is left out) */}
                {isRushMode(gameMode) &&
                  gameMode !== "alphabet" &&
                  gameMode !== "wordChange" && (
                    <div className="timer">{rushWords}/{rushTarget}</div>
                  )}

                {/* Alphabet: letters collected out of 26 */}
                {gameMode === "alphabet" && (
                  <div className="timer">{letters.size}/26</div>
                )}
              </div>

              {/* Restart button (⟳): starts a fresh game with the same settings */}
              {gameMode !== "daily" && (
                <button
                  type="button"
                  className="restart-button"
                  onClick={reset}
                  aria-label="redo"
                  title="Restart game"
                >
                  ⟳
                </button>
              )}
            </div>

            {/* PROMPT: the big letter fragment the player must use, in capitals,
                with an instruction line under it */}
            <div className="prompt">
              {gameMode === "anagram" ? (
                <>
                  <small>USE ONLY THESE LETTERS</small>
                  <strong>
                    {anagramLetters.toUpperCase().split("").join(" ")}
                  </strong>
                  <p>
                    {ANAGRAM_MIN_LENGTH}+ letters, repeats allowed. longer =
                    more points. all 7 letters = +7.
                  </p>
                </>
              ) : gameMode === "wordChange" ? (
                <>
                  <small>CHANGE ONE LETTER AT A TIME</small>
                  <strong>
                    {wcStart.toUpperCase()} → {wcEnd.toUpperCase()}
                  </strong>
                  {/* The steps so far, starting from the given word */}
                  <p>{[wcStart, ...wcChain].join(" → ")}</p>
                </>
              ) : gameMode === "startEnd" ? (
                <>
                  <small>START WITH / END WITH</small>
                  <strong>
                    {startEndPrompt.start.toUpperCase()} ···{" "}
                    {startEndPrompt.end.toUpperCase()}
                  </strong>
                  <p>
                    enter a dictionary word (3+ letters) that starts and ends
                    with these letters
                  </p>
                </>
              ) : isMathMode(gameMode) ? (
                <>
                  <small>SOLVE THE EQUATION</small>
                  <strong>{mathPrompt.expression}</strong>
                  <p>enter the whole-number answer</p>
                </>
              ) : (
                <>
                  <small>USE THESE LETTERS</small>
                  <strong>{prompt.toUpperCase()}</strong>
                  <p>put these letters in order anywhere in your word</p>
                </>
              )}
            </div>

            {/* ANSWER FORM: pressing enter or clicking the button submits the
                word. Anagram and word change have their own submit handlers. */}
            <form
              onSubmit={
                gameMode === "anagram"
                  ? submitAnagram
                  : gameMode === "wordChange"
                    ? submitWordChange
                    : submit
              }
            >
              <label htmlFor="word">
                {isMathMode(gameMode) ? "your answer" : "your word"}
              </label>

              {/* Text box (letters only, auto-lowercased) and the enter button.
                  Word change limits it to the ladder's word length. */}
              <div className="entry">
                <input
                  id="word"
                  value={input}
                  maxLength={gameMode === "wordChange" ? wcStart.length : undefined}
                  onChange={(e) =>
                    setInput(
                      isMathMode(gameMode)
                        ? e.target.value.replace(/[^0-9-]/g, "")
                        : e.target.value
                          .replace(/[^a-zA-Z]/g, "")
                          .toLowerCase(),
                    )
                  }
                  ref={wordInputRef}
                  inputMode={isMathMode(gameMode) ? "numeric" : "text"}
                  autoFocus
                  autoComplete="off"
                  autoCorrect="off"
                  placeholder={
                    isMathMode(gameMode)
                      ? "type your answer..."
                      : "type a word..."
                  }
                />

                <button type="submit">enter</button>
              </div>

              {/* Feedback line: "good word!", validation errors, or the missed-
                  prompt hint */}
              <div className="message">{message}</div>

              {/* Word change only: removes the last step you typed */}
              {gameMode === "wordChange" && wcChain.length > 0 && (
                <button
                  type="button"
                  className="lb-skip"
                  onClick={() => setWcChain((chain) => chain.slice(0, -1))}
                >
                  undo last step
                </button>
              )}

              {/* Anagram only: the words you've found, newest first */}
              {gameMode === "anagram" && used.size > 0 && (
                <p className="rule">{[...used].reverse().join(" · ")}</p>
              )}

              {/* Zen only: button to end the run, since zen has no timer or lives */}
              {gameMode === "zen" && (
                <button
                  type="button"
                  className="finish-button"
                  onClick={finishGame}
                >
                  finish game
                </button>
              )}
            </form>
          </>
        )}

        {/* ALPHABET TRACKER (timed and alphabet modes, during and after the
            game): shows which of the 26 letters have been collected so far */}
        {started && (gameMode === "timed" || gameMode === "alphabet") && (
          <>
            <div className="divider" />

            {/* Section heading with the collected count (e.g. 12/26) on the right */}
            <div className="section-heading">
              <div>
                <small>get more lives</small>

                <h2>collect every letter</h2>
              </div>

              <strong>{letters.size}/26</strong>
            </div>

            {/* A–Z grid; collected letters get the "complete" style */}
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

            {/* Explanation of the extra-life rule */}
            <p className="rule">
              every letter in a correct word is collected. collect all 26
              letters to get an extra life.
            </p>
          </>
        )}
      </section>

      {/* LEADERBOARD SUBMIT MODAL: appears after a ranked run that qualifies for
          the daily and/or all-time board. The player enters a name and colour to
          save their score; it shows the mode, difficulty and score being saved. */}
      {pendingRun && (
        <LeaderboardSubmitModal
          mode={pendingRun.mode}
          difficulty={pendingRun.difficulty}
          roundTime={pendingRun.roundTime}
          score={pendingRun.score}
          qualifiesAllTime={pendingRun.allTime}
          qualifiesDaily={pendingRun.daily}
          onSubmit={handleLeaderboardSubmit}
          onClose={handleLeaderboardClose}
        />
      )}
    </main>
  );
}