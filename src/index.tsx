import { useEffect, useMemo, useRef, useState } from "react";
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

const COUNTER_URL =
  "https://countapi.mileshilliard.com/api/v1/hit/word_bomb_solo_games_7f3c9";

const COUNTER_GET_URL =
  "https://countapi.mileshilliard.com/api/v1/get/word_bomb_solo_games_7f3c9";

// Reads the global "games played" total from the counter API and stores it in
// state. It does a GET, parses the JSON, and uses data.value as a number.
// Errors are ignored on purpose because the counter is only cosmetic.
async function loadGamesPlayed(
  setGamesPlayed: React.Dispatch<React.SetStateAction<number>>,
) {
  try {
    const response = await fetch(COUNTER_GET_URL);

    if (!response.ok) return;

    const data = await response.json();
    setGamesPlayed(Number(data.value) || 0);
  } catch { }
}

// Adds one to the global "games played" counter. The "hit" endpoint
// increments the count and returns the new total, which is shown in the header.
// Failures are ignored because the counter is cosmetic.
async function countGamePlayed(
  setGamesPlayed: React.Dispatch<React.SetStateAction<number>>,
) {
  try {
    const response = await fetch(COUNTER_URL);

    if (!response.ok) return;

    const data = await response.json();
    setGamesPlayed(Number(data.value) || 0);
  } catch { }
}

type Difficulty = "superEasy" | "hard";
type GameMode = "timed" | "zen" | "rush" | "alphabet" | "sevenRush";

const DIFFICULTY_LIMITS: Record<Difficulty, number> = {
  superEasy: 5000,
  hard: 500,
};

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
];

const TIME_OPTIONS = [5, 10, 20, 60];

// Says whether a mode is scored by total elapsed time (rush, sixrush,
// alphabet) instead of by number of words. It is a simple comparison against
// those three mode names. The UI uses it to decide between showing a
// stopwatch and a score.
function isRushMode(mode: GameMode) {
  return mode === "rush" || mode === "alphabet" || mode === "sevenRush";
}

type PromptData = {
  count: number;
  longCount: number;
  examples: string[];
  longExamples: string[];
};

const SEVEN_RUSH_LONG_RATIO = 0.5;

// Adds a word to a list of example answers, but only if the list has fewer
// than 12 entries and no existing example starts with the same first letter.
// That check keeps the hints varied instead of showing 12 similar words.
function addExample(list: string[], word: string) {
  if (list.length < 12 && !list.some((example) => example[0] === word[0])) {
    list.push(word);
  }
}

// Builds the index of every fragment (2 and 3 letter substrings) that can
// appear as a prompt. It loops over every word in both dictionaries, slices
// out each substring, and records per fragment: how many words contain it,
// how many of those are 6+ letters, and some example words. A Set per word
// stops a fragment being counted twice within the same word. It returns a Map
// from fragment to stats and runs once at startup.
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

// Returns the list of fragments allowed for a difficulty. It filters the
// fragment index to those appearing in at least the minimum number of words
// and no more than the difficulty's maximum (so hard excludes very common
// fragments). In sixrush mode it also requires enough 6+ letter words, using
// SEVEN_RUSH_LONG_RATIO of the minimum, and swaps in the long-word counts and
// examples. minimumOverride lets pickPrompt retry with lower minimums.
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

