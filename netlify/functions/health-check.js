// netlify/functions/health-check.js
// Market data check now probes Bybit V5 (replaces Binance — Bybit not geo-blocked from AWS).

const { createClient } = require('@libsql/client')

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
}

async function checkTurso() {
  const url   = process.env.TURSO_DATABASE_URL
  const token = process.env.TURSO_AUTH_TOKEN
  if (!url || !token) {
    console.error('[health] Turso env vars missing. URL present:', !!url, 'Token present:', !!token)
    return false
  }
  try {
    const db = createClient({ url, authToken: token })
    await db.execute({ sql: 'SELECT 1 AS ok', args: [] })
    console.log('[health] Turso OK')
    return true
  } catch (err) {
    console.error('[health] Turso failed:', err.message)
    return false
  }
}

async function checkMarketData() {
  // Probe Bybit V5 time endpoint — public, no key, not geo-blocked from AWS
  try {
    const res = await fetch('https://api.bybit.com/v5/market/time', {
      signal: AbortSignal.timeout(6000),
      headers: { 'User-Agent': 'CSIE/1.0' }
    })
    console.log('[health] Bybit ping HTTP', res.status)
    if (!res.ok) return false
    const json = await res.json()
    return json.retCode === 0
  } catch (err) {
    console.error('[health] Bybit unreachable:', err.message)
    return false
  }
}

exports.handler = async () => {
  const [tursoOk, marketOk] = await Promise.all([
    checkTurso(),
    checkMarketData()
  ])

  const results = {
    turso:     tursoOk,
    openai:    !!process.env.OPENAI_API_KEY,
    claude:    !!process.env.ANTHROPIC_API_KEY,
    binance:   marketOk,   // key kept as 'binance' — frontend reads this key for Market Data pill
    timestamp: new Date().toISOString()
  }

  console.log('[health]', JSON.stringify(results))
  return { statusCode: 200, headers, body: JSON.stringify(results) }
}
