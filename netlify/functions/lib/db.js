// netlify/functions/lib/db.js
// Turso / libSQL client.
// Replaces Supabase entirely. All other files are untouched.
// UUIDs are generated here since SQLite has no gen_random_uuid().

const { createClient } = require('@libsql/client')

function getClient() {
  return createClient({
    url:       process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  })
}

function uuid() {
  // RFC 4122 v4 UUID — no dependency needed
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

function now() {
  return new Date().toISOString()
}

// ── scans ─────────────────────────────────────────────────────

async function createScan({ status = 'running', universe_count = 20 } = {}) {
  const db = getClient()
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
  const db = getClient()
  await db.execute({
    sql: `UPDATE scans SET status = ?, top_signal = ?, summary_json = ?
          WHERE id = ?`,
    args: [status, top_signal ?? null, summary ? JSON.stringify(summary) : null, id]
  })
}

async function getScans(limit = 20) {
  const db = getClient()
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
  const db = getClient()
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
  const db = getClient()
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
  const db = getClient()
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
  const db = getClient()
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
  const db = getClient()
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

// ── Health check ──────────────────────────────────────────────

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
  healthCheck
}
