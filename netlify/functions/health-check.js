// netlify/functions/health-check.js
// Fixed: Turso health check logs actual error on failure.
// Fixed: Binance check probes multiple base URLs and logs HTTP status.

const { createClient } = require('@libsql/client')

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
}

async function checkTurso() {
  const url   = process.env.TURSO_DATABASE_URL
  const token = process.env.TURSO_AUTH_TOKEN

  if (!url || !token) {
    console.error('[health] Turso env vars missing. TURSO_DATABASE_URL:', !!url, 'TURSO_AUTH_TOKEN:', !!token)
    return false
  }

  try {
    const db = createClient({ url, authToken: token })
    const result = await db.execute({ sql: 'SELECT 1 AS ok', args: [] })
    const ok = result.rows?.[0]?.ok === 1 || result.rows?.[0]?.ok === 1n
    console.log('[health] Turso SELECT 1 result:', JSON.stringify(result.rows?.[0]))
    return true // if execute didn't throw, connection is healthy
  } catch (err) {
    console.error('[health] Turso connection failed:', err.message)
    return false
  }
}

async function checkBinance() {
  const bases = [
    'https://api1.binance.com/api/v3',
    'https://api2.binance.com/api/v3',
    'https://api3.binance.com/api/v3',
    'https://api.binance.com/api/v3',
  ]

  for (const base of bases) {
    try {
      const res = await fetch(`${base}/ping`, {
        signal: AbortSignal.timeout(5000),
        headers: { 'User-Agent': 'CSIE/1.0' }
      })
      console.log(`[health] Binance ${base}/ping → HTTP ${res.status}`)
      if (res.ok) return true
    } catch (err) {
      console.warn(`[health] Binance ${base} unreachable: ${err.message}`)
    }
  }
  console.error('[health] All Binance base URLs failed or geo-blocked.')
  return false
}

exports.handler = async () => {
  const [tursoOk, binanceOk] = await Promise.all([
    checkTurso(),
    checkBinance()
  ])

  const results = {
    turso:     tursoOk,
    openai:    !!process.env.OPENAI_API_KEY,
    claude:    !!process.env.ANTHROPIC_API_KEY,
    binance:   binanceOk,
    timestamp: new Date().toISOString()
  }

  console.log('[health] Result:', JSON.stringify(results))

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(results)
  }
}
