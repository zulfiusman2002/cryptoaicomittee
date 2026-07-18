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
function readinessGates({ stats, bench, conc, outcomes, matched, baseRate }) {
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
      label: 'Beats BTC at matched exposure',
      pass: matched?.beatsMatched === true,
      detail: matched?.matchedAlpha !== null && matched?.matchedAlpha !== undefined
        ? `matched alpha: ${matched.matchedAlpha > 0 ? '+' : ''}${matched.matchedAlpha}% (${matched.deploymentPct}% deployed)`
        : (bench.alpha !== null ? `raw alpha vs 100% BTC: ${bench.alpha}%` : 'no benchmark data')
    },
    {
      id: 'baserate',
      label: 'Selection beats the base rate (alpha, not beta)',
      pass: baseRate?.tStat !== null && baseRate?.tStat !== undefined
        && baseRate.tStat >= 1.5 && baseRate.edge > 0,
      detail: baseRate?.edge !== null && baseRate?.edge !== undefined
        ? `edge vs all-coin base rate: ${baseRate.edge > 0 ? '+' : ''}${baseRate.edge}% (t=${baseRate.tStat ?? 'n/a'})`
        : 'insufficient forward-return data'
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

// ═══════════════════════════════════════════════════════════════
// v2 ANALYTICS — added to answer: is +0.55% alpha, or altcoin beta?
// All computed from data already logged in Turso. Read-only.
// ═══════════════════════════════════════════════════════════════

// ── Forward-return reconstruction ─────────────────────────────
// Every scan logs all 20 coins' prices. So for any coin at time T we can find
// its price ~24h later from a subsequent scan and compute the realised forward
// return — for EVERY coin, not just the ones we traded. This is the dataset the
// base-rate test needs, and it already exists.
function buildForwardReturns(coinMetricRows, horizonHours = 24, toleranceHours = 2.5) {
  const bySymbol = {}
  for (const r of coinMetricRows || []) {
    if (!r.symbol || r.price === null || r.price === undefined || !r.created_at) continue
    ;(bySymbol[r.symbol] = bySymbol[r.symbol] || []).push({
      t: new Date(r.created_at).getTime(),
      price: Number(r.price),
      return_1h:  r.return_1h  !== null ? Number(r.return_1h)  : null,
      return_24h: r.return_24h !== null ? Number(r.return_24h) : null,
      volume_shock: r.volume_shock !== null ? Number(r.volume_shock) : null,
      rs_btc: r.relative_strength_btc !== null ? Number(r.relative_strength_btc) : null,
      symbol: r.symbol
    })
  }

  const horizonMs = horizonHours * 3600 * 1000
  const tolMs = toleranceHours * 3600 * 1000
  const out = []

  for (const sym of Object.keys(bySymbol)) {
    const pts = bySymbol[sym].sort((a, b) => a.t - b.t)
    for (let i = 0; i < pts.length; i++) {
      const target = pts[i].t + horizonMs
      // nearest later point within tolerance
      let best = null, bestDiff = Infinity
      for (let j = i + 1; j < pts.length; j++) {
        const diff = Math.abs(pts[j].t - target)
        if (pts[j].t > target + tolMs) break
        if (diff < bestDiff) { bestDiff = diff; best = pts[j] }
      }
      if (!best || bestDiff > tolMs || !pts[i].price) continue
      out.push({
        ...pts[i],
        fwdReturn: +(((best.price - pts[i].price) / pts[i].price) * 100).toFixed(4)
      })
    }
  }
  return out
}

// Welch's t-test between two independent samples
function welchT(a, b) {
  if (a.length < 2 || b.length < 2) return null
  const mean = x => x.reduce((s, v) => s + v, 0) / x.length
  const varc = (x, m) => x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1)
  const ma = mean(a), mb = mean(b)
  const va = varc(a, ma), vb = varc(b, mb)
  const se = Math.sqrt(va / a.length + vb / b.length)
  if (!se) return null
  return +((ma - mb) / se).toFixed(2)
}

