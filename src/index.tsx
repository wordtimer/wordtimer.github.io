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

// KEEP your existing import lines at the very top of your file (react hooks,
// DICTIONARY, Leaderboard, submitScore, etc.) and add this one:

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

type Difficulty = "superEasy" | "hard";
type GameMode = "timed" | "zen" | "rush" | "alphabet" | "sevenRush";

const DIFFICULTY_LIMITS: Record<Difficulty, number> = {
  superEasy: 5000,
  hard: 300,
};

function getHardMinimum() {
  return Math.floor(Math.random() * (900 - 300 + 1)) + 300;
}

const DIFFICULTY_OPTIONS: { value: Difficulty; label: string; hint: string }[] =
  [
    { value: "superEasy", label: "easy", hint: "5,000+ words" },
    { value: "hard", label: "hard", hint: "300–900+ words" },
  ];

const MODE_OPTIONS: { value: GameMode; label: string; hint: string }[] = [
  { value: "rush", label: "rush", hint: "10 words, fastest time" },
  { value: "sevenRush", label: "sixrush", hint: "10 words, 6+ letters" },
  { value: "timed", label: "timed", hint: "beat the clock" },
  { value: "alphabet", label: "alphabet", hint: "collect 26 letters" },
  { value: "zen", label: "zen", hint: "no timer or lives, not ranked" },
];

const TIME_OPTIONS = [5, 10, 20, 60];

function isRushMode(mode: GameMode) {
  return mode === "rush" || mode === "alphabet" || mode === "sevenRush";
}

type PromptData = {
  count: number;
  longCount: number;
  examples: string[];
  longExamples: string[];
};

// sixrush only uses fragments where at least this share of the difficulty's
// word minimum comes from 6+ letter words
// (easy: 5000 * 0.5 = 2500, hard: 300–900 * 0.5 = 150–450)
const SEVEN_RUSH_LONG_RATIO = 0.5;

function addExample(list: string[], word: string) {
  if (list.length < 12 && !list.some((example) => example[0] === word[0])) {
    list.push(word);
  }
}

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

function buildPromptPool(
  difficulty: Difficulty,
  mode?: GameMode,
  minimumOverride?: number,
) {
  const minimum = minimumOverride ?? DIFFICULTY_LIMITS[difficulty];
  const sevenRush = mode === "sevenRush";
  const longMinimum = Math.ceil(minimum * SEVEN_RUSH_LONG_RATIO);

  return [...PROMPT_DATA.entries()]
    .filter(([, data]) => {
      if (data.count < minimum) return false;

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

function pickPrompt(difficulty: Difficulty, mode?: GameMode) {
  const minimum =
    difficulty === "hard" ? getHardMinimum() : DIFFICULTY_LIMITS[difficulty];

  // If the pool is empty (e.g. sixrush on hard with a high random minimum),
  // step the minimum down instead of falling straight to "in".
  const minimumsToTry = [minimum, DIFFICULTY_LIMITS[difficulty], 100, 20, 1];

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

  const weightedPool: typeof pool = [];

  for (const item of pool) {
    const weight = Math.min(20, Math.max(1, Math.floor(item.count / 100)));

    for (let i = 0; i < weight; i++) {
      weightedPool.push(item);
    }
  }

  return weightedPool[Math.floor(Math.random() * weightedPool.length)];
}

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

function getRandomExamples(examples: string[]) {
  if (examples.length <= 2) {
    return [...examples];
  }

  const shuffled = [...examples].sort(() => Math.random() - 0.5);

  return shuffled.slice(0, 2);
}

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

  const countedInitialGame = useRef(false);

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

  useEffect(() => {
    loadGamesPlayed(setGamesPlayed);
  }, []);

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

  // countdown: ticks `time` down once per second in timed mode
  useEffect(() => {
    if (!started || gameOver || gameMode !== "timed" || time <= 0) return;

    const id = window.setTimeout(() => {
      setTime((t) => Math.max(0, t - 1));
    }, 1000);

    return () => window.clearTimeout(id);
  }, [started, gameOver, gameMode, time, promptNonce]);

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

  const finishGame = () => {
    if (gameMode !== "zen" || gameOver) return;

    setGameOver(true);
  };

  const focusWordInput = () => {
    window.setTimeout(() => wordInputRef.current?.focus(), 0);
  };

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

  const reset = () => {
    startGame();
    focusWordInput();
  };

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
