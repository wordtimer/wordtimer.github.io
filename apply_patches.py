#!/usr/bin/env python3
"""
Usage:  python apply_patches.py <App file> <GroupGame.tsx> <leaderboardv2.tsx>
  e.g.  python apply_patches.py index.tsx GroupGame.tsx src/app/leaderboardv2.tsx

Applies: solo daily mode (ranked), multiplayer anagram + word change modes.
Anchors match ignoring whitespace. If ANY anchor fails to match exactly once,
nothing is written and the script tells you which one. Backups go to *.bak.
"""
import re
import shutil
import sys


def flex(old):
    return r"\s+".join(re.escape(t) for t in old.split())


def find(src, old, label):
    m = list(re.finditer(flex(old), src))
    if len(m) != 1:
        sys.exit(f"PATCH FAILED [{label}]: expected 1 match, found {len(m)}. Nothing was written.")
    return m[0]


def rep(src, old, new, label):
    m = find(src, old, label)
    return src[: m.start()] + new + src[m.end():]


def after(src, old, add, label):
    m = find(src, old, label)
    return src[: m.end()] + add + src[m.end():]


def before(src, old, add, label):
    m = find(src, old, label)
    return src[: m.start()] + add + src[m.start():]


# =============================================================================
# leaderboardv2.tsx
# =============================================================================
def patch_leaderboard(s):
    s = rep(s, '| "mathMed";\n\nexport type Period', '| "mathMed"\n  | "daily";\n\nexport type Period', "lb type")
    s = rep(s, 'mathMed: "math hard",\n};', 'mathMed: "math hard",\n  daily: "daily",\n};', "lb labels")
    s = rep(s, 'mode === "mathMed"\n  );', 'mode === "mathMed" ||\n    mode === "daily"\n  );', "lb isRanked")
    s = rep(
        s,
        'if (mode === "startEnd" || mode === "mathEasy" || mode === "mathMed") {',
        'if (\n    mode === "startEnd" ||\n    mode === "mathEasy" ||\n    mode === "mathMed" ||\n    mode === "daily"\n  ) {',
        "lb title",
    )
    # daily has no difficulty: always store/query it as "superEasy"
    old = "p_difficulty: difficulty,"
    n = s.count(old)
    if n != 4:
        sys.exit(f"PATCH FAILED [lb difficulty]: expected 4 occurrences, found {n}.")
    s = s.replace(old, 'p_difficulty: mode === "daily" ? "superEasy" : difficulty,')
    return s


# =============================================================================
# App (solo) file
# =============================================================================
DAILY_HELPERS = r'''
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
'''

DAILY_STATE = r'''

  // ---- daily mode (one play per device) ----
  const [dailyRecord, setDailyRecord] = useState<DailyRecord | null>(readDaily);
  const dailyPromptsRef = useRef<
    { fragment: string; count: number; examples: string[] }[]
  >([]);
  const rushTarget = gameMode === "daily" ? DAILY_WORDS : 10;
  const dailyLocked = gameMode === "daily" && dailyRecord?.date === todayKey();
'''

DAILY_GUARD = r'''const startGame = () => {
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

    countGamePlayed(setGamesPlayed);'''

GENERATORS = r'''/* ---------- anagram (multiplayer) ---------- */
const VOWELS = new Set(["a", "e", "i", "o", "u"]);
const PANGRAM_SEEDS = ALL_WORDS.filter(
  (w) => w.length >= 7 && w.length <= 9 && new Set(w).size === 7,
);

// 7 distinct letters taken from a real word, so at least one pangram exists.
// Retries until the letter set allows plenty of words.
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

/* ---------- word change (multiplayer) ---------- */
type WordGraph = { words: string[]; buckets: Map<string, string[]> };
const wordGraphs = new Map<number, WordGraph>();

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

function neighborsOf(word: string, g: WordGraph) {
  const out: string[] = [];
  for (let i = 0; i < word.length; i++) {
    const key = word.slice(0, i) + "_" + word.slice(i + 1);
    for (const w of g.buckets.get(key) ?? []) if (w !== word) out.push(w);
  }
  return out;
}

// Random start, BFS, then a target whose shortest-path distance is within
// [minSteps, maxSteps]. examples = one shortest path (proof it is solvable).
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

'''

