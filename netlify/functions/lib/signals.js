// netlify/functions/lib/signals.js
// Deterministic rule-based signal engine.
// AI layers INTERPRET these results. They cannot override hard limits.

const VERDICT = {
  BUY_WATCH:      'BUY WATCH',
  BUY_BREAKOUT:   'BUY ON BREAKOUT',
  BUY_PULLBACK:   'BUY ON PULLBACK',
  WAIT:           'WAIT',
  AVOID:          'AVOID',
  SELL_WARNING:   'SELL/EXIT WARNING',
}

function classifyFunding(category) {
  if (category === 'overheated')                return { score: -2, label: 'Overheated' }
  if (category === 'positive_acceptable')       return { score:  0, label: 'Positive' }
  if (category === 'neutral')                   return { score:  1, label: 'Neutral' }
  if (category === 'negative_squeeze_potential') return { score:  1, label: 'Squeeze Potential' }
  return { score: 0, label: 'Unknown' }
}

// ── Entry / SL / TP calculation ───────────────────────────────
function calcLevels(price, verdict, volCompression) {
  if (!price || verdict === VERDICT.WAIT || verdict === VERDICT.AVOID) {
    return { entryLow: null, entryHigh: null, stopLoss: null, tp1: null, tp2: null, invalidation: null }
  }

  // Volatility-adjusted stop: use vol compression as a proxy for tightness
  // Compressed vol → tighter stop; expanding → wider
  const volFactor = (volCompression && volCompression < 0.5) ? 0.04 : 0.06

  let entryLow, entryHigh, stopLoss

  if (verdict === VERDICT.BUY_PULLBACK) {
    entryLow  = +(price * 0.98).toFixed(8)
    entryHigh = +(price * 0.99).toFixed(8)
    stopLoss  = +(price * (1 - volFactor - 0.01)).toFixed(8)
  } else if (verdict === VERDICT.BUY_BREAKOUT) {
    entryLow  = +(price * 1.001).toFixed(8)
    entryHigh = +(price * 1.005).toFixed(8)
    stopLoss  = +(price * (1 - volFactor)).toFixed(8)
  } else if (verdict === VERDICT.BUY_WATCH) {
    entryLow  = +(price * 0.99).toFixed(8)
    entryHigh = +(price * 1.01).toFixed(8)
    stopLoss  = +(price * (1 - volFactor)).toFixed(8)
  } else if (verdict === VERDICT.SELL_WARNING) {
    return { entryLow: null, entryHigh: null, stopLoss: null, tp1: null, tp2: null,
             invalidation: 'Exit if price fails to hold current support.' }
  }

  const entryMid = (entryLow + entryHigh) / 2
  const R = entryMid - stopLoss
  const tp1 = +(entryMid + 1.5 * R).toFixed(8)
  const tp2 = +(entryMid + 2.5 * R).toFixed(8)

  const invalidation = `Invalidated if price closes below ${stopLoss.toFixed(4)} on the hourly chart.`

  return { entryLow, entryHigh, stopLoss, tp1, tp2, invalidation }
}

