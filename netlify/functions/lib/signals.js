// netlify/functions/lib/signals.js
// Deterministic rule-based signal engine.
//
// SAFETY RULES (v3):
// 1. No derivatives → verdicts allowed BUT capped at lower tier + penalty applied to score
//    (BUY ON BREAKOUT max becomes BUY WATCH; confidence reduced; data completeness shows warning)
// 2. Volume shock without RS/BTC confirmation → only +1 not +2
// 3. Overheated + extended → hard AVOID
// 4. dataCompleteness label on every result
// 5. Levels always labelled mechanical

const VERDICT = {
  BUY_WATCH:    'BUY WATCH',
  BUY_BREAKOUT: 'BUY ON BREAKOUT',
  BUY_PULLBACK: 'BUY ON PULLBACK',
  WAIT:         'WAIT',
  AVOID:        'AVOID',
  SELL_WARNING: 'SELL/EXIT WARNING',
}

function classifyDataCompleteness(m) {
  const hasOI      = m.oiChange24h !== null && m.oiChange24h !== undefined
  const hasFunding = m.fundingCategory && m.fundingCategory !== 'unavailable'
  const hasPrice   = m.return24h !== null && m.return1h !== null
  const hasRS      = m.relStrengthBtc !== null

  if (hasOI && hasFunding && hasPrice)                return 'Full Confirmation'
  if (hasFunding && hasPrice && hasRS)                return 'Partial Confirmation'
  if (hasPrice && hasRS)                              return 'Momentum Only'
  return 'Insufficient Data'
}

function classifyFunding(category) {
  if (category === 'overheated')                 return { score: -2, label: 'Overheated' }
  if (category === 'positive_acceptable')        return { score:  0, label: 'Positive' }
  if (category === 'neutral')                    return { score:  1, label: 'Neutral' }
  if (category === 'negative_squeeze_potential') return { score:  1, label: 'Squeeze Potential' }
  return { score: 0, label: 'Unknown' }
}

function calcLevels(price, verdict, volCompression) {
  if (!price || verdict === VERDICT.WAIT || verdict === VERDICT.AVOID) {
    return { entryLow: null, entryHigh: null, stopLoss: null, tp1: null, tp2: null,
             invalidation: null, levelsLabel: null }
  }
  if (verdict === VERDICT.SELL_WARNING) {
    return { entryLow: null, entryHigh: null, stopLoss: null, tp1: null, tp2: null,
             invalidation: 'Exit if price fails to hold current support.', levelsLabel: null }
  }

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
  } else {
    entryLow  = +(price * 0.99).toFixed(8)
    entryHigh = +(price * 1.01).toFixed(8)
    stopLoss  = +(price * (1 - volFactor)).toFixed(8)
  }

  const entryMid = (entryLow + entryHigh) / 2
  const R   = entryMid - stopLoss
  const tp1 = +(entryMid + 1.5 * R).toFixed(8)
  const tp2 = +(entryMid + 2.5 * R).toFixed(8)
  const levelsLabel = 'Mechanical levels — not confirmed by S/R or volume profile'
  const invalidation = `Invalidated if price closes below ${stopLoss.toFixed(4)} on the hourly chart.`

  return { entryLow, entryHigh, stopLoss, tp1, tp2, invalidation, levelsLabel }
}

