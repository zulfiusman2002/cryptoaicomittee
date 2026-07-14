// netlify/functions/lib/analytics.js
// Pure computation — no I/O. Every function takes rows, returns numbers.
// This is the statistical conscience of the tool: confidence intervals,
// concentration, shadow barrier simulation, benchmark comparison, readiness gates.

const NOTIONAL = 100          // £ per trade (matches paperTrading.js)
const STARTING_CAPITAL = 1000

function isArtifact(t) {
  if (t.status === 'expired_nodata') return true
  return t.status === 'expired' &&
    Number(t.pnl_pct) === 0 && Number(t.mfe_pct) === 0 && Number(t.mae_pct) === 0
}

function realClosed(trades) {
  return (trades || []).filter(t => t.status !== 'open' && !isArtifact(t)
    && t.pnl_pct !== null && t.pnl_pct !== undefined)
}

// ── Honest statistics: mean, SD, SE, t-stat, ~95% CI ─────────
function honestStats(trades) {
  const closed = realClosed(trades)
  const n = closed.length
  if (n === 0) return { n: 0, mean: null, sd: null, se: null, tStat: null, ci95: null, verdict: 'No closed trades yet.' }

  const pnls = closed.map(t => Number(t.pnl_pct))
  const mean = pnls.reduce((a, b) => a + b, 0) / n
  const sd = n > 1
    ? Math.sqrt(pnls.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1))
    : 0
  const se = n > 1 ? sd / Math.sqrt(n) : null
  const tStat = se && se > 0 ? mean / se : null
  const ci95 = se !== null ? [+(mean - 2 * se).toFixed(3), +(mean + 2 * se).toFixed(3)] : null

  let verdict
  if (n < 30) verdict = `n=${n} — below the 30-trade threshold. Any conclusion is premature.`
  else if (tStat === null || Math.abs(tStat) < 2) verdict = `Edge is statistically indistinguishable from zero (t=${tStat?.toFixed(2)}). Do not trade real money on this yet.`
  else if (mean > 0) verdict = `Positive edge with statistical support (t=${tStat.toFixed(2)}). Meets the minimum bar.`
  else verdict = `Statistically significant NEGATIVE edge (t=${tStat.toFixed(2)}). The strategy is losing reliably.`

  return {
    n,
    mean: +mean.toFixed(3),
    sd: +sd.toFixed(3),
    se: se !== null ? +se.toFixed(3) : null,
    tStat: tStat !== null ? +tStat.toFixed(2) : null,
    ci95,
    verdict
  }
}

// ── Equity curve: cumulative realized P&L over time ──────────
function equityCurve(trades) {
  const closed = realClosed(trades)
    .filter(t => t.closed_at)
    .sort((a, b) => new Date(a.closed_at) - new Date(b.closed_at))
  let equity = STARTING_CAPITAL
  const points = [{ t: closed[0]?.opened_at || new Date().toISOString(), equity: STARTING_CAPITAL }]
  for (const tr of closed) {
    equity += NOTIONAL * (Number(tr.pnl_pct) / 100)
    points.push({ t: tr.closed_at, equity: +equity.toFixed(2), symbol: tr.symbol, pnl: +Number(tr.pnl_pct).toFixed(2) })
  }
  return points
}

// ── Outcome breakdown + structural diagnosis ─────────────────
function outcomeBreakdown(trades) {
  const closed = realClosed(trades)
  const counts = { tp1_hit: 0, stopped: 0, expired: 0 }
  for (const t of closed) {
    if (counts[t.status] !== undefined) counts[t.status]++
  }
  const n = closed.length
  const barrierResolved = counts.tp1_hit + counts.stopped
  const barrierPct = n ? +(barrierResolved / n * 100).toFixed(1) : 0
  const diagnosis = n === 0 ? null
    : barrierPct < 20
      ? `Only ${barrierPct}% of trades reached stop or target — barriers are set too wide for 24h crypto moves. You are effectively testing "hold 24h", not the designed strategy.`
      : `${barrierPct}% of trades resolved at a barrier — the stop/target geometry is participating in outcomes.`
  return { ...counts, n, barrierPct, diagnosis }
}