// ── Main signal function ──────────────────────────────────────
function computeSignal(m) {
  if (m.unavailable || m.dataQuality === 0) {
    return { symbol: m.symbol, verdict: VERDICT.WAIT, score: 0,
             reason: 'No data available', risk: 'Unknown', levels: {} }
  }

  const funding  = classifyFunding(m.fundingCategory)
  const reasons  = []
  let score      = 0

  // ── Hard overrides (cannot be changed by AI) ──────────────
  // Extended price + overheated funding = AVOID regardless
  if (m.return24h > 40 && m.fundingCategory === 'overheated') {
    return buildResult(m, VERDICT.AVOID, -5, 'Extreme extension + overheated funding', 'Extreme', {})
  }

  // Strong exit signal: OI falling + price up + funding overheated
  if (m.oiChange4h < -8 && m.return4h > 0 && m.fundingCategory === 'overheated') {
    return buildResult(m, VERDICT.SELL_WARNING, -4, 'OI diverging from price rise + overheated funding', 'High',
      calcLevels(m.price, VERDICT.SELL_WARNING, m.volCompression))
  }

  // ── Scoring ────────────────────────────────────────────────

  // Momentum
  if (m.return24h > 3 && m.return24h < 25)   { score += 2; reasons.push('healthy 24h momentum') }
  else if (m.return24h >= 25 && m.return24h <= 40) { score += 1; reasons.push('strong but extended 24h move') }
  else if (m.return24h < 0)                   { score -= 1; reasons.push('negative 24h return') }
  if (m.return4h > 1)                         { score += 1; reasons.push('positive 4h trend') }
  if (m.return1h > 0.5)                       { score += 1; reasons.push('positive 1h momentum') }

  // Volume
  if (m.volumeShock > 2)                      { score += 2; reasons.push(`volume shock ${m.volumeShock}x`) }
  else if (m.volumeShock > 1.5)               { score += 1; reasons.push('elevated volume') }
  else if (m.volumeShock < 0.7)               { score -= 1; reasons.push('fading volume') }

  // Relative strength vs BTC
  if (m.relStrengthBtc > 3)                   { score += 2; reasons.push('strong outperformance vs BTC') }
  else if (m.relStrengthBtc > 1)              { score += 1; reasons.push('outperforming BTC') }
  else if (m.relStrengthBtc < -2)             { score -= 1; reasons.push('underperforming BTC') }

  // OI
  if (m.oiChange24h > 5)                      { score += 1; reasons.push('rising OI 24h') }
  if (m.oiAcceleration > 2)                   { score += 1; reasons.push('OI acceleration') }
  if (m.oiChange4h < -5)                      { score -= 1; reasons.push('OI declining 4h') }

  // Funding
  score += funding.score
  if (funding.score < 0)   reasons.push('overheated funding')
  if (funding.label === 'Neutral' || funding.label === 'Squeeze Potential')
                            reasons.push(`funding ${funding.label.toLowerCase()}`)

  // Taker
  if (m.takerBuyRatio > 0.6)                  { score += 1; reasons.push('aggressive buy-side taker flow') }
  if (m.takerBuyRatio < 0.4)                  { score -= 1; reasons.push('sell-side taker dominance') }

  // Volatility compression (setup)
  if (m.volCompression < 0.5)                 { score += 1; reasons.push('volatility compression — possible breakout setup') }

  // Higher highs
  if (m.higherHigh)                           { score += 1; reasons.push('higher highs forming') }

  // Unlock overhang (hard penalty)
  if (m.unlockOverhang && m.unlockOverhang.hasOverhang) {
    score -= 2
    reasons.push(`token unlock within ${m.unlockOverhang.daysToUnlock} days`)
  }

  // Data quality penalty
  if (m.dataQuality === 1) { score -= 1; reasons.push('low data quality — single venue') }

  // ── Verdict mapping ────────────────────────────────────────
  let verdict
  const isShortSqueeze = m.return1h > 1 && m.return4h > 2 &&
    (m.fundingCategory === 'negative_squeeze_potential' || m.fundingCategory === 'neutral') &&
    m.oiChange4h > 3

  const isBreakout = m.return4h > 0 && m.return24h > 0 && (m.volumeShock || 0) > 2 &&
    m.higherHigh && (m.oiChange4h || 0) > 2

  if (score <= -3)        verdict = VERDICT.AVOID
  else if (score === -2)  verdict = VERDICT.WAIT
  else if (score === -1)  verdict = VERDICT.WAIT
  else if (score === 0)   verdict = VERDICT.WAIT
  else if (isShortSqueeze) verdict = VERDICT.BUY_WATCH
  else if (isBreakout)     verdict = VERDICT.BUY_BREAKOUT
  else if (score >= 5 && m.return4h > 0 && m.return24h > 3)
    verdict = VERDICT.BUY_WATCH
  else if (score >= 4 && m.return4h < 0 && m.return24h > 3)
    verdict = VERDICT.BUY_PULLBACK
  else if (score >= 3)    verdict = VERDICT.BUY_WATCH
  else                    verdict = VERDICT.WAIT

  // Risk label
  const risk = score >= 5 && m.fundingCategory !== 'overheated' ? 'Low'
    : score >= 3 ? 'Medium'
    : score >= 1 ? 'High'
    : 'Extreme'

  const levels = calcLevels(m.price, verdict, m.volCompression)

  return buildResult(m, verdict, score, reasons.join(' | '), risk, levels)
}

function buildResult(m, verdict, score, reason, risk, levels) {
  return {
    symbol: m.symbol,
    verdict,
    score,
    reason,
    risk,
    levels,
    fundingCategory: m.fundingCategory,
    risks: m.risks || []
  }
}

// ── Score all coins and select top candidates ─────────────────
function scoreAndRank(allMetrics) {
  const scored = allMetrics
    .filter(m => !m.unavailable)
    .map(m => ({ ...m, signal: computeSignal(m) }))
    .sort((a, b) => b.signal.score - a.signal.score)

  const top5 = scored
    .filter(m => ['BUY WATCH','BUY ON BREAKOUT','BUY ON PULLBACK'].includes(m.signal.verdict))
    .slice(0, 5)

  return { allScored: scored, top5 }
}

module.exports = { computeSignal, scoreAndRank, VERDICT }
