// netlify/functions/lib/db.js
// Turso / libSQL client.

const { createClient } = require('@libsql/client')

function getClient() {
  return createClient({
    url:       process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  })
}

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

function now() {
  return new Date().toISOString()
}

// ── Auto-create tables if they don't exist ────────────────────
// This fixes "no such table: scans" without requiring manual schema setup.
// Safe to run on every cold start — IF NOT EXISTS means no-op if tables exist.
async function ensureTables(db) {
  await db.batch([
    {
      sql: `CREATE TABLE IF NOT EXISTS scans (
        id              TEXT    PRIMARY KEY,
        created_at      TEXT    NOT NULL,
        status          TEXT    NOT NULL DEFAULT 'pending',
        universe_count  INTEGER,
        top_signal      TEXT,
        summary_json    TEXT
      )`, args: []
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS coin_metrics (
        id                    TEXT PRIMARY KEY,
        scan_id               TEXT NOT NULL,
        created_at            TEXT NOT NULL,
        symbol                TEXT NOT NULL,
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
        funding_settled       INTEGER DEFAULT 0,
        hours_since_funding   REAL,
        relative_strength_btc REAL,
        relative_strength_eth REAL,
        taker_buy_ratio       REAL,
        data_quality_flag     INTEGER DEFAULT 1,
        raw_metrics_json      TEXT
      )`, args: []
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS signal_results (
        id                    TEXT PRIMARY KEY,
        scan_id               TEXT NOT NULL,
        created_at            TEXT NOT NULL,
        symbol                TEXT NOT NULL,
        verdict               TEXT NOT NULL,
        risk_label            TEXT,
        entry_low             REAL,
        entry_high            REAL,
        stop_loss             REAL,
        take_profit_1         REAL,
        take_profit_2         REAL,
        invalidation_condition TEXT,
        gpt_analysis_json     TEXT,
        claude_challenge_json TEXT,
        final_summary         TEXT,
        deterministic_score   REAL,
        was_downgraded        INTEGER DEFAULT 0
      )`, args: []
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS paper_trades (
        id                TEXT PRIMARY KEY,
        scan_id           TEXT,
        symbol            TEXT NOT NULL,
        verdict           TEXT,
        entry_price       REAL NOT NULL,
        stop_loss         REAL,
        tp1               REAL,
        tp2               REAL,
        opened_at         TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'open',
        closed_at         TEXT,
        exit_price        REAL,
        pnl_pct           REAL,
        mfe_pct           REAL,
        mae_pct           REAL,
        last_price        REAL,
        data_completeness TEXT
      )`, args: []
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_paper_trades_status ON paper_trades(status)`,
      args: []
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_coin_metrics_scan_id ON coin_metrics(scan_id)`,
      args: []
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_signal_results_scan_id ON signal_results(scan_id)`,
      args: []
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_scans_created_at ON scans(created_at DESC)`,
      args: []
    }
  ])
}

// Singleton — run once per cold start, not per request
let tablesReady = false
async function getReadyClient() {
  const db = getClient()
  if (!tablesReady) {
    await ensureTables(db)
    // Migration for pre-existing DBs: add last_price if missing.
    // SQLite errors on duplicate ADD COLUMN — catch and ignore means "already there".
    try {
      await db.execute({ sql: 'ALTER TABLE paper_trades ADD COLUMN last_price REAL', args: [] })
      console.log('[db] Migrated: added paper_trades.last_price')
    } catch { /* column already exists */ }
    tablesReady = true
    console.log('[db] Tables verified/created')
  }
  return db
}


// ── scans ─────────────────────────────────────────────────────

async function createScan({ status = 'running', universe_count = 20 } = {}) {
  const db = await getReadyClient()
  const id = uuid()
  const created_at = now()
  await db.execute({
    sql: `INSERT INTO scans (id, created_at, status, universe_count)
          VALUES (?, ?, ?, ?)`,
    args: [id, created_at, status, universe_count]
  })
  return { id, created_at, status, universe_count }
}

async function updateScan(id, { status, top_signal, summary }) {
  const db = await getReadyClient()
  await db.execute({
    sql: `UPDATE scans SET status = ?, top_signal = ?, summary_json = ?
          WHERE id = ?`,
    args: [status, top_signal ?? null, summary ? JSON.stringify(summary) : null, id]
  })
}

async function getScans(limit = 20) {
  const db = await getReadyClient()
  const result = await db.execute({
    sql: `SELECT id, created_at, status, universe_count, top_signal, summary_json
          FROM scans
          ORDER BY created_at DESC
          LIMIT ?`,
    args: [limit]
  })
  return result.rows.map(deserializeScan)
}

async function getScanById(id) {
  const db = await getReadyClient()
  const result = await db.execute({
    sql: `SELECT * FROM scans WHERE id = ?`,
    args: [id]
  })
  if (!result.rows.length) return null
  return deserializeScan(result.rows[0])
}

function deserializeScan(row) {
  return {
    id:             row.id,
    created_at:     row.created_at,
    status:         row.status,
    universe_count: row.universe_count,
    top_signal:     row.top_signal,
    summary:        row.summary_json ? JSON.parse(row.summary_json) : null
  }
}

// ── coin_metrics ──────────────────────────────────────────────

async function insertCoinMetrics(scanId, metrics) {
  const db = await getReadyClient()
  // Batch insert using individual executes (libSQL supports batch)
  const statements = metrics.map(m => ({
    sql: `INSERT INTO coin_metrics (
            id, scan_id, created_at, symbol, price,
            return_1h, return_4h, return_12h, return_24h,
            volume_shock, oi_change_4h, oi_change_24h, oi_usd_current,
            funding_rate, funding_settled, hours_since_funding,
            relative_strength_btc, relative_strength_eth,
            taker_buy_ratio, data_quality_flag, raw_metrics_json
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      uuid(), scanId, now(), m.symbol, m.price ?? null,
      m.return_1h  ?? null, m.return_4h  ?? null,
      m.return_12h ?? null, m.return_24h ?? null,
      m.volume_shock     ?? null,
      m.oi_change_4h     ?? null,
      m.oi_change_24h    ?? null,
      m.oi_usd_current   ?? null,
      m.funding_rate     ?? null,
      m.funding_settled  ? 1 : 0,
      m.hours_since_funding ?? null,
      m.relative_strength_btc ?? null,
      m.relative_strength_eth ?? null,
      m.taker_buy_ratio  ?? null,
      m.data_quality_flag ?? 1,
      m.raw_metrics ? JSON.stringify(m.raw_metrics) : null
    ]
  }))
  await db.batch(statements)
}