// ── Concentration: how much one trade carries the result ─────
function concentration(trades) {
  const closed = realClosed(trades)
  if (!closed.length) return { topTradePct: null, byCoin: [], warning: null }

  const pnls = closed.map(t => ({ symbol: t.symbol, pnl: Number(t.pnl_pct) }))
  const totalPositive = pnls.filter(p => p.pnl > 0).reduce((s, p) => s + p.pnl, 0)
  const best = pnls.reduce((m, p) => p.pnl > m.pnl ? p : m, { pnl: -Infinity })
  const topTradePct = totalPositive > 0 ? +((best.pnl / totalPositive) * 100).toFixed(1) : null

  const coinMap = {}
  for (const p of pnls) {
    coinMap[p.symbol] = coinMap[p.symbol] || { symbol: p.symbol, trades: 0, totalPnl: 0 }
    coinMap[p.symbol].trades++
    coinMap[p.symbol].totalPnl += p.pnl
  }
  const byCoin = Object.values(coinMap)
    .map(c => ({ ...c, totalPnl: +c.totalPnl.toFixed(2) }))
    .sort((a, b) => b.totalPnl - a.totalPnl)

  const warning = topTradePct !== null && topTradePct > 40
    ? `${best.symbol} (+${best.pnl.toFixed(2)}%) is ${topTradePct}% of all gains — the result is one outlier, not a distributed edge.`
    : null

  return { topTradePct, bestTrade: { symbol: best.symbol, pnl: +best.pnl.toFixed(2) }, byCoin, warning }
}

// ── Shadow barrier simulation from logged MFE/MAE ─────────────
// For each (tp, stop) combo, replay every closed trade:
//   MFE reached tp, MAE never reached stop  → win at tp
//   MAE reached stop, MFE never reached tp  → loss at stop
//   BOTH reached → ordering unknown from MFE/MAE alone:
//       conservative = assume stop first; optimistic = assume tp first
//   NEITHER → trade exits at its actual recorded pnl (same 24h expiry path)
// Trades without MFE/MAE data are excluded (counted).
function shadowBarrierSim(trades, tpGrid = [2, 3, 4, 5, 9], stopGrid = [-2, -3, -4, -6]) {
  const usable = realClosed(trades).filter(t =>
    t.mfe_pct !== null && t.mfe_pct !== undefined &&
    t.mae_pct !== null && t.mae_pct !== undefined)
  const skipped = realClosed(trades).length - usable.length

  const combos = []
  for (const tp of tpGrid) {
    for (const stop of stopGrid) {
      let consSum = 0, optSum = 0, wins = 0, ambiguous = 0
      for (const t of usable) {
        const mfe = Number(t.mfe_pct), mae = Number(t.mae_pct), actual = Number(t.pnl_pct)
        const hitTP = mfe >= tp
        const hitStop = mae <= stop
        let cons, opt
        if (hitTP && hitStop) { cons = stop; opt = tp; ambiguous++ }
        else if (hitTP)       { cons = tp;   opt = tp }
        else if (hitStop)     { cons = stop; opt = stop }
        else                  { cons = actual; opt = actual }
        consSum += cons; optSum += opt
        if (opt > 0) wins++
      }
      const n = usable.length
      combos.push({
        tp, stop,
        n,
        ambiguous,
        expectancyConservative: n ? +(consSum / n).toFixed(3) : null,
        expectancyOptimistic:   n ? +(optSum  / n).toFixed(3) : null,
        winRateOptimistic:      n ? +(wins / n * 100).toFixed(1) : null
      })
    }
  }
  combos.sort((a, b) => (b.expectancyConservative ?? -Infinity) - (a.expectancyConservative ?? -Infinity))
  return { combos, usableTrades: usable.length, skipped,
    caveat: 'Simulated from MFE/MAE extremes; when both barriers were touched, true ordering is unknown — conservative assumes the stop hit first.' }
}

// ── Score vs outcome ──────────────────────────────────────────
function scoreVsOutcome(tradesWithScores) {
  const rows = (tradesWithScores || []).filter(t =>
    !isArtifact(t) && t.status !== 'open' &&
    t.pnl_pct !== null && t.deterministic_score !== null && t.deterministic_score !== undefined)
  const n = rows.length
  if (n < 4) return { n, correlation: null, buckets: [], note: 'Too few score-linked trades to analyse.' }

  const xs = rows.map(r => Number(r.deterministic_score))
  const ys = rows.map(r => Number(r.pnl_pct))
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0, dx = 0, dy = 0
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my)
    dx += (xs[i] - mx) ** 2
    dy += (ys[i] - my) ** 2
  }
  const correlation = (dx > 0 && dy > 0) ? +(num / Math.sqrt(dx * dy)).toFixed(3) : null

  const lo = rows.filter(r => Number(r.deterministic_score) <= 4)
  const hi = rows.filter(r => Number(r.deterministic_score) >= 5)
  const avg = arr => arr.length ? +(arr.reduce((s, r) => s + Number(r.pnl_pct), 0) / arr.length).toFixed(3) : null
  const buckets = [
    { label: 'Score ≤ 4', n: lo.length, avgPnl: avg(lo) },
    { label: 'Score ≥ 5', n: hi.length, avgPnl: avg(hi) },
  ]
  const note = correlation === null ? null
    : Math.abs(correlation) < 0.15
      ? `Correlation ${correlation}: the deterministic score is NOT predicting outcomes — the weights need re-deriving from data.`
      : `Correlation ${correlation}: score carries ${correlation > 0 ? 'positive' : 'NEGATIVE'} information about outcomes.`
  return { n, correlation, buckets, note }
}