// Chooses the next fragment to show. It builds the pool for the difficulty,
// and if that pool is empty it retries with lower minimums (100, 20, 1) while
// keeping the ceiling. If everything fails it falls back to "in". Hard mode
// then picks uniformly at random. Easy mode weights each fragment by
// count / 100 (between 1 and 20 copies in a list) so common fragments appear
// more often, then picks a random entry from that list.
function pickPrompt(difficulty: Difficulty, mode?: GameMode) {
  const minimum = DIFFICULTY_LIMITS[difficulty];

  const minimumsToTry = [minimum, 100, 20, 1];

  let pool: ReturnType<typeof buildPromptPool> = [];

  for (const candidate of minimumsToTry) {
    pool = buildPromptPool(difficulty, mode, candidate);
    if (pool.length) break;
  }

  if (!pool.length) {
    return { fragment: "in", examples: ["inside", "winter"] };
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

// Builds the list of prompts handed to multiplayer. It calls pickPrompt
// repeatedly and skips fragments already chosen so players get distinct
// letters. A guard counter stops the loop if unique fragments run out, and a
// second loop then fills the rest of the list with repeats.
function makeGroupPrompts(count: number, difficulty: GroupDifficulty) {
  const seen = new Set<string>();
  const out: PromptItem[] = [];
  let guard = 0;

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

// Debug helper exposed as window.logPromptPools(). For every difficulty and
// for rush versus sixrush, it builds the prompt pool and prints a table of
// how many fragments qualify, which shows whether a pool is too small.
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

// Picks up to two example words to show after a missed prompt. If there are
// two or fewer it returns them all. Otherwise it shuffles a copy with a
// random sort and takes the first two.
function getRandomExamples(examples: string[]) {
  if (examples.length <= 2) {
    return [...examples];
  }

  const shuffled = [...examples].sort(() => Math.random() - 0.5);

  return shuffled.slice(0, 2);
}

// The whole solo game. It holds all game state (mode, difficulty, prompt,
// score, timers, modals, leaderboard data) and renders one of three views:
// the start screen, the active game, or the results screen. The multiplayer
// screen is a separate component that this one swaps in.
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
  const wordInputRef = useRef<HTMLInputElement | null>(null);

  const initialPrompt = pickPrompt("superEasy");

  const [prompt, setPrompt] = useState(initialPrompt.fragment);

  const [promptExamples, setPromptExamples] = useState(initialPrompt.examples);

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

  // Effect: loads the global games-played counter once when the page mounts.
  useEffect(() => {
    loadGamesPlayed(setGamesPlayed);
  }, []);

  // Effect: runs the stopwatch for rush, sixrush and alphabet. While a game is
  // running it recomputes the elapsed seconds from the saved start timestamp
  // every 100 ms, and clears the interval when the game ends or settings change.
  useEffect(() => {
    if (
      gameOver ||
      (gameMode !== "rush" &&
        gameMode !== "alphabet" &&
        gameMode !== "sevenRush") ||
      rushStartTime === null
    ) {
      return;
    }

    const update = () => {
      setRushElapsed((Date.now() - rushStartTime) / 1000);
    };

    update();

    const id = window.setInterval(update, 100);

    return () => window.clearInterval(id);
  }, [gameOver, gameMode, rushStartTime]);

  // Effect: the per-word countdown in timed mode. It schedules a one second
  // timeout that lowers `time` by one. Each change to `time` re-runs the
  // effect and schedules the next tick. promptNonce is a dependency so the
  // countdown restarts when a new prompt appears, even if the time is the same.
  useEffect(() => {
    if (!started || gameOver || gameMode !== "timed" || time <= 0) return;

    const id = window.setTimeout(() => {
      setTime((t) => Math.max(0, t - 1));
    }, 1000);

    return () => window.clearTimeout(id);
  }, [started, gameOver, gameMode, time, promptNonce]);

  // Effect: handles running out of time in timed mode. When `time` reaches 0
  // it records the missed prompt with two example answers, shows a message,
  // and takes away a life. If no lives remain the game ends. Otherwise it picks
  // a new prompt and resets the clock, using the shorter time once the
  // speed-up threshold has been reached.
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

    const nextPrompt = pickPrompt(difficulty, gameMode);

    setPrompt(nextPrompt.fragment);
    setPromptExamples(nextPrompt.examples);
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

  // Handles the player pressing enter. It validates the word in order: minimum
  // length (6 in sixrush), letters only, present in a dictionary, contains the
  // fragment, and not already used, showing a message for the first failure. On
  // success it records the answer time, adds the word to the used set, collects
  // its letters and increments the score. It then checks mode-specific end
  // conditions (10 words for rush and sixrush, 26 letters for alphabet). If the
  // game continues it picks the next prompt, resets the timer, and awards an
  // extra life in timed mode when all 26 letters have been collected.
  const submit = (event: React.FormEvent) => {
    event.preventDefault();

    if (gameOver) return;

    const word = input.trim().toLowerCase();
    const minLength =
      gameMode === "sevenRush"
        ? Math.max(prompt.length + 1, 6)
        : prompt.length + 1;

    if (word.length < minLength) {
      setMessage(`your word must be at least ${minLength} letters.`);
      return;
    }

    if (!/^[a-z]+$/.test(word)) {
      setMessage("use letters only.");
      return;
    }

    if (!DICTIONARY.has(word) && !MODERN_WORDS.has(word)) {
      setMessage("that word isn't in the dictionary.");
      return;
    }

    if (!word.includes(prompt)) {
      setMessage(`your word needs "${prompt.toUpperCase()}".`);
      return;
    }

    if (used.has(word)) {
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

    if (gameMode === "rush" || gameMode === "sevenRush") {
      const nextRushWords = rushWords + 1;

      setRushWords(nextRushWords);

      if (nextRushWords >= 10) {
        const totalTime = (Date.now() - (rushStartTime ?? Date.now())) / 1000;

        setRushTotalTime(totalTime);
        setMessage(
          gameMode === "sevenRush" ? "sixrush complete!" : "rush complete!",
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

    const nextPrompt = pickPrompt(difficulty, gameMode);

    setPrompt(nextPrompt.fragment);
    setPromptExamples(nextPrompt.examples);
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

  // Returns to the start screen when the title is clicked. It turns off the
  // started and game-over flags and clears the input, used words, collected
  // letters, score and rush timers, so the next game starts from a clean slate.
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

  // Ends a zen game on demand. Zen has no timer or lives, so this button is
  // the only way to finish it. It does nothing in other modes or if the game
  // is already over.
  const finishGame = () => {
    if (gameMode !== "zen" || gameOver) return;

    setGameOver(true);
  };

  // Puts the cursor in the word box. It waits one tick with setTimeout so the
  // input exists after React has finished rendering, then calls focus on the
  // stored input reference.
  const focusWordInput = () => {
    window.setTimeout(() => wordInputRef.current?.focus(), 0);
  };

  // Begins a new game with the current settings. It increments the global
  // counter, creates a new unique run id for the leaderboard, and clears any
  // pending submit modal. It then picks the first prompt, resets score, lives,
  // used words, letters, answer times and missed prompts, sets the countdown for
  // timed mode, and flips the UI into the started state. For rush-style modes
  // it also records the start timestamp so the stopwatch can run.
  const startGame = () => {
    countGamePlayed(setGamesPlayed);

    runIdRef.current = crypto.randomUUID();

    setPendingRun(null);
    setHighlightRanks({ alltime: null, daily: null });

    const startingLives = timedLives;

    const nextPrompt = pickPrompt(difficulty, gameMode);
    const now = Date.now();
    setPrompt(nextPrompt.fragment);
    setPromptExamples(nextPrompt.examples);
    setPromptNonce((n) => n + 1);
    setInput("");
    setLives(startingLives);
    setScore(0);
    setRushWords(0);
    setRushElapsed(0);
    setRushTotalTime(null);

    if (gameMode === "timed") {
      setTime(roundTime);
    } else {
      setTime(0);
    }

    setUsed(new Set());
    setLetters(new Set());
    setAnswerTimes([]);
    setMissedPrompts([]);
    setMessage("enter a word containing the letters.");
    setGameOver(false);
    setStarted(true);

    roundStartedAt.current = now;
    focusWordInput();

    if (
      gameMode === "rush" ||
      gameMode === "alphabet" ||
      gameMode === "sevenRush"
    ) {
      setRushStartTime(now);
    } else {
      setRushStartTime(null);
    }
  };

  // Runs when the player submits their name and color in the leaderboard
  // modal. It saves the pending run with that name, then fetches the run's
  // all-time and daily ranks in parallel (only for boards it qualified for).
  // Finally it switches the UI to that run's mode and difficulty, stores the
  // ranks so the matching rows get highlighted, bumps the refresh key so the
  // boards reload, and closes the modal.
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

    setGameMode(pendingRun.mode);
    setDifficulty(pendingRun.difficulty);
    setHighlightRanks({
      alltime: allTimeRank,
      daily: dailyRank,
    });
    setBoardRefresh((n) => n + 1);
    setPendingRun(null);
  };

  // Restarts the game with the same settings. It calls startGame and then
  // focuses the word box. The restart and play-again buttons use it.
  const reset = () => {
    startGame();
    focusWordInput();
  };

  // Effect: runs when a ranked game ends. It converts the result to a final
  // score (milliseconds for rush-style modes, word count for timed), clears the
  // run id so it only runs once, and asks the backend whether the score would
  // make the all-time or daily board. If it qualifies it opens the name modal.
  // If not, it saves the score as "anonymous" so percentiles stay accurate.
  useEffect(() => {
    if (
      !gameOver ||
      !started ||
      gameMode === "zen" ||
      !isRankedMode(gameMode)
    ) {
      return;
    }

    const runId = runIdRef.current;
    if (!runId) return;

    const isRush =
      gameMode === "rush" ||
      gameMode === "alphabet" ||
      gameMode === "sevenRush";

    if (isRush && rushTotalTime === null) {
      return;
    }

    runIdRef.current = null;

    const finalScore = isRush ? Math.round((rushTotalTime ?? 0) * 1000) : score;

    const roundTimeArg = gameMode === "timed" ? roundTime : null;

    Promise.all([
      wouldQualify(gameMode, difficulty, roundTimeArg, finalScore, "alltime"),
      wouldQualify(gameMode, difficulty, roundTimeArg, finalScore, "daily"),
    ])
      .then(async ([allTime, daily]) => {
        if (allTime || daily) {
          setPendingRun({
            runId,
            mode: gameMode,
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
          gameMode,
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

  // Effect: runs when a ranked game ends and fetches the "better than X% of
  // runs" figure. It computes the same final score as above, shows a loading
  // state, asks the backend for the percentile and sample size, stores them,
  // and clears the loading flag whether the request succeeds or fails.
  useEffect(() => {
    if (
      !gameOver ||
      !started ||
      gameMode === "zen" ||
      !isRankedMode(gameMode)
    ) {
      return;
    }

    const finalScore =
      gameMode === "rush" || gameMode === "alphabet" || gameMode === "sevenRush"
        ? Math.round((rushTotalTime ?? 0) * 1000)
        : score;

    if (
      (gameMode === "rush" ||
        gameMode === "alphabet" ||
        gameMode === "sevenRush") &&
      rushTotalTime === null
    ) {
      return;
    }

    const roundTimeArg = gameMode === "timed" ? roundTime : null;

    setPercentileLoading(true);
    setPercentile(null);
    setPercentileTotal(0);

    getScorePercentile(gameMode, difficulty, roundTimeArg, finalScore)
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

  // Effect: lets the spacebar start or restart a game. It attaches a keydown
  // listener on the window (solo screen only) and ignores held keys, open
  // modals, and key presses made while focus is in a text field or button. When
  // the game is not running it prevents the page from scrolling and calls
  // startGame. The listener is removed in the cleanup function.
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

  const hearts = useMemo(() => "♥".repeat(Math.max(0, lives)), [lives]);

  const averageTime =
    answerTimes.length > 0
      ? answerTimes.reduce((sum, value) => sum + value, 0) / answerTimes.length
      : 0;

  // Renders the difficulty picker. It maps over DIFFICULTY_OPTIONS to make one
  // button each, highlights the selected one, and updates difficulty on click.
  // It is a function so the start screen and results screen can reuse it.
  const renderDifficulty = () => (
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
            className={
              difficulty === option.value ? "option selected" : "option"
            }
            onClick={() => setDifficulty(option.value)}
          >
            <strong>{option.label}</strong>
            <span>{option.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );

  // Renders the mode picker and the multiplayer button. Buttons sit on a
  // six-column grid; the first two span three columns and the rest span two,
  // which gives a wide top row and a narrower second row. The multiplayer
  // button switches the app to the group screen.
  const renderMode = () => (
    <div className="setting">
      <small>mode</small>

      <div
        className="option-grid mode-options"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(6, 1fr)",
        }}
      >
        {MODE_OPTIONS.map((option, index) => (
          <button
            type="button"
            key={option.value}
            style={{
              gridColumn: index < 2 ? "span 3" : "span 2",
            }}
            className={gameMode === option.value ? "option selected" : "option"}
            onClick={() => setGameMode(option.value)}
          >
            <strong>{option.label}</strong>
            <span>{option.hint}</span>
          </button>
        ))}
      </div>

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

  // Renders the lives picker for timed mode. Clicking a number sets the
  // starting lives and also switches the mode to timed, since the setting only
  // matters there.
  const renderTimedLives = () => (
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

  // Renders the on/off toggle for the timed-mode speed-up. Clicking it flips
  // shortenTimed, which controls whether the per-word time drops to 5 seconds
  // after 20 prompts.
  const renderTimedSpeedup = () => (
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

  // Renders the seconds-per-word picker for timed mode. Choosing a value sets
  // roundTime and also switches the mode to timed.
  const renderTime = () => (
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

  if (screen === "group") {
    return (
      <main>
        <header>
          <div className="game-title" onClick={() => setScreen("solo")}>
            <b>WORDTIMER</b>
            <span> BETA</span>
          </div>
        </header>

        <GroupGame
          onExit={() => setScreen("solo")}
          makePrompts={makeGroupPrompts}
          isValidWord={(w) => DICTIONARY.has(w) || MODERN_WORDS.has(w)}
        />
      </main>
    );
  }

  return (
    <main>
      <header>
        <div className="game-title" onClick={goToStart}>
          <b>WORDTIMER</b>
          <span> BETA</span>
        </div>

        <div className="stats">
          <span>
            total games played by all users{" "}
            <strong>{gamesPlayed.toLocaleString()}</strong>
          </span>

          {started && (
            <>
              <span>
                score <strong>{score}</strong>
              </span>

              {gameMode === "timed" && (
                <span className="lives">{hearts || "—"}</span>
              )}

              {isRushMode(gameMode) && (
                <span className="timer2">{rushElapsed.toFixed(1)}s</span>
              )}
            </>
          )}
        </div>
      </header>

      {showRules && (
        <div className="rules-overlay" onClick={() => setShowRules(false)}>
          <div
            className="rules-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="rules-close"
              onClick={() => setShowRules(false)}
            >
              ×
            </button>

            <small>how to play</small>

            <h2>rules & instructions</h2>

            <p>
              find a word containing the letters/substring shown on screen. your
              word must be at least 1 letter longer than the fragment. words
              must be in the dictionary and cannot be repeated.
            </p>

            <div className="rules-section">
              <strong>timed</strong>

              <p>
                you have the selected amount of time to find a word. running out
                of time costs a life. collect all 26 letters to gain an extra
                life. after 20 prompts, the timer can shorten to 5 seconds.
                wrong words do not cost a life.
              </p>
            </div>

            <div className="rules-section">
              <strong>rush</strong>

              <p>
                complete 10 words as quickly as possible. there is no timer per
                word. your final time is your score.
              </p>
            </div>

            <div className="rules-section">
              <strong>sixrush</strong>

              <p>
                complete 10 words as quickly as possible, but every word must be
                at least 6 letters long. your final time is your score.
              </p>
            </div>

            <div className="rules-section">
              <strong>alphabet</strong>

              <p>keep filling in words until you get all 26 letters</p>
            </div>

            <div className="rules-section">
              <strong>zen</strong>

              <p>
                play without a timer or lives. finish whenever you want. zen
                runs are not ranked.
              </p>
            </div>

            <div className="rules-section">
              <strong>BETA multiplayer</strong>

              <p>
                create a game and share the code with friends. everyone gets the
                same letters, and the first player to finish 20 words wins.
              </p>
            </div>

            <div className="rules-section">
              <strong>daily leaderboard</strong>

              <p>
                daily scores reset every day at 11pm central. all-time scores
                are kept.
              </p>
            </div>
          </div>
        </div>
      )}
      {showCredits && (
        <div className="rules-overlay" onClick={() => setShowCredits(false)}>
          <div
            className="rules-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="rules-close"
              onClick={() => setShowCredits(false)}
            >
              ×
            </button>

            <h2>credits</h2>

            <div className="rules-section">
              <strong>created by</strong>
              <p>Bryce Wan</p>
            </div>

            <div className="rules-section">
              <strong>lead playtesters</strong>
              <p>
                Alex Tybon, Mrs. Denna, Micah Park, Adam Feng, Mr. Hays, Sathvik
                Loka
              </p>
            </div>

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
      {showLeaderboard && (
        <div
          className="rules-overlay"
          onClick={() => setShowLeaderboard(false)}
        >
          <div
            className="rules-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="rules-close"
              onClick={() => setShowLeaderboard(false)}
            >
              ×
            </button>

            <small>leaderboards</small>

            <h2>view leaderboard</h2>

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
                <strong>daily</strong>
                <span>resets every day at 11pm</span>
              </button>
            </div>

            {gameMode === "zen" ? (
              <p>
                zen mode isn't ranked. pick another mode to view its
                leaderboard.
              </p>
            ) : (
              <Leaderboard
                mode={gameMode}
                difficulty={difficulty}
                roundTime={gameMode === "timed" ? roundTime : null}
                period={boardPeriod}
                refreshKey={boardRefresh}
              />
            )}
          </div>
        </div>
      )}

      <section className="card">
        {!started ? (
          <div className="start-screen">
            <div className="results-header">
              <small>how to play</small>

              <h2>wordtimer</h2>

              <p>find words containing the letters shown on screen.</p>
            </div>

            <div className="divider" />

            <div className="new-game-settings">
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

              {renderDifficulty()}

              {renderMode()}

              {gameMode === "timed" && (
                <>
                  {renderTime()}
                  {renderTimedLives()}
                  {renderTimedSpeedup()}
                </>
              )}

              <button
                type="button"
                className="play-again start-button"
                onClick={startGame}
              >
                start game (space)
              </button>

              <button
                type="button"
                className="lb-skip"
                onClick={() => setShowLeaderboard(true)}
              >
                view leaderboard
              </button>
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
            <div className="results-header">
              <small>
                {gameMode === "zen" ||
                  gameMode === "rush" ||
                  gameMode === "alphabet" ||
                  gameMode === "sevenRush"
                  ? "run complete"
                  : "game over"}
              </small>

              <h2>
                {isRushMode(gameMode) ? rushTotalTime?.toFixed(2) : score}
              </h2>

              <p>{isRushMode(gameMode) ? "seconds" : "words this run"}</p>
            </div>

            <div className="final-stats">
              {gameMode !== "zen" && isRankedMode(gameMode) && (
                <div className="percentile-box">
                  <small>your performance</small>

                  {percentileLoading ? (
                    <strong>calculating...</strong>
                  ) : percentile !== null && percentileTotal > 0 ? (
                    <>
                      <strong>better than {percentile}% of runs</strong>
                      <span>
                        Compared with {percentileTotal.toLocaleString()} scores
                      </span>
                    </>
                  ) : (
                    <span>
                      Not enough scores to calculate a percentile yet.
                    </span>
                  )}
                </div>
              )}
              <div className="stat-box">
                <small>average time</small>

                <strong>
                  {answerTimes.length > 0 ? `${averageTime.toFixed(1)}s` : "—"}
                </strong>
              </div>

              <div className="stat-box">
                <small>answered</small>

                <strong>{answerTimes.length}</strong>
              </div>

              <div className="stat-box">
                <small>missed</small>

                <strong>{missedPrompts.length}</strong>
              </div>
            </div>

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

            {missedPrompts.length === 0 && (
              <p className="no-missed">no missed prompts!</p>
            )}

            <div className="divider" />

            {gameMode !== "zen" && isRankedMode(gameMode) && (
              <>
                <Leaderboard
                  mode={gameMode}
                  difficulty={difficulty}
                  roundTime={gameMode === "timed" ? roundTime : null}
                  period="daily"
                  refreshKey={boardRefresh}
                  highlightRank={highlightRanks.daily}
                />

                <div className="divider" />

                <Leaderboard
                  mode={gameMode}
                  difficulty={difficulty}
                  roundTime={gameMode === "timed" ? roundTime : null}
                  period="alltime"
                  refreshKey={boardRefresh}
                  highlightRank={highlightRanks.alltime}
                />

                <div className="divider" />
              </>
            )}

            <div className="new-game-settings">
              <div className="settings-title">
                <small>new game</small>

                <h2>choose your settings</h2>
              </div>

              {renderDifficulty()}

              {gameMode === "timed" && (
                <>
                  {renderTime()}
                  {renderTimedLives()}
                  {renderTimedSpeedup()}
                </>
              )}

              {renderMode()}

              <button type="button" className="play-again" onClick={reset}>
                {gameMode === "rush"
                  ? "run again (space)"
                  : gameMode === "sevenRush"
                    ? "run sixrush again (space)"
                    : gameMode === "alphabet"
                      ? "start alphabet"
                      : gameMode === "zen"
                        ? "start zen game"
                        : "play again"}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="top">
              <div>
                <small>
                  {gameMode === "rush"
                    ? "RUSH"
                    : gameMode === "sevenRush"
                      ? "SIXRUSH"
                      : gameMode === "alphabet"
                        ? "ALPHABET"
                        : gameMode === "zen"
                          ? "ZEN MODE"
                          : "TIME LEFT"}
                </small>

                {gameMode === "timed" && (
                  <div className={time <= 3 ? "timer danger" : "timer"}>
                    {time}s
                  </div>
                )}

                {gameMode === "zen" && <div className="timer">∞</div>}

                {(gameMode === "rush" || gameMode === "sevenRush") && (
                  <div className="timer">{rushWords}/10</div>
                )}

                {gameMode === "alphabet" && (
                  <div className="timer">{letters.size}/26</div>
                )}
              </div>

              <button
                type="button"
                className="restart-button"
                onClick={reset}
                aria-label="redo"
                title="Restart game"
              >
                ⟳
              </button>
            </div>

            <div className="prompt">
              <small>USE THESE LETTERS</small>

              <strong>{prompt.toUpperCase()}</strong>

              <p>put these letters in order anywhere in your word</p>
            </div>

            <form onSubmit={submit}>
              <label htmlFor="word">your word</label>

              <div className="entry">
                <input
                  id="word"
                  value={input}
                  onChange={(e) =>
                    setInput(
                      e.target.value.replace(/[^a-zA-Z]/g, "").toLowerCase(),
                    )
                  }
                  ref={wordInputRef}
                  inputMode="text"
                  autoFocus
                  autoComplete="off"
                  placeholder="type a word..."
                />

                <button type="submit">enter</button>
              </div>

              <div className="message">{message}</div>

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

        {started && (gameMode === "timed" || gameMode === "alphabet") && (
          <>
            <div className="divider" />

            <div className="section-heading">
              <div>
                <small>get more lives</small>

                <h2>collect every letter</h2>
              </div>

              <strong>{letters.size}/26</strong>
            </div>

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

            <p className="rule">
              every letter in a correct word is collected. collect all 26
              letters to get an extra life.
            </p>
          </>
        )}
      </section>

      {pendingRun && (
        <LeaderboardSubmitModal
          mode={pendingRun.mode}
          difficulty={pendingRun.difficulty}
          roundTime={pendingRun.roundTime}
          score={pendingRun.score}
          qualifiesAllTime={pendingRun.allTime}
          qualifiesDaily={pendingRun.daily}
          onSubmit={handleLeaderboardSubmit}
          onClose={() => setPendingRun(null)}
        />
      )}
    </main>
  );
}