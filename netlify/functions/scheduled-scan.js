// netlify/functions/scheduled-scan.js
// Cron-triggered scan — runs every 4 hours (schedule set in netlify.toml).
// Uses waitForWrites=true: Lambda freezes the process the instant the handler
// returns, so every DB write must be awaited or it silently dies.
// No HTTP response consumer — results land in Turso and appear in scan history.

const { runScan } = require('./lib/runScan')

exports.handler = async () => {
  console.log('[scheduled-scan] Triggered at', new Date().toISOString())
  try {
    const result = await runScan({ waitForWrites: true, source: 'scheduled' })
    if (!result.ok) {
      console.error('[scheduled-scan] Scan failed:', result.error)
      return { statusCode: 200 } // return 200 so Netlify doesn't retry-storm
    }
    const p = result.payload.paperTrading
    console.log(`[scheduled-scan] Complete. Signals: ${result.payload.topSignals.length}, ` +
      `trades opened: ${p.tradesOpenedThisScan}, closed: ${p.closedThisScan}, ` +
      `equity: £${p.portfolio?.equity}`)
    return { statusCode: 200 }
  } catch (err) {
    console.error('[scheduled-scan] Fatal:', err.message)
    return { statusCode: 200 }
  }
}
