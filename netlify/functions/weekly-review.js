// Scheduled Mondays 08:00 UTC (netlify.toml). Awaits everything (Lambda freeze).
const { generateReview } = require('./lib/review')
exports.handler = async () => {
  console.log('[weekly-review] Triggered', new Date().toISOString())
  const result = await generateReview()
  if (!result.ok) console.error('[weekly-review]', result.error)
  return { statusCode: 200 }
}
