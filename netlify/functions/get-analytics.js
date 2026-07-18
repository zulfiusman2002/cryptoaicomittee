// Read-only analytics endpoint — computes everything from Turso.
const db = require('./lib/db')
const A = require('./lib/analytics')

const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }

exports.handler = async () => {
  try {
    const [allTrades, withScores, withBtc, btcPrices, latestReview, coinMetrics] = await Promise.all([
      db.getAllPaperTrades(),
      db.getTradesWithScores(),
      db.getTradesWithBtcRegime(),
      db.getBtcBenchmarkPrices(),
      db.getLatestWeeklyReview(),
      db.getAllCoinMetrics()
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

    // ── v2: forward returns → base-rate test + shadow strategies ──
    const forwardReturns = A.buildForwardReturns(coinMetrics)

    // Map each paper trade back to the exact scan snapshot it was opened from
    const scanTimeBySymbolScan = {}
    for (const m of coinMetrics) {
      scanTimeBySymbolScan[`${m.scan_id}|${m.symbol}`] = new Date(m.created_at).getTime()
    }
    const selectedKeys = []
    for (const t of allTrades) {
      if (A.isArtifact(t) || !t.scan_id) continue
      const ts = scanTimeBySymbolScan[`${t.scan_id}|${t.symbol}`]
      if (ts) selectedKeys.push(`${t.symbol}|${ts}`)
    }

    const baseRate  = A.baseRateTest(forwardReturns, selectedKeys)
    const strategies = A.shadowStrategies(forwardReturns)

    // ── v2: risk metrics + deployment-matched benchmark ──
    const risk = A.riskMetrics(allTrades, curve)
    const periodDays = curve.length > 1
      ? (new Date(curve[curve.length - 1].t) - new Date(curve[0].t)) / 86400000
      : 1
    const matched = A.deploymentMatchedBenchmark(
      allTrades, bench.btcReturnPct, portfolioReturnPct, periodDays)

    const gates = A.readinessGates({ stats, bench, conc, outcomes, matched, baseRate })

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        stats, equityCurve: curve, outcomes, concentration: conc,
        shadowBarriers: { ...shadow, combos: shadow.combos.slice(0, 8) },
        scoreVsOutcome: scoreOut, regime,
        benchmark: {
          ...bench, portfolioReturnPct,
          periodStart: btcPrices.first?.created_at, periodEnd: btcPrices.last?.created_at
        },
        matched, baseRate, strategies, risk,
        readiness: gates,
        weeklyReview: latestReview
      })
    }
  } catch (err) {
    console.error('[analytics] failed:', err)
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) }
  }
}