// ── THE BASE-RATE TEST ────────────────────────────────────────
// Does picking coins beat picking nothing? Compares the forward return of
// coins the engine SELECTED against the forward return of ALL coins over the
// same windows. If they match, the selection adds no information — the return
// is altcoin beta, not signal alpha.
function baseRateTest(forwardReturns, selectedKeys) {
  const all = (forwardReturns || []).filter(r => r.fwdReturn !== null)
  if (all.length < 10) return { n: 0, note: 'Not enough forward-return data yet.' }

  const selSet = new Set(selectedKeys || [])
  const selected = all.filter(r => selSet.has(`${r.symbol}|${r.t}`))
  const universe = all

  const mean = x => x.length ? x.reduce((s, v) => s + v, 0) / x.length : null
  const selRets = selected.map(r => r.fwdReturn)
  const uniRets = universe.map(r => r.fwdReturn)

  const selMean = mean(selRets)
  const uniMean = mean(uniRets)
  const edge = (selMean !== null && uniMean !== null) ? +(selMean - uniMean).toFixed(3) : null
  const t = selRets.length >= 2 ? welchT(selRets, uniRets) : null

  let verdict
  if (selected.length < 10) verdict = `Only ${selected.length} selections matched to forward data — too few to judge.`
  else if (edge === null) verdict = 'Insufficient data.'
  else if (t !== null && Math.abs(t) < 1.5)
    verdict = `Selected coins returned ${selMean.toFixed(2)}% vs ${uniMean.toFixed(2)}% for the whole universe (edge ${edge > 0 ? '+' : ''}${edge}%, t=${t}). The selection is NOT distinguishable from picking any coin — this looks like altcoin beta, not signal alpha.`
  else if (edge > 0)
    verdict = `Selected coins returned ${selMean.toFixed(2)}% vs ${uniMean.toFixed(2)}% for the universe (edge +${edge}%, t=${t}). The selection appears to add genuine information.`
  else
    verdict = `Selected coins returned ${selMean.toFixed(2)}% vs ${uniMean.toFixed(2)}% for the universe (edge ${edge}%, t=${t}). The selection is actively WORSE than random.`

  return {
    n: all.length,
    selectedN: selected.length,
    selectedMean: selMean !== null ? +selMean.toFixed(3) : null,
    universeMean: uniMean !== null ? +uniMean.toFixed(3) : null,
    edge, tStat: t, verdict
  }
}

// ── Shadow strategy comparison ────────────────────────────────
// Replays alternative SELECTION rules over the same logged snapshots.
// Includes the pullback logic (buy the dip inside an uptrend) — the core
// insight from the reviewed strategy, testable here at zero cost.
const SELECTION_RULES = {
  'Base rate (all coins)':        () => true,
  'Momentum (current engine)':    m => m.return_24h > 3 && m.rs_btc > 1,
  'Pullback (uptrend + dip)':     m => m.return_24h > 3 && m.return_1h < 0,
  'Pullback + RS confirmation':   m => m.return_24h > 3 && m.return_1h < 0 && m.rs_btc > 1,
  'Pullback + volume':            m => m.return_24h > 3 && m.return_1h < 0 && m.volume_shock > 2,
  'Strong momentum only':         m => m.return_24h > 8 && m.rs_btc > 3,
}