GROUP_BRANCHES = r'''if (mode === "anagram") return [makeAnagramPrompt()];

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

  '''

DAILY_RULES = r'''{/* Rules for daily mode */}
            <div className="rules-section">
              <strong>daily</strong>

              <p>
                the same 5 prompts for everyone each day (resets at midnight
                UTC). you only get one attempt per device. fastest time wins
                and daily scores are ranked.
              </p>
            </div>

            '''


def patch_app(s):
    s = rep(s, '| "startEnd" | MathMode;', '| "startEnd" | "daily" | MathMode;', "app GameMode")
    s = rep(
        s,
        '{ value: "math", label: "math", hint: "10 arithmetic questions" }, ];',
        '{ value: "math", label: "math", hint: "10 arithmetic questions" },\n  { value: "daily", label: "daily", hint: "5 words, once a day" },\n];',
        "app MODE_OPTIONS",
    )
    s = rep(
        s,
        'mode === "sevenRush" || mode === "startEnd" || isMathMode(mode) );',
        'mode === "sevenRush" ||\n    mode === "startEnd" ||\n    mode === "daily" ||\n    isMathMode(mode)\n  );',
        "app isRushMode",
    )
    s = after(s, "const PROMPT_DATA = buildPromptData();", "\n" + DAILY_HELPERS, "app helpers")
    s = after(s, 'const [gameMode, setGameMode] = useState<GameMode>("rush");', DAILY_STATE, "app state")

    # stopwatch effect
    s = rep(
        s,
        '''if ( gameOver || (gameMode !== "rush" && gameMode !== "alphabet" && gameMode !== "sevenRush" && gameMode !== "startEnd" && !isMathMode(gameMode)) || rushStartTime === null ) {''',
        "if (gameOver || !isRushMode(gameMode) || rushStartTime === null) {",
        "app stopwatch",
    )

    # startGame
    s = rep(s, "const startGame = () => { countGamePlayed(setGamesPlayed);", DAILY_GUARD, "app startGame guard")
    s = rep(
        s,
        "const nextPrompt = pickPrompt(difficulty, gameMode); const now = Date.now();",
        '''const nextPrompt =
      gameMode === "daily"
        ? dailyPromptsRef.current[0]
        : pickPrompt(difficulty, gameMode);
    const now = Date.now();''',
        "app startGame prompt",
    )
    s = rep(
        s,
        '''if ( gameMode === "rush" || gameMode === "alphabet" || gameMode === "sevenRush" || gameMode === "startEnd" || isMathMode(gameMode) ) { setRushStartTime(now);''',
        "if (isRushMode(gameMode)) {\n      setRushStartTime(now);",
        "app startGame rush",
    )

    # submit
    s = rep(
        s,
        "if (nextRushWords >= 10) { const totalTime = (Date.now() - (rushStartTime ?? Date.now())) / 1000; setRushTotalTime(totalTime);",
        '''if (nextRushWords >= rushTarget) {
        const totalTime = (Date.now() - (rushStartTime ?? Date.now())) / 1000;

        setRushTotalTime(totalTime);

        if (gameMode === "daily") {
          const record: DailyRecord = { date: todayKey(), time: totalTime };
          writeDaily(record);
          setDailyRecord(record);
        }''',
        "app submit finish",
    )
    s = rep(
        s,
        'setMessage( gameMode === "sevenRush" ? "sixrush complete!"',
        'setMessage(\n          gameMode === "daily"\n            ? "daily complete!"\n            : gameMode === "sevenRush"\n            ? "sixrush complete!"',
        "app submit message",
    )
    s = rep(
        s,
        '''const nextPrompt = pickPrompt(difficulty, gameMode); setPrompt(nextPrompt.fragment); setPromptExamples(nextPrompt.examples); } setPromptNonce((n) => n + 1); if (gameMode === "timed") {''',
        '''const nextPrompt =
        gameMode === "daily"
          ? (dailyPromptsRef.current[nextScore] ??
            pickPrompt(difficulty, gameMode))
          : pickPrompt(difficulty, gameMode);
      setPrompt(nextPrompt.fragment);
      setPromptExamples(nextPrompt.examples);
    }
    setPromptNonce((n) => n + 1);

    if (gameMode === "timed") {''',
        "app submit next prompt",
    )

    # leaderboard effects: daily is a rush-style mode
    s = rep(
        s,
        '''const isRush = gameMode === "rush" || gameMode === "alphabet" || gameMode === "sevenRush" || gameMode === "startEnd" || isMathMode(gameMode);''',
        "const isRush = isRushMode(gameMode);",
        "app effect5",
    )
    s = rep(
        s,
        '''const finalScore = gameMode === "rush" || gameMode === "alphabet" || gameMode === "sevenRush" || gameMode === "startEnd" || isMathMode(gameMode) ? Math.round((rushTotalTime ?? 0) * 1000) : score;''',
        "const finalScore = isRushMode(gameMode)\n      ? Math.round((rushTotalTime ?? 0) * 1000)\n      : score;",
        "app effect6 score",
    )
    s = rep(
        s,
        '''(gameMode === "rush" || gameMode === "alphabet" || gameMode === "sevenRush" || gameMode === "startEnd" || isMathMode(gameMode)) && rushTotalTime === null''',
        "isRushMode(gameMode) && rushTotalTime === null",
        "app effect6 guard",
    )

    # UI
    s = rep(s, '<div className="timer">{rushWords}/10</div>', '<div className="timer">{rushWords}/{rushTarget}</div>', "app counter")
    s = rep(s, '{gameMode === "zen" || gameMode === "rush" ||', '{gameMode === "zen" ||\n                  gameMode === "daily" ||\n                  gameMode === "rush" ||', "app run complete")
    s = rep(
        s,
        '? "START / END" : isMathMode(gameMode) ? "MATH" : "TIME LEFT"',
        '? "START / END"\n                            : gameMode === "daily"\n                              ? "DAILY"\n                              : isMathMode(gameMode)\n                                ? "MATH"\n                                : "TIME LEFT"',
        "app top label",
    )
    s = rep(
        s,
        '''<button type="button" className="restart-button" onClick={reset} aria-label="redo" title="Restart game" > ⟳ </button>''',
        '''{gameMode !== "daily" && (
                <button
                  type="button"
                  className="restart-button"
                  onClick={reset}
                  aria-label="redo"
                  title="Restart game"
                >
                  ⟳
                </button>
              )}''',
        "app restart",
    )
    s = rep(
        s,
        '''<button type="button" className="play-again start-button" onClick={startGame} > start game (space) </button>''',
        '''<button
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
              </button>''',
        "app start button",
    )
    s = rep(
        s,
        '''<button type="button" className="play-again" onClick={reset}> {gameMode === "rush" ? "run again (space)"''',
        '''<button
                type="button"
                className="play-again"
                onClick={reset}
                disabled={dailyLocked}
              >
                {gameMode === "daily"
                  ? "daily done · back tomorrow"
                  : gameMode === "rush"
                  ? "run again (space)"''',
        "app play again",
    )
    s = before(s, "{/* Rules for zen mode (no timer, no lives, not ranked) */}", DAILY_RULES, "app rules")

    # multiplayer prompt generators
    s = before(s, "// makeGroupPrompts(count, difficulty, mode?): returns the prompt list passed to", GENERATORS, "app generators")
    s = before(
        s,
        "const seen = new Set<string>(); const out: PromptItem[] = []; let guard = 0;",
        GROUP_BRANCHES,
        "app makeGroupPrompts",
    )
    return s


