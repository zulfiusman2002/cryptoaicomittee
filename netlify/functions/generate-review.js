// Manual trigger (POST) — lets the user generate the first review immediately.
const { generateReview } = require('./lib/review')
const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' }
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) }
  const result = await generateReview()
  return { statusCode: result.ok ? 200 : 400, headers, body: JSON.stringify(result) }
}