// ── Regime split: BTC direction at trade entry ────────────────
function regimeSplit(tradesWithBtc) {
  const rows = (tradesWithBtc || []).filter(t =>
    !isArtifact(t) && t.status !== 'open' &&
    t.pnl_pct !== null && t.btc_return_24h !== null && t.btc_return_24h !== undefined)
  const green = rows.filter(r => Number(r.btc_return_24h) >= 0)
  const red   = rows.filter(r => Number(r.btc_return_24h) < 0)
  const avg = arr => arr.length ? +(arr.reduce((s, r) => s + Number(r.pnl_pct), 0) / arr.length).toFixed(3) : null
  return {
    n: rows.length,
    btcGreen: { n: green.length, avgPnl: avg(green) },
    btcRed:   { n: red.length,   avgPnl: avg(red) },
  }
}

// ── Benchmark: portfolio vs BTC buy-and-hold ──────────────────
function benchmark(portfolioReturnPct, btcFirstPrice, btcLastPrice) {
  if (!btcFirstPrice || !btcLastPrice) return { btcReturnPct: null, alpha: null, beatsBtc: null }
  const btcReturnPct = +(((btcLastPrice - btcFirstPrice) / btcFirstPrice) * 100).toFixed(2)
  const alpha = portfolioReturnPct !== null ? +(portfolioReturnPct - btcReturnPct).toFixed(2) : null
  return { btcReturnPct, alpha, beatsBtc: alpha !== null ? alpha > 0 : null }
}

// ── Readiness gates for real-money decision ───────────────────
function readinessGates({ stats, bench, conc, outcomes }) {
  const gates = [
    {
      id: 'sample',
      label: 'Sample size ≥ 30 closed trades',
      pass: stats.n >= 30,
      detail: `${stats.n}/30 closed trades`
    },
    {
      id: 'significance',
      label: 'Positive edge with t-stat ≥ 2.0',
      pass: stats.tStat !== null && stats.tStat >= 2.0 && stats.mean > 0,
      detail: stats.tStat !== null ? `t = ${stats.tStat}, expectancy ${stats.mean}%/trade` : 'insufficient data'
    },
    {
      id: 'benchmark',
      label: 'Beats BTC buy-and-hold over same period',
      pass: bench.beatsBtc === true,
      detail: bench.alpha !== null ? `alpha vs BTC: ${bench.alpha > 0 ? '+' : ''}${bench.alpha}%` : 'no benchmark data'
    },
    {
      id: 'concentration',
      label: 'No single trade > 40% of total gains',
      pass: conc.topTradePct !== null ? conc.topTradePct <= 40 : false,
      detail: conc.topTradePct !== null ? `top trade = ${conc.topTradePct}% of gains` : 'no gains yet'
    },
    {
      id: 'structure',
      label: 'Barriers participate (≥20% trades hit stop or TP)',
      pass: outcomes.barrierPct >= 20,
      detail: `${outcomes.barrierPct}% barrier-resolved`
    },
  ]
  const passed = gates.filter(g => g.pass).length
  return {
    gates,
    passed,
    total: gates.length,
    ready: passed === gates.length,
    summary: passed === gates.length
      ? 'All gates passed. The statistical minimum for considering real capital is met.'
      : `${passed}/${gates.length} gates passed. Real-money trading is NOT yet statistically justified.`
  }
}

module.exports = {
  honestStats, equityCurve, outcomeBreakdown, concentration,
  shadowBarrierSim, scoreVsOutcome, regimeSplit, benchmark,
  readinessGates, isArtifact, NOTIONAL, STARTING_CAPITAL
}