function shadowStrategies(forwardReturns) {
  const all = (forwardReturns || []).filter(r =>
    r.fwdReturn !== null && r.return_24h !== null && r.return_1h !== null && r.rs_btc !== null)
  if (all.length < 10) return { rows: [], n: 0, note: 'Not enough forward-return data yet.' }

  const baseRets = all.map(r => r.fwdReturn)
  const rows = []
  for (const [label, rule] of Object.entries(SELECTION_RULES)) {
    const picked = all.filter(rule)
    const rets = picked.map(r => r.fwdReturn)
    const n = rets.length
    const mean = n ? rets.reduce((s, v) => s + v, 0) / n : null
    const sd = n > 1
      ? Math.sqrt(rets.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : null
    const se = (sd && n) ? sd / Math.sqrt(n) : null
    const tVsZero = (mean !== null && se) ? +(mean / se).toFixed(2) : null
    const tVsBase = label.startsWith('Base rate') ? null : (n >= 2 ? welchT(rets, baseRets) : null)
    rows.push({
      label, n,
      meanFwd: mean !== null ? +mean.toFixed(3) : null,
      sd: sd !== null ? +sd.toFixed(3) : null,
      tVsZero, tVsBase,
      hitRate: n ? +(rets.filter(v => v > 0).length / n * 100).toFixed(1) : null
    })
  }
  rows.sort((a, b) => (b.meanFwd ?? -Infinity) - (a.meanFwd ?? -Infinity))
  return {
    rows, n: all.length,
    caveat: 'Selection rules replayed over logged scan snapshots against realised 24h forward returns. Same data, different picking rule. t vs base = is this rule better than picking any coin at random?'
  }
}

// ── Risk metrics (Sharpe, max DD, profit factor, streaks) ─────
// Daily-return Sharpe from the equity curve — more defensible than per-trade.
function riskMetrics(trades, curvePoints) {
  const closed = realClosed(trades)
  const n = closed.length
  if (!n) return { n: 0, note: 'No closed trades yet.' }

  const pnls = closed.map(t => Number(t.pnl_pct))
  const grossWin  = pnls.filter(p => p > 0).reduce((s, p) => s + p, 0)
  const grossLoss = Math.abs(pnls.filter(p => p < 0).reduce((s, p) => s + p, 0))
  const profitFactor = grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : null

  // Longest losing / winning streak (chronological)
  const chrono = closed.filter(t => t.closed_at)
    .sort((a, b) => new Date(a.closed_at) - new Date(b.closed_at))
  let maxLose = 0, maxWin = 0, curLose = 0, curWin = 0
  for (const t of chrono) {
    if (Number(t.pnl_pct) > 0) { curWin++; curLose = 0 } else { curLose++; curWin = 0 }
    if (curLose > maxLose) maxLose = curLose
    if (curWin > maxWin) maxWin = curWin
  }

  // Max drawdown from the equity curve
  let peak = -Infinity, maxDD = 0, peakEq = null, troughEq = null
  for (const p of curvePoints || []) {
    if (p.equity > peak) peak = p.equity
    const dd = peak > 0 ? (peak - p.equity) / peak * 100 : 0
    if (dd > maxDD) { maxDD = dd; peakEq = peak; troughEq = p.equity }
  }

  // Daily returns from the curve → annualised Sharpe
  const byDay = {}
  for (const p of curvePoints || []) {
    const day = new Date(p.t).toISOString().slice(0, 10)
    byDay[day] = p.equity   // last equity of each day
  }
  const days = Object.keys(byDay).sort()
  const dailyRets = []
  for (let i = 1; i < days.length; i++) {
    const prev = byDay[days[i - 1]], cur = byDay[days[i]]
    if (prev > 0) dailyRets.push((cur - prev) / prev)
  }
  let sharpe = null, dailySD = null
  if (dailyRets.length >= 3) {
    const m = dailyRets.reduce((s, v) => s + v, 0) / dailyRets.length
    const sd = Math.sqrt(dailyRets.reduce((s, v) => s + (v - m) ** 2, 0) / (dailyRets.length - 1))
    dailySD = +(sd * 100).toFixed(3)
    sharpe = sd > 0 ? +((m / sd) * Math.sqrt(365)).toFixed(2) : null
  }

  const returnPct = curvePoints?.length
    ? ((curvePoints[curvePoints.length - 1].equity - STARTING_CAPITAL) / STARTING_CAPITAL) * 100
    : null
  const returnOverMaxDD = (returnPct !== null && maxDD > 0) ? +(returnPct / maxDD).toFixed(2) : null

  return {
    n,
    profitFactor,
    maxDrawdownPct: +maxDD.toFixed(2),
    drawdownPeak: peakEq !== null ? +peakEq.toFixed(2) : null,
    drawdownTrough: troughEq !== null ? +troughEq.toFixed(2) : null,
    returnOverMaxDD,
    sharpeAnnualised: sharpe,
    dailySDPct: dailySD,
    daysObserved: dailyRets.length,
    longestLosingStreak: maxLose,
    longestWinningStreak: maxWin,
    note: dailyRets.length < 20
      ? `Sharpe computed from only ${dailyRets.length} daily observations — treat as indicative, not reliable.`
      : null
  }
}

// ── Deployment-matched benchmark ──────────────────────────────
// The naive gate compared a ~26%-deployed strategy to 100% BTC — apples to
// oranges. This computes average capital actually at risk and compares like
// for like.
function deploymentMatchedBenchmark(trades, btcReturnPct, portfolioReturnPct, periodDays) {
  const rows = (trades || []).filter(t => !isArtifact(t) && t.opened_at)
  if (!rows.length || btcReturnPct === null || btcReturnPct === undefined) {
    return { deploymentPct: null, matchedBtcReturn: null, matchedAlpha: null, beatsMatched: null }
  }
  const now = Date.now()
  let tradeHours = 0
  for (const t of rows) {
    const start = new Date(t.opened_at).getTime()
    const end = t.closed_at ? new Date(t.closed_at).getTime() : now
    if (end > start) tradeHours += (end - start) / 3600000
  }
  const periodHours = (periodDays || 1) * 24
  const avgConcurrent = periodHours > 0 ? tradeHours / periodHours : 0
  const deploymentPct = +((avgConcurrent * NOTIONAL / STARTING_CAPITAL) * 100).toFixed(1)
  const matchedBtcReturn = +((deploymentPct / 100) * btcReturnPct).toFixed(2)
  const matchedAlpha = portfolioReturnPct !== null ? +(portfolioReturnPct - matchedBtcReturn).toFixed(2) : null
  return {
    avgConcurrentPositions: +avgConcurrent.toFixed(2),
    deploymentPct,
    matchedBtcReturn,
    matchedAlpha,
    beatsMatched: matchedAlpha !== null ? matchedAlpha > 0 : null,
    note: `Strategy held ~${avgConcurrent.toFixed(1)} positions on average = ~${deploymentPct}% of capital deployed. Comparing to 100% BTC exposure is not like-for-like; this line matches the exposure.`
  }
}

module.exports.buildForwardReturns = buildForwardReturns
module.exports.baseRateTest = baseRateTest
module.exports.shadowStrategies = shadowStrategies
module.exports.riskMetrics = riskMetrics
module.exports.deploymentMatchedBenchmark = deploymentMatchedBenchmark
