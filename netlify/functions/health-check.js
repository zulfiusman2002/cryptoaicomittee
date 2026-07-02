// netlify/functions/health-check.js
const { createClient } = require('@libsql/client')

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
}

async function checkTurso() {
  const url   = process.env.TURSO_DATABASE_URL
  const token = process.env.TURSO_AUTH_TOKEN
  if (!url || !token) {
    console.error('[health] Turso env vars missing')
    return false
  }
  try {
    const db = createClient({ url, authToken: token })
    await db.execute({ sql: 'SELECT 1', args: [] })
    console.log('[health] Turso OK')
    return true
  } catch (err) {
    console.error('[health] Turso failed:', err.message)
    return false
  }
}

async function checkMarketData() {
  // CoinGecko /ping — confirmed accessible from AWS/serverless infrastructure
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/ping', {
      signal: AbortSignal.timeout(8000),
      headers: { 'Accept': 'application/json', 'User-Agent': 'CSIE/1.0' }
    })
    console.log('[health] CoinGecko ping HTTP', res.status)
    if (!res.ok) return false
    const json = await res.json()
    return !!json.gecko_says
  } catch (err) {
    console.error('[health] CoinGecko unreachable:', err.message)
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
    binance:   marketOk,   // key stays 'binance' — frontend Market Data pill reads this
    timestamp: new Date().toISOString()
  }

  console.log('[health]', JSON.stringify(results))
  return { statusCode: 200, headers, body: JSON.stringify(results) }
}