# =============================================================================
# GroupGame.tsx
# =============================================================================
G_CONSTS = r'''

const ANAGRAM_SECONDS = 60;
const ANAGRAM_GRACE_S = 1.5; // wait for final progress saves before showing results
const ANAGRAM_MIN_LENGTH = 3;
const WORD_CHANGE_PUZZLES = 3;'''

G_MODE_OPTIONS = r'''hint: `${TARGET_WORDS} arithmetic problems`,
  },
  {
    value: "anagram",
    label: "anagram",
    hint: `${ANAGRAM_SECONDS}s, words from 7 letters`,
  },
  {
    value: "wordChange",
    label: "word change",
    hint: `${WORD_CHANGE_PUZZLES} ladders, 1 letter at a time`,
  },
];'''

G_TARGET = r'''const targetOf = (mode: GroupMode) =>
  mode === "alphabet"
    ? ALPHABET_TARGET
    : mode === "wordChange"
      ? WORD_CHANGE_PUZZLES
      : mode === "anagram"
        ? Infinity
        : TARGET_WORDS;'''

G_PROMPT_COUNT = r'''const promptCountFor = (mode: GroupMode) =>
  mode === "anagram"
    ? 1
    : mode === "wordChange"
      ? WORD_CHANGE_PUZZLES
      : mode === "alphabet" || mode === "timed" || mode === "survival"
        ? PROMPT_POOL_SIZE
        : TARGET_WORDS;'''

