import { useEffect, useState } from "react";

const SUPABASE_URL = "https://frnjbjhigceptzwtmyax.supabase.co";
const SUPABASE_KEY = "sb_publishable_mB2ZU7RWDpQdPA-mIh8tKw_oxs1_2_B";
const MAX_NAME_LENGTH = 15;
const DEVICE_KEY = "wordtimer_device";

export type RankedMode =
  | "timed"
  | "rush"
  | "letter"
  | "alphabet"
  | "sevenRush"
  | "startEnd"
  | "mathEasy"
  | "mathMed"
  | "daily"
  | "anagram"
  | "wordChange";

export type Period = "alltime" | "daily";

export type LeaderboardEntry = {
  name: string;
  color: string;
  score: number;
  createdAt: string;
};

const DIFFICULTY_LABELS: Record<string, string> = {
  superEasy: "easy",
  hard: "hard",
};

const MODE_LABELS: Record<RankedMode, string> = {
  timed: "timed",
  rush: "rush",
  letter: "letter",
  alphabet: "alphabet",
  sevenRush: "sixrush",
  startEnd: "start/end",
  mathEasy: "math easy",
  mathMed: "math hard",
  daily: "daily",
  anagram: "anagram",
  wordChange: "word change",
};

export function isRankedMode(mode: string): mode is RankedMode {
  return (
    mode === "timed" ||
    mode === "rush" ||
    mode === "letter" ||
    mode === "alphabet" ||
    mode === "sevenRush" ||
    mode === "startEnd" ||
    mode === "mathEasy" ||
    mode === "mathMed" ||
    mode === "daily" ||
    mode === "anagram" ||
    mode === "wordChange"
  );
}

// noDifficulty(mode): takes a RankedMode, returns true for modes where the
// easy/hard setting does nothing (daily, anagram, word change). Every RPC call
// below pins these to "superEasy" so they all share one board instead of
// splitting into separate easy and hard boards.
const noDifficulty = (mode: RankedMode) =>
  mode === "letter" ||
  mode === "daily" ||
  mode === "anagram" ||
  mode === "wordChange";

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${fn} failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<T>;
}

// getDeviceId(): returns a random id kept in localStorage. The server uses it
// (with IP limits) to enforce one daily-mode run per device per day. It is not
// a security boundary on its own, just one layer of friction.
export function getDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

// startRun(...): asks the server to start the clock for a new game. The server
// creates the run id, counts the game in the public counter, and returns the id.
// Pass "unranked" for modes with no leaderboard (zen).
export async function startRun(
  mode: RankedMode | "unranked",
  difficulty: string,
  roundTime: number | null,
  deviceId: string,
) {
  const diff =
    mode === "unranked" || noDifficulty(mode) ? "superEasy" : difficulty;

  return rpc<string>("start_run", {
    p_mode: mode,
    p_difficulty: diff,
    p_round_time: mode === "timed" ? roundTime : null,
    p_device: deviceId,
  });
}

// finishRun(runId, score): tells the server the game ended. The server checks
// the score against its own clock and locks it in. submitScore later uses the
// locked-in score, so the client can't change it after this point.
// finishRun(runId, score, splits): tells the server the game ended. The server
// checks the score and the splits (ms between answers) against its own clock and
// locks them in. submitScore later copies them into the entries row.
export async function finishRun(
  runId: string,
  score: number,
  splits: number[],
) {
  return rpc<boolean>("finish_run", {
    p_run_id: runId,
    p_score: score,
    p_splits: splits,
  });
}

export async function wouldQualify(
  mode: RankedMode,
  difficulty: string,
  roundTime: number | null,
  score: number,
  period: Period,
) {
  return rpc<boolean>("would_qualify", {
    p_mode: mode,
    p_difficulty: noDifficulty(mode) ? "superEasy" : difficulty,
    p_round_time: mode === "timed" ? roundTime : null,
    p_score: score,
    p_period: period,
  });
}

export type ScorePercentile = {
  percentile: number;
  total_scores: number;
};

export async function getScorePercentile(
  mode: RankedMode,
  difficulty: string,
  roundTime: number | null,
  score: number,
) {
  const rows = await rpc<ScorePercentile[]>("get_score_percentile", {
    p_mode: mode,
    p_difficulty: noDifficulty(mode) ? "superEasy" : difficulty,
    p_round_time: mode === "timed" ? roundTime : null,
    p_score: score,
  });

  return rows[0] ?? null;
}

export async function fetchLeaderboard(
  mode: RankedMode,
  difficulty: string,
  roundTime: number | null,
  period: Period = "alltime",
) {
  const rows = await rpc<
    {
      id: number;
      run_id: string;
      mode: string;
      difficulty: string;
      round_time: number | null;
      score: number;
      name: string;
      color: string;
      created_at: string;
    }[]
  >("get_leaderboard", {
    p_mode: mode,
    p_difficulty: noDifficulty(mode) ? "superEasy" : difficulty,
    p_round_time: mode === "timed" ? roundTime : null,
    p_period: period,
  });

  return rows.map((row) => ({
    name: row.name,
    color: row.color,
    score: row.score,
    createdAt: row.created_at,
  }));
}

// submitScore(runId, name, color): saves a finished run to the leaderboard. The
// score, mode and difficulty all come from the server's own record of the run;
// the client only supplies a name and a colour.
export async function submitScore(runId: string, name: string, color: string) {
  return rpc<number>("submit_score", {
    p_run_id: runId,
    p_name: name.trim().slice(0, MAX_NAME_LENGTH),
    p_color: color,
  });
}

