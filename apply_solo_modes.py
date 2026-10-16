#!/usr/bin/env python3
"""
Adds solo ANAGRAM and WORD CHANGE modes to your solo file (the one with
`export default function App`).

Usage:  python apply_solo_modes.py <solo file>
  e.g.  python apply_solo_modes.py index.tsx

Run it AFTER apply_patches.py (it relies on makeAnagramPrompt and
makeWordChangePrompt, which that script added). Anchors match ignoring
whitespace. If any anchor fails, nothing is written. A .bak copy is made.
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


CONSTS = r'''

const ANAGRAM_SECONDS = 60;
const WORD_CHANGE_PUZZLES = 3;'''

STATE = r'''

  // ---- anagram + word change (solo) ----
  const wordChangeRef = useRef<PromptItem[]>([]); // the 3 ladders for this run
  const [wcChain, setWcChain] = useState<string[]>([]); // my steps on this ladder
  const [anagramLeft, setAnagramLeft] = useState(ANAGRAM_SECONDS);'''

ANAGRAM_EFFECT = r'''// Effect: anagram round timer. Counts down from ANAGRAM_SECONDS using
  // rushStartTime and ends the game when it hits 0.
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

      if (left <= 0) setGameOver(true);
    };

    update();

    const id = window.setInterval(update, 100);

    return () => window.clearInterval(id);
  }, [started, gameOver, gameMode, rushStartTime]);

  '''

HANDLERS = r'''// submitAnagram(word): solo anagram answer. Letters can repeat, but every
  // character must come from the 7 given letters (stored in `prompt`). Words
  // are 3+ letters and score length - 2, plus 7 for using all 7 letters.
  const submitAnagram = (word: string) => {
    if (Date.now() - (rushStartTime ?? Date.now()) >= ANAGRAM_SECONDS * 1000) {
      setGameOver(true);
      return;
    }

    if (!/^[a-z]+$/.test(word)) {
      setMessage("use letters only.");
      return;
    }

    if (word.length < 3) {
      setMessage("your word must be at least 3 letters.");
      return;
    }

    for (const c of word) {
      if (!prompt.includes(c)) {
        setMessage(`"${c.toUpperCase()}" isn't one of the letters.`);
        return;
      }
    }

    if (!DICTIONARY.has(word) && !MODERN_WORDS.has(word)) {
      setMessage("that word isn't in the dictionary.");
      return;
    }

    if (used.has(word)) {
      setMessage("you already used that word.");
      return;
    }

    const pangram = [...prompt].every((c) => word.includes(c));
    const points = word.length - 2 + (pangram ? 7 : 0);

    setAnswerTimes((current) => [
      ...current,
      (Date.now() - roundStartedAt.current) / 1000,
    ]);
    roundStartedAt.current = Date.now();

    setUsed((current) => new Set(current).add(word));
    setScore((s) => s + points);
    setInput("");
    setMessage(pangram ? `pangram! +${points}` : `+${points}`);
  };

  // submitWordChange(word): solo word change answer. Each step must differ from
  // the current word by exactly one letter, be a real word, and not repeat.
  // Reaching the target word solves the ladder; solving all of them ends the
  // run and saves the total time.
  const submitWordChange = (word: string) => {
    const ladder = wordChangeRef.current[rushWords];

    if (!ladder) return;

    const [start, end = ""] = ladder.fragment.split("-");
    const current = wcChain[wcChain.length - 1] ?? start;

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

    if (!DICTIONARY.has(word) && !MODERN_WORDS.has(word)) {
      setMessage("that word isn't in the dictionary.");
      return;
    }

    if ([start, ...wcChain].includes(word)) {
      setMessage("you already used that word.");
      return;
    }

    setInput("");

    if (word !== end) {
      setWcChain((c) => [...c, word]);
      setMessage("good, keep going.");
      return;
    }

    // ladder solved
    const nextWords = rushWords + 1;

    setAnswerTimes((cur) => [
      ...cur,
      (Date.now() - roundStartedAt.current) / 1000,
    ]);
    roundStartedAt.current = Date.now();

    setScore((s) => s + 1);
    setRushWords(nextWords);
    setWcChain([]);

    if (nextWords >= WORD_CHANGE_PUZZLES) {
      setRushTotalTime((Date.now() - (rushStartTime ?? Date.now())) / 1000);
      setMessage("word change complete!");
      setGameOver(true);
      return;
    }

    setMessage("solved!");
  };

  '''

START_BRANCHES = r'''const now = Date.now();
    if (gameMode === "anagram") {
      const p = makeAnagramPrompt();
      setPrompt(p.fragment);
      setPromptExamples(p.examples);
      setAnagramLeft(ANAGRAM_SECONDS);
    } else if (gameMode === "wordChange") {
      const ladders: PromptItem[] = [];
      for (let i = 0; i < WORD_CHANGE_PUZZLES; i++) {
        ladders.push(makeWordChangePrompt(difficulty));
      }
      wordChangeRef.current = ladders;
      setWcChain([]);
    } else if (gameMode === "startEnd")
      setStartEndPrompt(pickStartEndPrompt(difficulty));'''

WC_DERIVED = r'''// word change: the ladder I'm on right now (start, target, current word)
  const wcLadder = wordChangeRef.current[rushWords];
  const [wcStart, wcEnd = ""] = (wcLadder?.fragment ?? "-").split("-");
  const wcCurrent = wcChain[wcChain.length - 1] ?? wcStart;

  '''

PROMPT_BRANCHES = r'''{gameMode === "anagram" ? (
                <>
                  <small>MAKE WORDS FROM THESE LETTERS</small>
                  <strong>{prompt.toUpperCase().split("").join(" ")}</strong>
                  <p>
                    3+ letters, repeats allowed. longer words score more. all 7
                    letters = +7.
                  </p>
                </>
              ) : gameMode === "wordChange" ? (
                <>
                  <small>
                    LADDER {rushWords + 1} OF {WORD_CHANGE_PUZZLES}
                  </small>
                  <strong>
                    {wcStart.toUpperCase()} → {wcEnd.toUpperCase()}
                  </strong>
                  <p>
                    {[wcStart, ...wcChain].join(" → ")} · change one letter,
                    keep it a real word
                  </p>
                </>
              ) : gameMode === "startEnd" ? (
                <>
                  <small>START WITH / END WITH</small>'''

EXTRA_BELOW_FORM = r'''{/* Anagram: words found so far. Word change: undo a wrong turn. */}
              {gameMode === "anagram" && used.size > 0 && (
                <p className="rule">{[...used].reverse().join(" · ")}</p>
              )}

              {gameMode === "wordChange" && wcChain.length > 0 && (
                <button
                  type="button"
                  className="lb-skip"
                  onClick={() => setWcChain((c) => c.slice(0, -1))}
                >
                  undo last step
                </button>
              )}

              '''

RULES = r'''{/* Rules for anagram mode */}
            <div className="rules-section">
              <strong>anagram</strong>

              <p>
                you get 7 letters and 60 seconds. make as many words as you can
                using only those letters (repeats allowed, 3+ letters). longer
                words score more, and a word using all 7 letters earns +7.
                anagram runs are not ranked.
              </p>
            </div>

            {/* Rules for word change mode */}
            <div className="rules-section">
              <strong>word change</strong>

              <p>
                change the starting word into the target word by changing one
                letter at a time. every step must be a real word. solve 3
                ladders as fast as you can. word change runs are not ranked.
              </p>
            </div>

            '''


def patch(s):
    s = rep(s, '| "startEnd" | "daily" | MathMode;', '| "startEnd" | "daily" | "anagram" | "wordChange" | MathMode;', "GameMode")
    s = rep(
        s,
        '{ value: "daily", label: "daily", hint: "5 words, once a day" }, ];',
        '{ value: "daily", label: "daily", hint: "5 words, once a day" },\n  { value: "anagram", label: "anagram", hint: "60s, words from 7 letters" },\n  { value: "wordChange", label: "word change", hint: "3 ladders, 1 letter at a time" },\n];',
        "MODE_OPTIONS",
    )
    s = after(s, "const TIME_OPTIONS = [5, 10, 20, 60];", CONSTS, "consts")
    s = rep(
        s,
        'mode === "daily" || isMathMode(mode) );',
        'mode === "daily" ||\n    mode === "wordChange" ||\n    isMathMode(mode)\n  );',
        "isRushMode",
    )
    s = rep(
        s,
        'const rushTarget = gameMode === "daily" ? DAILY_WORDS : 10;',
        'const rushTarget =\n    gameMode === "daily"\n      ? DAILY_WORDS\n      : gameMode === "wordChange"\n        ? WORD_CHANGE_PUZZLES\n        : 10;',
        "rushTarget",
    )
    s = after(s, 'const dailyLocked = gameMode === "daily" && dailyRecord?.date === todayKey();', STATE, "state")
    s = before(s, "// Effect 3, per-word countdown (timed mode). Re-runs when started, gameOver,", ANAGRAM_EFFECT, "anagram effect")
    s = before(s, "// submit(event): takes a form event, returns nothing. The enter-key handler.", HANDLERS, "handlers")
    s = rep(
        s,
        "if (gameOver) return; const word = input.trim().toLowerCase(); if (isMathMode(gameMode)) {",
        'if (gameOver) return;\n\n    const word = input.trim().toLowerCase();\n\n    if (gameMode === "anagram") {\n      submitAnagram(word);\n      return;\n    }\n\n    if (gameMode === "wordChange") {\n      submitWordChange(word);\n      return;\n    }\n\n    if (isMathMode(gameMode)) {',
        "submit routing",
    )
    s = rep(
        s,
        'const now = Date.now(); if (gameMode === "startEnd") setStartEndPrompt(pickStartEndPrompt(difficulty));',
        START_BRANCHES,
        "startGame branches",
    )
    s = rep(
        s,
        '? "solve the equation." : "enter a word containing the letters.",',
        '? "solve the equation."\n          : gameMode === "anagram"\n            ? "make words from the 7 letters."\n            : gameMode === "wordChange"\n              ? "change one letter at a time."\n              : "enter a word containing the letters.",',
        "start message",
    )
    s = rep(
        s,
        "if (isRushMode(gameMode)) { setRushStartTime(now);",
        'if (isRushMode(gameMode) || gameMode === "anagram") {\n      setRushStartTime(now);',
        "rushStartTime",
    )

    # leaderboard modal must not crash on unranked modes
    s = rep(
        s,
        '''{gameMode === "zen" ? ( <p> zen mode isn't ranked. pick another mode to view its leaderboard. </p> ) : (''',
        '''{!leaderboardModeFor(gameMode, difficulty) ? (
              <p>
                this mode isn't ranked. pick another mode to view its
                leaderboard.
              </p>
            ) : (''',
        "leaderboard modal guard",
    )

    # results screen
    s = rep(
        s,
        '{gameMode === "zen" || gameMode === "daily" ||',
        '{gameMode === "zen" ||\n                  gameMode === "wordChange" ||\n                  gameMode === "daily" ||',
        "results label",
    )
    s = rep(
        s,
        '<p>{isRushMode(gameMode) ? "seconds" : "words this run"}</p>',
        '<p>\n                {gameMode === "anagram"\n                  ? "points"\n                  : isRushMode(gameMode)\n                    ? "seconds"\n                    : "words this run"}\n              </p>',
        "results unit",
    )

    # active game UI
    s = rep(
        s,
        ': gameMode === "daily" ? "DAILY"',
        ': gameMode === "anagram"\n                              ? "ANAGRAM"\n                              : gameMode === "wordChange"\n                                ? "WORD CHANGE"\n                                : gameMode === "daily"\n                                  ? "DAILY"',
        "top label",
    )
    s = after(
        s,
        '{gameMode === "zen" && <div className="timer">∞</div>}',
        '\n\n                {/* Anagram: seconds left in the round (red at 10s or less) */}\n                {gameMode === "anagram" && (\n                  <div className={anagramLeft <= 10 ? "timer danger" : "timer"}>\n                    {anagramLeft.toFixed(1)}s\n                  </div>\n                )}',
        "anagram timer",
    )
    s = rep(
        s,
        '{gameMode === "startEnd" ? ( <> <small>START WITH / END WITH</small>',
        PROMPT_BRANCHES,
        "prompt branches",
    )
    s = before(
        s,
        "{/* Zen only: button to end the run, since zen has no timer or lives */}",
        EXTRA_BELOW_FORM,
        "below form",
    )
    s = rep(
        s,
        ': gameMode === "startEnd" ? option.value === "hard" ? "80-800 matching words"',
        ': gameMode === "wordChange"\n                  ? option.value === "superEasy"\n                    ? "4 letters, short ladders"\n                    : "5 letters, long ladders"\n                  : gameMode === "startEnd"\n                    ? option.value === "hard"\n                    ? "80-800 matching words"',
        "difficulty hint",
    )
    s = before(
        s,
        "// renderDifficulty(): takes nothing, returns JSX. Draws the difficulty picker:",
        WC_DERIVED,
        "wc derived",
    )
    s = before(s, "{/* Rules for zen mode (no timer, no lives, not ranked) */}", RULES, "rules")
    return s


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    path = sys.argv[1]
    with open(path, encoding="utf-8") as f:
        text = f.read()
    out = patch(text)
    shutil.copyfile(path, path + ".bak2")
    with open(path, "w", encoding="utf-8") as f:
        f.write(out)
    print("patched", path)


if __name__ == "__main__":
    main()
