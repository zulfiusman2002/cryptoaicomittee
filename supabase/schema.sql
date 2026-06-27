-- ============================================================
-- Crypto Signal Intelligence Engine — Supabase Schema
-- Run this in your Supabase SQL editor
-- ============================================================

-- Enable UUID extension (usually already enabled)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── scans ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  status          text NOT NULL DEFAULT 'pending',  -- pending | running | complete | error
  universe_count  int,
  top_signal      text,
  summary         jsonb
);

-- ── coin_metrics ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coin_metrics (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id              uuid NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  created_at           timestamptz NOT NULL DEFAULT now(),
  symbol               text NOT NULL,
  price                numeric,
  return_1h            numeric,
  return_4h            numeric,
  return_12h           numeric,
  return_24h           numeric,
  volume_shock         numeric,
  oi_change_4h         numeric,
  oi_change_24h        numeric,
  oi_usd_current       numeric,   -- always USD notional
  funding_rate         numeric,
  funding_settled      boolean DEFAULT false,
  hours_since_funding  numeric,   -- hours since last funding settlement
  relative_strength_btc numeric,
  relative_strength_eth numeric,
  taker_buy_ratio      numeric,
  data_quality_flag    int DEFAULT 1,  -- 1=single venue, 2=two venues agree, 3=three agree
  raw_metrics          jsonb
);

-- ── signal_results ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS signal_results (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id               uuid NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  created_at            timestamptz NOT NULL DEFAULT now(),
  symbol                text NOT NULL,
  verdict               text NOT NULL,  -- BUY WATCH | BUY ON BREAKOUT | BUY ON PULLBACK | WAIT | AVOID | SELL/EXIT WARNING
  risk_label            text,           -- Low | Medium | High | Extreme
  entry_low             numeric,
  entry_high            numeric,
  stop_loss             numeric,
  take_profit_1         numeric,
  take_profit_2         numeric,
  invalidation_condition text,
  gpt_analysis          jsonb,
  claude_challenge      jsonb,
  final_summary         text,
  deterministic_score   numeric,        -- raw rule-based score before AI
  was_downgraded        boolean DEFAULT false
);

-- ── Indexes ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_coin_metrics_scan_id ON coin_metrics(scan_id);
CREATE INDEX IF NOT EXISTS idx_signal_results_scan_id ON signal_results(scan_id);
CREATE INDEX IF NOT EXISTS idx_scans_created_at ON scans(created_at DESC);

-- ── Row Level Security (MVP: read-only public, service role writes) ───
ALTER TABLE scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE coin_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE signal_results ENABLE ROW LEVEL SECURITY;

-- Allow public reads (no auth for MVP)
CREATE POLICY "Public read scans" ON scans FOR SELECT USING (true);
CREATE POLICY "Public read coin_metrics" ON coin_metrics FOR SELECT USING (true);
CREATE POLICY "Public read signal_results" ON signal_results FOR SELECT USING (true);

-- Service role can write (used by Netlify Functions)
CREATE POLICY "Service role write scans" ON scans FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role write coin_metrics" ON coin_metrics FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role write signal_results" ON signal_results FOR ALL USING (auth.role() = 'service_role');
