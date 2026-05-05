-- Pipeline error log for diagnostics panel (ADR-274 follow-up).
-- Stores last 100 pipeline errors across all gene stages.
-- Execute in D1 Console.

CREATE TABLE IF NOT EXISTS pipeline_errors (
  id         TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  stage      TEXT NOT NULL,   -- e.g. "scanner", "trader", "monitor", "genome"
  message    TEXT NOT NULL,
  details    TEXT             -- JSON extra context
);

-- Statement 2: Verify
SELECT COUNT(*) as error_count FROM pipeline_errors;