G_DISPLAY = r'''

  if (mode === "anagram") return fragment.toUpperCase().split("").join(" ");

  if (mode === "wordChange") {
    const [s, e = ""] = fragment.split("-");

    return `${s.toUpperCase()} → ${e.toUpperCase()}`;
  }
'''

G_CHECKERS = r'''const isPangram = (word: string, letters: string) =>
  [...letters].every((c) => word.includes(c));

const anagramPoints = (word: string, letters: string) =>
  word.length - 2 + (isPangram(word, letters) ? 7 : 0);

// Letters may repeat, but every character must come from the 7 given letters.
function checkAnagram(
  word: string,
  letters: string,
  isValidWord: (w: string) => boolean,
  used: { has: (w: string) => boolean },
): string | null {
  if (!/^[a-z]+$/.test(word)) return "use letters only.";

  if (word.length < ANAGRAM_MIN_LENGTH) {
    return `your word must be at least ${ANAGRAM_MIN_LENGTH} letters.`;
  }

  for (const c of word) {
    if (!letters.includes(c)) {
      return `"${c.toUpperCase()}" isn't one of the letters.`;
    }
  }

  if (!isValidWord(word)) return "that word isn't in the dictionary.";

  if (used.has(word)) return "you already used that word.";

  return null;
}

// Exactly one letter different from the current word, a real word, not reused.
function checkWordChange(
  word: string,
  current: string,
  isValidWord: (w: string) => boolean,
  seen: string[],
): string | null {
  if (!/^[a-z]+$/.test(word)) return "use letters only.";

  if (word.length !== current.length) {
    return `use a ${current.length}-letter word.`;
  }

  let diff = 0;
  for (let i = 0; i < word.length; i++) if (word[i] !== current[i]) diff++;

  if (diff === 0) return "that's the same word.";
  if (diff > 1) return "change exactly one letter.";

  if (!isValidWord(word)) return "that word isn't in the dictionary.";

  if (seen.includes(word)) return "you already used that word.";

  return null;
}

'''

G_FLAGS = r'''

  const isAnagram = mode === "anagram";
  const isWordChange = mode === "wordChange";
  const isRaceMode = !isTimed && !isAnagram && !isWordChange; // generic race UI'''

G_ANAGRAM_OVER = r'''

  // computed from the shared clock directly, so a stale raceTime can't flash results
  const anagramOver =
    isAnagram &&
    !!game?.started_at &&
    now() - new Date(game?.started_at ?? 0).getTime() >=
      (ANAGRAM_SECONDS + ANAGRAM_GRACE_S) * 1000;'''

