import { useEffect, useState } from "react";

const SUPABASE_URL = "https://frnjbjhigceptzwtmyax.supabase.co";
const SUPABASE_KEY = "sb_publishable_mB2ZU7RWDpQdPA-mIh8tKw_oxs1_2_B";
const MAX_NAME_LENGTH = 15;

export type RankedMode = "timed" | "rush" | "alphabet" | "sevenRush";
export type Period = "alltime" | "weekly";

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
  alphabet: "alphabet",
  sevenRush: "sixrush",
};

export function isRankedMode(mode: string): mode is RankedMode {
  return (
    mode === "timed" ||
    mode === "rush" ||
    mode === "alphabet" ||
    mode === "sevenRush"
  );
}

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

export async function wouldQualify(
  mode: RankedMode,
  difficulty: string,
  roundTime: number | null,
  score: number,
  period: Period,
) {
  return rpc<boolean>("would_qualify", {
    p_mode: mode,
    p_difficulty: difficulty,
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
    p_difficulty: difficulty,
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
    p_difficulty: difficulty,
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

export async function submitScore(
  runId: string,
  mode: RankedMode,
  difficulty: string,
  roundTime: number | null,
  score: number,
  name: string,
  color: string,
) {
  return rpc<number>("submit_score", {
    p_run_id: runId,
    p_mode: mode,
    p_difficulty: difficulty,
    p_round_time: mode === "timed" ? roundTime : null,
    p_score: score,
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

function formatScore(mode: RankedMode, score: number) {
  if (mode === "timed") {
    return `${score} words`;
  }

  return `${(score / 1000).toFixed(2)}s`;
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
          <small>{period === "weekly" ? "weekly" : "all-time"}</small>
          <h2>
            {MODE_LABELS[mode]} - {DIFFICULTY_LABELS[difficulty] ?? difficulty}
          </h2>
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
  qualifiesWeekly: boolean;
  onSubmit: (name: string, color: string) => Promise<void> | void;
  onClose: () => void;
};

export function LeaderboardSubmitModal({
  mode,
  difficulty,
  roundTime,
  score,
  qualifiesAllTime,
  qualifiesWeekly,
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
          {MODE_LABELS[mode]} - {DIFFICULTY_LABELS[difficulty] ?? difficulty}
          {mode === "timed" && roundTime !== null ? ` - ${roundTime}s` : ""}
        </p>

        <p>
          score: <strong>{formatScore(mode, score)}</strong>
        </p>

        <p className="rule">
          {qualifiesAllTime && qualifiesWeekly
            ? "your score qualifies for both all-time and weekly."
            : qualifiesWeekly
              ? "your score qualifies for the weekly leaderboard."
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
