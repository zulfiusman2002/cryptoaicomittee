// Read-only analytics endpoint — computes everything from Turso.
const db = require('./lib/db')
const A = require('./lib/analytics')

const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }

exports.handler = async () => {
  try {
    const [allTrades, withScores, withBtc, btcPrices, latestReview] = await Promise.all([
      db.getAllPaperTrades(),
      db.getTradesWithScores(),
      db.getTradesWithBtcRegime(),
      db.getBtcBenchmarkPrices(),
      db.getLatestWeeklyReview()
    ])

    const stats    = A.honestStats(allTrades)
    const curve    = A.equityCurve(allTrades)
    const outcomes = A.outcomeBreakdown(allTrades)
    const conc     = A.concentration(allTrades)
    const shadow   = A.shadowBarrierSim(allTrades)
    const scoreOut = A.scoreVsOutcome(withScores)
    const regime   = A.regimeSplit(withBtc)

    const lastEquity = curve.length ? curve[curve.length - 1].equity : A.STARTING_CAPITAL
    const portfolioReturnPct = +(((lastEquity - A.STARTING_CAPITAL) / A.STARTING_CAPITAL) * 100).toFixed(2)
    const bench = A.benchmark(portfolioReturnPct, btcPrices.first?.price, btcPrices.last?.price)
    const gates = A.readinessGates({ stats, bench, conc, outcomes })

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        stats, equityCurve: curve, outcomes, concentration: conc,
        shadowBarriers: { ...shadow, combos: shadow.combos.slice(0, 8) },
        scoreVsOutcome: scoreOut, regime, benchmark: {
          ...bench, portfolioReturnPct,
          periodStart: btcPrices.first?.created_at, periodEnd: btcPrices.last?.created_at
        },
        readiness: gates,
        weeklyReview: latestReview
      })
    }
  } catch (err) {
    console.error('[analytics] failed:', err)
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) }
  }
}