G_WINNER = r'''const winner = isTimed
    ? (timedRanking[0] ?? null)
    : isAnagram
      ? ranked[0] && ranked[0].progress > 0
        ? ranked[0]
        : null
      : raceWinner;'''

G_WC_VARS = r'''

  const [wcStart, wcEnd = ""] = (currentPrompt?.fragment ?? "-").split("-");
  const wcCurrent = chain[chain.length - 1] ?? wcStart;'''

G_HANDLERS = r'''const handleAnagramSubmit = (event: FormEvent) => {
    event.preventDefault();

    const startMs = game?.started_at ? new Date(game.started_at).getTime() : NaN;

    if (!currentPrompt || !Number.isFinite(startMs) || now() < startMs) return;

    if (now() >= startMs + ANAGRAM_SECONDS * 1000) {
      setMessage("time's up!");
      return;
    }

    const word = input.trim().toLowerCase();
    const problem = checkAnagram(word, currentPrompt.fragment, isValidWord, used);

    if (problem) {
      setMessage(problem);
      return;
    }

    const points = anagramPoints(word, currentPrompt.fragment);
    const nextScore = index + points; // `index` doubles as my score in anagram

    setUsed((cur) => new Set(cur).add(word));
    setIndex(nextScore);
    setInput("");
    setMessage(
      isPangram(word, currentPrompt.fragment)
        ? `pangram! +${points}`
        : `+${points}`,
    );

    queueSave(() => saveProgress(nextScore));
  };

  const handleWordChangeSubmit = (event: FormEvent) => {
    event.preventDefault();

    if (!game?.started_at || now() < new Date(game.started_at).getTime()) return;

    if (!currentPrompt || iFinished) return;

    const word = input.trim().toLowerCase();
    const problem = checkWordChange(word, wcCurrent, isValidWord, [
      wcStart,
      ...chain,
    ]);

    if (problem) {
      setMessage(problem);
      return;
    }

    setInput("");

    if (word !== wcEnd) {
      setChain((c) => [...c, word]);
      setMessage("good, keep going.");
      return;
    }

    // puzzle solved
    const nextIndex = index + 1;

    setIndex(nextIndex);
    setChain([]);
    setMessage(nextIndex >= target ? "" : "solved!");

    if (nextIndex >= target) {
      // progress first, then the finish RPC (server checks progress >= target)
      queueSave(async () => {
        await saveProgress(target);
        await saveFinished(target);
      });
    } else {
      queueSave(() => saveProgress(nextIndex));
    }
  };

  '''

G_ANAGRAM_BOARD = r'''const renderAnagramBoard = () => {
    const rows = phase === "results" ? ranked : players;
    const top = Math.max(1, ...players.map(progressOf));

    return (
      <div className="mp-board">
        {rows.map((p) => {
          const pts = progressOf(p);
          const isWinner =
            phase === "results" && winner?.player_id === p.player_id;

          return (
            <div
              key={p.player_id}
              className={p.player_id === me ? "mp-row mp-me" : "mp-row"}
            >
              <span className="mp-name">
                {isWinner && (
                  <span style={{ marginRight: "6px", fontSize: "15px" }}>
                    👑
                  </span>
                )}
                {p.display_name}
              </span>

              <div className="mp-bar">
                <i style={{ width: `${(pts / top) * 100}%` }} />
              </div>

              <span className="mp-count">{pts} pts</span>
            </div>
          );
        })}
      </div>
    );
  };

  '''

G_GOAL = r'''const goalText = isAnagram
    ? `make as many words as you can in ${ANAGRAM_SECONDS}s. letters can repeat. use all 7 for +7.`
    : isWordChange
      ? `change one letter at a time to reach the target word. ${
          game?.finish_mode === "last" ? "everyone must solve" : "first to solve"
        } ${WORD_CHANGE_PUZZLES} ladders${game?.finish_mode === "last" ? "" : " wins"}.`
      : isSurvival ?'''