async function getCoinMetricsByScan(scanId) {
  const db = await getReadyClient()
  const result = await db.execute({
    sql: `SELECT * FROM coin_metrics WHERE scan_id = ? ORDER BY created_at ASC`,
    args: [scanId]
  })
  return result.rows.map(row => ({
    ...row,
    funding_settled: !!row.funding_settled,
    raw_metrics:     row.raw_metrics_json ? JSON.parse(row.raw_metrics_json) : null
  }))
}

// ── signal_results ────────────────────────────────────────────

async function insertSignalResult(scanId, r) {
  const db = await getReadyClient()
  await db.execute({
    sql: `INSERT INTO signal_results (
            id, scan_id, created_at, symbol, verdict, risk_label,
            entry_low, entry_high, stop_loss, take_profit_1, take_profit_2,
            invalidation_condition, gpt_analysis_json, claude_challenge_json,
            final_summary, deterministic_score, was_downgraded
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      uuid(), scanId, now(),
      r.symbol, r.verdict, r.risk_label ?? null,
      r.entry_low      ?? null, r.entry_high     ?? null,
      r.stop_loss      ?? null,
      r.take_profit_1  ?? null, r.take_profit_2  ?? null,
      r.invalidation_condition ?? null,
      r.gpt_analysis    ? JSON.stringify(r.gpt_analysis)    : null,
      r.claude_challenge ? JSON.stringify(r.claude_challenge) : null,
      r.final_summary   ?? null,
      r.deterministic_score ?? null,
      r.was_downgraded ? 1 : 0
    ]
  })
}

async function getSignalResultsByScan(scanId) {
  const db = await getReadyClient()
  const result = await db.execute({
    sql: `SELECT * FROM signal_results WHERE scan_id = ? ORDER BY created_at ASC`,
    args: [scanId]
  })
  return result.rows.map(row => ({
    ...row,
    was_downgraded:    !!row.was_downgraded,
    gpt_analysis:      row.gpt_analysis_json     ? JSON.parse(row.gpt_analysis_json)     : null,
    claude_challenge:  row.claude_challenge_json  ? JSON.parse(row.claude_challenge_json)  : null,
  }))
}

// ── paper_trades ──────────────────────────────────────────────

async function openPaperTrade(t) {
  const db = await getReadyClient()
  const id = uuid()
  await db.execute({
    sql: `INSERT INTO paper_trades (
            id, scan_id, symbol, verdict, entry_price, stop_loss, tp1, tp2,
            opened_at, status, data_completeness
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      id, t.scan_id ?? null, t.symbol, t.verdict ?? null,
      t.entry_price, t.stop_loss ?? null, t.tp1 ?? null, t.tp2 ?? null,
      now(), 'open', t.data_completeness ?? null
    ]
  })
  return id
}

