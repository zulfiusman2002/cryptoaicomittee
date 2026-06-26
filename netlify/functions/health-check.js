// netlify/functions/health-check.js
// Updated: Supabase → Turso. Status key renamed from 'supabase' to 'turso'.
// Frontend StatusPill label already says 'Database' so the UI is unchanged.

const db = require('./lib/db')

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
}

exports.handler = async () => {
  const results = {
    turso:     false,
    openai:    false,
    claude:    false,
    binance:   false,
    timestamp: new Date().toISOString()
  }

  // Turso
  results.turso = await db.healthCheck()

  // OpenAI key present
  results.openai = !!process.env.OPENAI_API_KEY

  // Anthropic key present
  results.claude = !!process.env.ANTHROPIC_API_KEY

  // Binance reachable
  try {
    const res = await fetch('https://api.binance.com/api/v3/ping',
      { signal: AbortSignal.timeout(4000) })
    results.binance = res.ok
  } catch {}

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(results)
  }
}