G_RENDER = r'''{/* ============ RACE (anagram) ============ */}
      {phase === "race" && isAnagram && currentPrompt && (
        <div className="mp-race">
          <div className="timer">
            {Math.max(0, ANAGRAM_SECONDS - raceTime).toFixed(1)}s
          </div>

          <div className="prompt">
            <small>YOUR SCORE · {myProgress}</small>

            <strong>{displayPrompt(currentPrompt.fragment, mode)}</strong>

            <p>
              3+ letter words using only these letters. repeats allowed. longer
              = more points. all 7 letters = +7.
            </p>
          </div>

          <form onSubmit={handleAnagramSubmit}>
            <div className="entry">
              <input
                id="mp-word"
                value={input}
                onChange={(e) =>
                  setInput(
                    e.target.value.replace(/[^a-zA-Z]/g, "").toLowerCase(),
                  )
                }
                autoFocus
                autoComplete="off"
                placeholder="type a word..."
              />

              <button type="submit">enter</button>
            </div>

            <div className="message">{message}</div>
          </form>

          {used.size > 0 && (
            <p className="rule">{[...used].reverse().join(" · ")}</p>
          )}

          <div className="divider" />

          {renderAnagramBoard()}

          {syncError && <div className="message">{syncError}</div>}
        </div>
      )}

      {/* ============ RACE (word change) ============ */}
      {phase === "race" && isWordChange && (
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
                  LADDER {index + 1} OF {WORD_CHANGE_PUZZLES}
                </small>

                <strong>
                  {wcStart.toUpperCase()} → {wcEnd.toUpperCase()}
                </strong>

                <p>change one letter at a time. every step must be a real word.</p>
              </div>

              <div className="mp-last">
                <small>{[wcStart, ...chain].join(" → ")}</small>
                <strong>{wcCurrent}</strong>
              </div>

              <form onSubmit={handleWordChangeSubmit}>
                <div className="entry">
                  <input
                    id="mp-word"
                    value={input}
                    maxLength={wcStart.length}
                    onChange={(e) =>
                      setInput(
                        e.target.value.replace(/[^a-zA-Z]/g, "").toLowerCase(),
                      )
                    }
                    autoFocus
                    autoComplete="off"
                    placeholder={`${wcStart.length}-letter word...`}
                  />

                  <button type="submit">enter</button>
                </div>

                <div className="message">{message}</div>

                {chain.length > 0 && (
                  <button
                    type="button"
                    className="lb-skip"
                    onClick={() => setChain((c) => c.slice(0, -1))}
                  >
                    undo last step
                  </button>
                )}
              </form>
            </>
          )}

          <div className="divider" />

          {renderScoreboard()}

          {syncError && <div className="message">{syncError}</div>}
        </div>
      )}

      '''