export async function getRunRank(runId: string, period: Period = "alltime") {
  return rpc<number>("get_run_rank", {
    p_run_id: runId,
    p_period: period,
  });
}

// formatScore(mode, score): takes a mode and a stored score, returns the text to
// show. Timed scores are word counts, anagram scores are points, and every
// other mode stores milliseconds, shown as seconds with two decimals.
function formatScore(mode: RankedMode, score: number) {
  if (mode === "timed") {
    return `${score} words`;
  }

  if (mode === "anagram") {
    return `${score} pts`;
  }

  return `${(score / 1000).toFixed(2)}s`;
}

function formatModeTitle(mode: RankedMode, difficulty: string) {
  if (
    mode === "startEnd" ||
    mode === "letter" ||
    mode === "mathEasy" ||
    mode === "mathMed" ||
    mode === "daily" ||
    mode === "anagram" ||
    mode === "wordChange"
  ) {
    return MODE_LABELS[mode];
  }

  return `${MODE_LABELS[mode]} - ${DIFFICULTY_LABELS[difficulty] ?? difficulty}`;
}

type LeaderboardProps = {
  mode: RankedMode;
  difficulty: string;
  roundTime?: number | null;
  period?: Period;
  refreshKey?: number;
  highlightRank?: number | null;
};

export function Leaderboard({
  mode,
  difficulty,
  roundTime = null,
  period = "alltime",
  refreshKey = 0,
  highlightRank = null,
}: LeaderboardProps) {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    setError(null);

    fetchLeaderboard(mode, difficulty, roundTime, period)
      .then((rows) => {
        if (!cancelled) setEntries(rows);
      })
      .catch((err) => {
        console.error("LEADERBOARD FETCH ERROR:", err);
        if (!cancelled) setError("couldn't load leaderboard");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [mode, difficulty, roundTime, period, refreshKey]);

  return (
    <div className="leaderboard">
      <div className="section-heading">
        <div>
          <small>{period === "daily" ? "3-day" : "all-time"}</small>
          <h2>{formatModeTitle(mode, difficulty)}</h2>
        </div>
      </div>

      {loading ? (
        <p className="lb-empty">loading...</p>
      ) : error ? (
        <p className="lb-empty">{error}</p>
      ) : entries.length === 0 ? (
        <p className="lb-empty">no scores yet.</p>
      ) : (
        <ol className="lb-list">
          {entries.map((entry, index) => {
            const rank = index + 1;
            const isYou = highlightRank === rank;

            return (
              <li
                className={isYou ? "lb-row lb-you" : "lb-row"}
                key={`${entry.name}-${entry.createdAt}-${index}`}
              >
                <span className="lb-rank">{rank}.</span>
                <span
                  className="lb-dot"
                  style={{ backgroundColor: entry.color }}
                  aria-hidden="true"
                />
                <span className="lb-name">{entry.name}</span>
                <span className="lb-score">
                  {formatScore(mode, entry.score)}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

type LeaderboardSubmitModalProps = {
  mode: RankedMode;
  difficulty: string;
  roundTime: number | null;
  score: number;
  qualifiesAllTime: boolean;
  qualifiesDaily: boolean;
  onSubmit: (name: string, color: string) => Promise<void> | void;
  onClose: () => void;
};

export function LeaderboardSubmitModal({
  mode,
  difficulty,
  roundTime,
  score,
  qualifiesAllTime,
  qualifiesDaily,
  onSubmit,
  onClose,
}: LeaderboardSubmitModalProps) {
  const [name, setName] = useState("");
  const [color, setColor] = useState("#4f8cff");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    const trimmed = name.trim();

    if (!trimmed) {
      setError("enter a name.");
      return;
    }

    if (trimmed.length > MAX_NAME_LENGTH) {
      setError(`name must be ${MAX_NAME_LENGTH} characters or fewer.`);
      return;
    }

    setSubmitting(true);
    setError("");

    try {
      await onSubmit(trimmed, color);
    } catch (err) {
      console.error("LEADERBOARD SUBMIT ERROR:", err);
      setError("couldn't submit score. try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rules-overlay" onClick={onClose}>
      <div className="rules-modal" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="rules-close" onClick={onClose}>
          ×
        </button>

        <small>new leaderboard score</small>
        <h2>you made the leaderboard!!!</h2>

        <p>
          {formatModeTitle(mode, difficulty)}
          {mode === "timed" && roundTime !== null ? ` - ${roundTime}s` : ""}
        </p>

        <p>
          score: <strong>{formatScore(mode, score)}</strong>
        </p>

        <p className="rule">
          {qualifiesAllTime && qualifiesDaily
            ? "your score qualifies for both all-time and 3-day."
            : qualifiesDaily
              ? "your score qualifies for the 3-day leaderboard."
              : "your score qualifies for the all-time leaderboard."}
        </p>

        <form className="lb-form" onSubmit={handleSubmit}>
          <label htmlFor="leaderboard-name">display name</label>
          <input
            id="leaderboard-name"
            value={name}
            onChange={(event) =>
              setName(event.target.value.slice(0, MAX_NAME_LENGTH))
            }
            maxLength={MAX_NAME_LENGTH}
            placeholder="your name"
            autoFocus
            autoComplete="off"
          />

          <label htmlFor="leaderboard-color">color</label>
          <input
            id="leaderboard-color"
            type="color"
            value={color}
            onChange={(event) => setColor(event.target.value)}
          />

          {error && <div className="message">{error}</div>}

          <button type="submit" className="play-again" disabled={submitting}>
            {submitting ? "submitting..." : "submit score"}
          </button>
        </form>
      </div>
    </div>
  );
}
