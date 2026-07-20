// netlify/functions/scan-market.js
// Thin HTTP wrapper — all logic lives in lib/runScan.js (shared with scheduled-scan).

const { runScan } = require('./lib/runScan')

const headers = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json'
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' }
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) }

  try {
    const result = await runScan({ waitForWrites: false, source: 'manual' })
    if (!result.ok) {
      return { statusCode: result.statusCode, headers,
               body: JSON.stringify({ error: result.error, diagnostics: result.diagnostics, scanId: result.scanId }) }
    }
    return { statusCode: 200, headers, body: JSON.stringify(result.payload) }
  } catch (err) {
    console.error('[scan-market] Fatal:', err)
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) }
  }
}
