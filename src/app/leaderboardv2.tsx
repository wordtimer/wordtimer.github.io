import { useEffect, useState, type FormEvent } from "react";

/*
 * Paste these two values from Supabase -> Project Settings -> API.
 * They are meant to be public (the database rules in supabase.sql are what
 * protect the data), so it's fine to commit them to GitHub.
 */
const SUPABASE_URL = "https://frnjbjhigceptzwtmyax.supabase.co";
const SUPABASE_KEY = "sb_publishable_mB2ZU7RWDpQdPA-mIh8tKw_oxs1_2_B";

export const MAX_NAME_LENGTH = 15;

/* Zen is intentionally not ranked. */
export type RankedMode = "timed" | "rush" | "shortrush";

export const isRankedMode = (mode: string): mode is RankedMode =>
  mode === "timed" || mode === "rush" || mode === "shortrush";

export type LeaderboardEntry = {
  name: string;
  color: string;
  score: number;
  createdAt: string;
};

const DIFFICULTY_LABELS: Record<string, string> = {
  superEasy: "super easy",
  easy: "easy",
  medium: "medium",
  hard: "hard",
};

/* ------------------------------------------------------------------ */
/* Database calls                                                      */
/* ------------------------------------------------------------------ */

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY },
    body: JSON.stringify(args),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(data?.message ?? `request failed (${response.status})`);
  }

  return data as T;
}

/** rush modes: milliseconds (lower wins). timed: words answered (higher wins). */
export const wouldQualify = (mode: RankedMode, difficulty: string, score: number) =>
  rpc<boolean>("would_qualify", { p_mode: mode, p_difficulty: difficulty, p_score: score });

export async function fetchLeaderboard(mode: RankedMode, difficulty: string) {
  const rows = await rpc<
    { name: string; color: string; score: number; created_at: string }[]
  >("get_leaderboard", { p_mode: mode, p_difficulty: difficulty });

  return rows.map(
    (row): LeaderboardEntry => ({
      name: row.name,
      color: row.color,
      score: row.score,
      createdAt: row.created_at,
    }),
  );
}

/** Returns the player's rank (1-10). The server re-checks everything. */
export const submitScore = (
  runId: string,
  mode: RankedMode,
  difficulty: string,
  score: number,
  name: string,
  color: string,
) =>
  rpc<number | null>("submit_score", {
    p_run_id: runId,
    p_mode: mode,
    p_difficulty: difficulty,
    p_score: score,
    p_name: name,
    p_color: color,
  });

export function formatScore(mode: RankedMode, score: number) {
  return mode === "timed" ? `${score} words` : `${(score / 1000).toFixed(2)}s`;
}

/* ------------------------------------------------------------------ */
/* Leaderboard list                                                    */
/* ------------------------------------------------------------------ */

type LeaderboardProps = {
  mode: string;
  difficulty: string;
  /** Change this number to force a refetch. */
  refreshKey?: number;
  /** Highlight this rank (1-based), e.g. the player's new entry. */
  highlightRank?: number | null;
};

export function Leaderboard({ mode, difficulty, refreshKey = 0, highlightRank = null }: LeaderboardProps) {
  const [entries, setEntries] = useState<LeaderboardEntry[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!isRankedMode(mode)) return;

    let cancelled = false;
    setEntries(null);
    setFailed(false);

    fetchLeaderboard(mode, difficulty)
      .then((rows) => {
        if (!cancelled) setEntries(rows);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [mode, difficulty, refreshKey]);

  if (!isRankedMode(mode)) {
    return (
      <div className="leaderboard">
        <small>leaderboard</small>
        <p className="lb-empty">zen mode isn't ranked.</p>
      </div>
    );
  }

  return (
    <div className="leaderboard">
      <small>leaderboard</small>
      <h2>
        {mode} · {DIFFICULTY_LABELS[difficulty] ?? difficulty}
      </h2>

      {failed && <p className="lb-empty">couldn't load the leaderboard.</p>}
      {!failed && entries === null && <p className="lb-empty">loading…</p>}
      {entries !== null && entries.length === 0 && (
        <p className="lb-empty">no scores yet. be the first!</p>
      )}

      {entries !== null && entries.length > 0 && (
        <ol className="lb-list">
          {entries.map((entry, index) => (
            <li
              key={`${entry.createdAt}-${index}`}
              className={highlightRank === index + 1 ? "lb-row lb-you" : "lb-row"}
            >
              <span className="lb-rank">{index + 1}</span>
              <span className="lb-dot" style={{ background: entry.color }} />
              {/* Rendered as plain text, so React escapes it: names can't inject HTML. */}
              <span className="lb-name">{entry.name}</span>
              <strong className="lb-score">{formatScore(mode, entry.score)}</strong>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* "You made the leaderboard" modal                                    */
/* ------------------------------------------------------------------ */

type ModalProps = {
  mode: RankedMode;
  difficulty: string;
  score: number;
  onSubmit: (name: string, color: string) => Promise<void>;
  onClose: () => void;
};

export function LeaderboardSubmitModal({ mode, difficulty, score, onSubmit, onClose }: ModalProps) {
  const [name, setName] = useState("");
  const [color, setColor] = useState("#4f8cff");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const trimmed = name.trim();

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!trimmed || busy) return;

    setBusy(true);
    setError("");

    try {
      await onSubmit(trimmed, color);
      // The parent closes the modal on success.
    } catch (err) {
      setError(err instanceof Error ? err.message : "couldn't submit your score.");
      setBusy(false);
    }
  };

  return (
    <div className="rules-overlay">
      <div className="rules-modal" role="dialog" aria-modal="true" aria-labelledby="lb-modal-title">
        <small>
          {mode} · {DIFFICULTY_LABELS[difficulty] ?? difficulty}
        </small>
        <h2 id="lb-modal-title">you made the leaderboard!</h2>
        <p>
          your result: <strong>{formatScore(mode, score)}</strong>
        </p>

        <form onSubmit={handleSubmit} className="lb-form">
          <label htmlFor="lb-name">display name</label>
          <input
            id="lb-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={MAX_NAME_LENGTH}
            autoComplete="off"
            autoFocus
            placeholder="your name"
          />

          <label htmlFor="lb-color">your color</label>
          <input
            id="lb-color"
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
          />

          {error && <div className="message">{error}</div>}

          <button type="submit" className="play-again" disabled={!trimmed || busy}>
            {busy ? "submitting…" : "submit"}
          </button>

          <button type="button" className="lb-skip" onClick={onClose} disabled={busy}>
            skip
          </button>
        </form>
      </div>
    </div>
  );
}
