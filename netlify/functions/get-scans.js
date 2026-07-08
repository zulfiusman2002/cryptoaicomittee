// netlify/functions/get-scans.js
// ONLY CHANGE: Supabase replaced with db.js (Turso).
// Returns identical JSON shape as before.

const db = require('./lib/db')

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
}

exports.handler = async () => {
  try {
    const scans = await db.getScans(50)
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(scans)
    }
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    }
  }
}