async function getOpenPaperTrades() {
  const db = await getReadyClient()
  const result = await db.execute({
    sql: `SELECT * FROM paper_trades WHERE status = 'open' ORDER BY opened_at ASC`,
    args: []
  })
  return result.rows
}

async function closePaperTrade(id, { status, exit_price, pnl_pct, mfe_pct, mae_pct }) {
  const db = await getReadyClient()
  await db.execute({
    sql: `UPDATE paper_trades
          SET status = ?, closed_at = ?, exit_price = ?, pnl_pct = ?, mfe_pct = ?, mae_pct = ?
          WHERE id = ?`,
    args: [status, now(), exit_price ?? null, pnl_pct ?? null, mfe_pct ?? null, mae_pct ?? null, id]
  })
}

async function updatePaperTradeExcursions(id, { mfe_pct, mae_pct, last_price }) {
  const db = await getReadyClient()
  await db.execute({
    sql: `UPDATE paper_trades SET mfe_pct = ?, mae_pct = ?, last_price = ? WHERE id = ?`,
    args: [mfe_pct ?? null, mae_pct ?? null, last_price ?? null, id]
  })
}

async function getAllPaperTrades() {
  const db = await getReadyClient()
  const result = await db.execute({
    sql: `SELECT * FROM paper_trades ORDER BY opened_at ASC`,
    args: []
  })
  return result.rows
}

async function getClosedPaperTrades(limit = 50) {
  const db = await getReadyClient()
  const result = await db.execute({
    sql: `SELECT * FROM paper_trades WHERE status != 'open'
          ORDER BY closed_at DESC LIMIT ?`,
    args: [limit]
  })
  return result.rows
}

async function getPaperTradeStats() {
  const db = await getReadyClient()
  const result = await db.execute({
    sql: `SELECT
            COUNT(*)                                          AS total,
            SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END)      AS wins,
            SUM(CASE WHEN pnl_pct <= 0 THEN 1 ELSE 0 END)     AS losses,
            AVG(CASE WHEN pnl_pct > 0 THEN pnl_pct END)       AS avg_win,
            AVG(CASE WHEN pnl_pct <= 0 THEN pnl_pct END)      AS avg_loss,
            SUM(pnl_pct)                                      AS cumulative_pnl
          FROM paper_trades
          WHERE status != 'open'
            AND status != 'expired_nodata'
            AND NOT (status = 'expired' AND pnl_pct = 0 AND mfe_pct = 0 AND mae_pct = 0)`,
    args: []
  })
  return result.rows[0] || null
}



async function healthCheck() {
  const url   = process.env.TURSO_DATABASE_URL
  const token = process.env.TURSO_AUTH_TOKEN

  if (!url || !token) {
    console.error('[db] healthCheck: missing env vars. URL present:', !!url, 'Token present:', !!token)
    return false
  }

  try {
    const client = createClient({ url, authToken: token })
    await Promise.race([
      client.execute({ sql: 'SELECT 1', args: [] }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
    ])
    console.log('[db] healthCheck OK')
    return true
  } catch (err) {
    console.error('[db] healthCheck failed:', err.message)
    return false
  }
}

module.exports = {
  createScan, updateScan, getScans, getScanById,
  insertCoinMetrics, getCoinMetricsByScan,
  insertSignalResult, getSignalResultsByScan,
  openPaperTrade, getOpenPaperTrades, closePaperTrade,
  updatePaperTradeExcursions, getClosedPaperTrades, getPaperTradeStats,
  getAllPaperTrades,
  healthCheck
}
