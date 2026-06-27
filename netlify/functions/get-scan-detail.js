// netlify/functions/get-scan-detail.js
// ONLY CHANGE: Supabase replaced with db.js (Turso).
// Returns identical JSON shape: { scan, metrics, signals }

const db = require('./lib/db')

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
}

exports.handler = async (event) => {
  const scanId = event.queryStringParameters?.id
  if (!scanId) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Missing id' })
    }
  }

  try {
    const [scan, metrics, signals] = await Promise.all([
      db.getScanById(scanId),
      db.getCoinMetricsByScan(scanId),
      db.getSignalResultsByScan(scanId)
    ])

    if (!scan) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Scan not found' })
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ scan, metrics, signals })
    }
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    }
  }
}