def patch_group(s):
    s = rep(s, '| "survival" | "startEnd" | "math";', '| "survival" | "startEnd" | "math" | "anagram" | "wordChange";', "g GroupMode")
    s = after(s, "const BACKUP_GRACE_MS = 2000; // non-host clients step in if the host is stalled", G_CONSTS, "g consts")
    s = rep(s, "hint: `${TARGET_WORDS} arithmetic problems`, }, ];", G_MODE_OPTIONS, "g MODE_OPTIONS")
    s = rep(
        s,
        'const targetOf = (mode: GroupMode) => mode === "alphabet" ? ALPHABET_TARGET : TARGET_WORDS;',
        G_TARGET,
        "g targetOf",
    )
    s = rep(
        s,
        'const promptCountFor = (mode: GroupMode) => mode === "alphabet" || mode === "timed" || mode === "survival" ? PROMPT_POOL_SIZE : TARGET_WORDS;',
        G_PROMPT_COUNT,
        "g promptCountFor",
    )
    s = after(s, "function displayPrompt(fragment: string, mode: GroupMode) {", G_DISPLAY, "g displayPrompt")
    s = before(s, "// checkAnswer(word, prompt, mode, isValidWord, used): the single entry point", G_CHECKERS, "g checkers")

    s = after(
        s,
        "const [letters, setLetters] = useState<Set<string>>(new Set()); // alphabet",
        "\n  const [chain, setChain] = useState<string[]>([]); // word change: my steps after the start word",
        "g chain state",
    )
    s = rep(
        s,
        "setLetters(new Set()); } }, [game?.game_number]);",
        "setLetters(new Set());\n      setChain([]);\n    }\n  }, [game?.game_number]);",
        "g effect5",
    )
    s = after(s, "const isMath = isMathMode(mode);", G_FLAGS, "g flags")
    s = rep(s, 'const unitName = isMath ? "problems" : "words";', 'const unitName = isMath ? "problems" : isWordChange ? "puzzles" : "words";', "g unitName")
    s = after(
        s,
        '!!raceWinner && (game?.finish_mode === "first" || everyoneFinished);',
        G_ANAGRAM_OVER,
        "g anagramOver",
    )
    s = rep(s, "const winner = isTimed ? (timedRanking[0] ?? null) : raceWinner;", G_WINNER, "g winner")
    s = rep(
        s,
        ": (isTimed ? timedOver : raceIsOver)",
        ": (isTimed ? timedOver : isAnagram ? anagramOver : raceIsOver)",
        "g phase",
    )
    s = after(
        s,
        "? game.prompts[index % game.prompts.length] : undefined;",
        G_WC_VARS,
        "g wc vars",
    )
    s = before(s, "// handleTimedSubmit(event): takes a form event, returns nothing. Word", G_HANDLERS, "g handlers")
    s = before(s, "// renderTimedBoard(): takes nothing, returns JSX (or null with no turn", G_ANAGRAM_BOARD, "g anagram board")
    s = rep(s, "const goalText = isSurvival ?", G_GOAL, "g goalText")

    # lobby settings
    s = rep(
        s,
        ") : modeChoice === \"survival\" ? (",
        ') : modeChoice === "survival" || modeChoice === "anagram" ? (',
        "g lobby finish mode",
    )
    s = rep(
        s,
        '{ <> <div className="divider" /> <div className="setting"> <small>difficulty</small>',
        '{modeChoice !== "anagram" && (\n                <>\n                  <div className="divider" />\n\n                  <div className="setting">\n                    <small>difficulty</small>',
        "g difficulty open",
    )
    s = rep(
        s,
        "</> } {/* START BUTTON (host only):",
        "</>\n              )}\n\n              {/* START BUTTON (host only):",
        "g difficulty close",
    )
    s = rep(
        s,
        ': modeChoice === "startEnd" ? START_END_HINTS[option.value]',
        ': modeChoice === "wordChange" ? (option.value === "superEasy" ? "4 letters, short ladders" : "5 letters, long ladders") : modeChoice === "startEnd" ? START_END_HINTS[option.value]',
        "g difficulty hints",
    )

    # race UI
    s = rep(s, '{phase === "race" && !isTimed && (', '{phase === "race" && isRaceMode && (', "g race condition")
    s = before(s, "{/* ============ RACE (timed / hot potato) ============ */}", G_RENDER, "g render")

    # results
    s = rep(
        s,
        "{isTimed ? renderTimedBoard() : renderScoreboard()}",
        "{isTimed\n            ? renderTimedBoard()\n            : isAnagram\n              ? renderAnagramBoard()\n              : renderScoreboard()}",
        "g results board",
    )
    s = rep(s, '{isSurvival ? "last player standing with time left"', '{isAnagram ? "most points" : isSurvival ? "last player standing with time left"', "g results subtitle")
    s = rep(s, ': `first to ${TARGET_WORDS} ${unitName}`}', ': `first to ${target} ${unitName}`}', "g results target")
    return s


def main():
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    app_p, grp_p, lb_p = sys.argv[1:4]
    out = {}
    for path, fn in ((app_p, patch_app), (grp_p, patch_group), (lb_p, patch_leaderboard)):
        with open(path, encoding="utf-8") as f:
            out[path] = fn(f.read())
    for path, text in out.items():
        shutil.copyfile(path, path + ".bak")
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        print("patched", path)


if __name__ == "__main__":
    main()