function computeSignal(m) {
  if (m.unavailable || m.dataQuality === 0) {
    return { symbol: m.symbol, verdict: VERDICT.WAIT, score: 0,
             reason: 'No data available', risk: 'Unknown', levels: {},
             dataCompleteness: 'Insufficient Data' }
  }

  const dataCompleteness = classifyDataCompleteness(m)
  const hasOI      = m.oiChange24h !== null && m.oiChange24h !== undefined
  const hasFunding = m.fundingCategory && m.fundingCategory !== 'unavailable'
  const hasDerivatives = hasOI || hasFunding

  const funding = classifyFunding(m.fundingCategory)
  const reasons = []
  let score = 0

  // ── Hard overrides ─────────────────────────────────────────
  if (m.return24h > 40 && m.fundingCategory === 'overheated') {
    return buildResult(m, VERDICT.AVOID, -5,
      'Extreme extension + overheated funding', 'Extreme', {}, dataCompleteness)
  }
  if (m.oiChange4h < -8 && m.return4h > 0 && m.fundingCategory === 'overheated') {
    return buildResult(m, VERDICT.SELL_WARNING, -4,
      'OI diverging from price rise + overheated funding', 'High',
      calcLevels(m.price, VERDICT.SELL_WARNING, m.volCompression), dataCompleteness)
  }

  // ── Scoring ────────────────────────────────────────────────

  // Momentum (24h reliable from CoinGecko)
  if (m.return24h > 3 && m.return24h < 25)        { score += 2; reasons.push('healthy 24h momentum') }
  else if (m.return24h >= 25 && m.return24h <= 40) { score += 1; reasons.push('strong but extended 24h move') }
  else if (m.return24h < 0)                        { score -= 1; reasons.push('negative 24h return') }

  // 1h (null-safe)
  if (m.return1h !== null && m.return1h > 0.5) { score += 1; reasons.push('positive 1h momentum') }

  // Volume — requires RS confirmation to score +2
  const hasRSConfirmation = m.relStrengthBtc !== null && m.relStrengthBtc > 1
  if (m.volumeShock > 2 && hasRSConfirmation)      { score += 2; reasons.push(`volume shock ${m.volumeShock}x + RS confirmed`) }
  else if (m.volumeShock > 2)                      { score += 1; reasons.push(`volume shock ${m.volumeShock}x (unconfirmed)`) }
  else if (m.volumeShock > 1.5)                    { score += 1; reasons.push('elevated volume') }
  else if (m.volumeShock !== null && m.volumeShock < 0.7) { score -= 1; reasons.push('fading volume') }

  // Relative strength
  if (m.relStrengthBtc > 3)       { score += 2; reasons.push('strong outperformance vs BTC') }
  else if (m.relStrengthBtc > 1)  { score += 1; reasons.push('outperforming BTC') }
  else if (m.relStrengthBtc < -2) { score -= 1; reasons.push('underperforming BTC') }

  // OI (only if available)
  if (hasOI) {
    if (m.oiChange24h > 5)    { score += 1; reasons.push('rising OI 24h') }
    if (m.oiAcceleration > 2) { score += 1; reasons.push('OI acceleration') }
    if (m.oiChange4h < -5)    { score -= 1; reasons.push('OI declining 4h') }
  }

  // Funding (only if available)
  if (hasFunding) {
    score += funding.score
    if (funding.score < 0) reasons.push('overheated funding')
    if (funding.label === 'Neutral' || funding.label === 'Squeeze Potential')
      reasons.push(`funding ${funding.label.toLowerCase()}`)
  }

  // Taker
  if (m.takerBuyRatio > 0.6) { score += 1; reasons.push('buy-side taker flow') }
  if (m.takerBuyRatio < 0.4) { score -= 1; reasons.push('sell-side taker dominance') }

  // Higher highs (only if OHLC computed it)
  if (m.higherHigh) { score += 1; reasons.push('higher highs forming') }

  // Unlock overhang
  if (m.unlockOverhang?.hasOverhang) {
    score -= 2
    reasons.push(`token unlock within ${m.unlockOverhang.daysToUnlock} days`)
  }

  // Data quality
  if (m.dataQuality === 1) { score -= 1; reasons.push('low data quality') }

  // ── SAFETY RULE: No derivatives → score penalty + cap verdict ───
  // No hard block. Instead: -1 score penalty and BUY ON BREAKOUT becomes BUY WATCH.
  // This allows signals but communicates reduced confidence honestly.
  if (!hasDerivatives) {
    score -= 1
    reasons.push('derivatives unavailable — confidence reduced')
  }

  // ── Verdict mapping ─────────────────────────────────────────
  let verdict
  if (score <= -3)     verdict = VERDICT.AVOID
  else if (score <= 0) verdict = VERDICT.WAIT
  else {
    // Without derivatives, cap at BUY WATCH (no breakout or pullback confirmation possible)
    const isShortSqueeze = m.return1h > 1 &&
      (m.fundingCategory === 'negative_squeeze_potential' || m.fundingCategory === 'neutral') &&
      hasOI && m.oiChange4h > 3

    const isBreakout = m.return24h > 0 && (m.volumeShock || 0) > 2 &&
      m.higherHigh && hasOI && (m.oiChange4h || 0) > 2

    if (isShortSqueeze)        verdict = VERDICT.BUY_WATCH
    else if (isBreakout)       verdict = VERDICT.BUY_BREAKOUT
    else if (score >= 5 && m.return24h > 3) verdict = VERDICT.BUY_WATCH
    else if (score >= 4 && m.return24h > 3 && hasFunding) verdict = VERDICT.BUY_PULLBACK
    else if (score >= 3)       verdict = VERDICT.BUY_WATCH
    else                       verdict = VERDICT.WAIT
  }

  const risk = score >= 5 && m.fundingCategory !== 'overheated' ? 'Low'
    : score >= 3 ? 'Medium'
    : score >= 1 ? 'High'
    : 'Extreme'

  return buildResult(m, verdict, score, reasons.join(' | '), risk,
    calcLevels(m.price, verdict, m.volCompression), dataCompleteness)
}

function buildResult(m, verdict, score, reason, risk, levels, dataCompleteness) {
  return { symbol: m.symbol, verdict, score, reason, risk, levels,
           dataCompleteness, fundingCategory: m.fundingCategory, risks: m.risks || [] }
}

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
