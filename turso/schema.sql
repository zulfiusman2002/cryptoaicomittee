-- ============================================================
-- Crypto Signal Intelligence Engine — Turso / SQLite Schema
-- Run via: turso db shell <db-name> < turso/schema.sql
-- Or paste into Turso dashboard shell
-- ============================================================

CREATE TABLE IF NOT EXISTS scans (
  id              TEXT    PRIMARY KEY,          -- UUID generated in app
  created_at      TEXT    NOT NULL,             -- ISO 8601
  status          TEXT    NOT NULL DEFAULT 'pending',
  universe_count  INTEGER,
  top_signal      TEXT,
  summary_json    TEXT                          -- JSON stringified
);

CREATE TABLE IF NOT EXISTS coin_metrics (
  id                    TEXT    PRIMARY KEY,
  scan_id               TEXT    NOT NULL REFERENCES scans(id),
  created_at            TEXT    NOT NULL,
  symbol                TEXT    NOT NULL,
  price                 REAL,
  return_1h             REAL,
  return_4h             REAL,
  return_12h            REAL,
  return_24h            REAL,
  volume_shock          REAL,
  oi_change_4h          REAL,
  oi_change_24h         REAL,
  oi_usd_current        REAL,
  funding_rate          REAL,
  funding_settled       INTEGER DEFAULT 0,      -- 0=false 1=true
  hours_since_funding   REAL,
  relative_strength_btc REAL,
  relative_strength_eth REAL,
  taker_buy_ratio       REAL,
  data_quality_flag     INTEGER DEFAULT 1,
  raw_metrics_json      TEXT                    -- JSON stringified
);

CREATE TABLE IF NOT EXISTS signal_results (
  id                    TEXT    PRIMARY KEY,
  scan_id               TEXT    NOT NULL REFERENCES scans(id),
  created_at            TEXT    NOT NULL,
  symbol                TEXT    NOT NULL,
  verdict               TEXT    NOT NULL,
  risk_label            TEXT,
  entry_low             REAL,
  entry_high            REAL,
  stop_loss             REAL,
  take_profit_1         REAL,
  take_profit_2         REAL,
  invalidation_condition TEXT,
  gpt_analysis_json     TEXT,                  -- JSON stringified
  claude_challenge_json TEXT,                  -- JSON stringified
  final_summary         TEXT,
  deterministic_score   REAL,
  was_downgraded        INTEGER DEFAULT 0      -- 0=false 1=true
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_coin_metrics_scan_id    ON coin_metrics(scan_id);
CREATE INDEX IF NOT EXISTS idx_signal_results_scan_id  ON signal_results(scan_id);
CREATE INDEX IF NOT EXISTS idx_scans_created_at        ON scans(created_at DESC);
