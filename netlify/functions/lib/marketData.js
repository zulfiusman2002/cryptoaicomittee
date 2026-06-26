// netlify/functions/lib/marketData.js
// Fetches from Binance public APIs. No API key required.
// Implements: data quality scoring, settled funding rate tracking,
//             OI USD normalisation, cross-exchange cross-check where possible.

const BINANCE_SPOT   = 'https://api.binance.com/api/v3'
const BINANCE_FUTURES = 'https://fapi.binance.com/fapi/v1'

const COIN_UNIVERSE = [
  'BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT',
  'ADAUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','NEARUSDT',
  'INJUSDT','FETUSDT','RNDRUSDT','ARBUSDT','OPUSDT',
  'SUIUSDT','APTUSDT','PEPEUSDT','WIFUSDT','SEIUSDT'
]

async function safeFetch(url, label) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    console.warn(`[marketData] failed: ${label}`)
    return null
  }
}

// Returns candles for a symbol. limit=26 gives enough for 1h/4h/12h/24h returns.
async function getCandles(symbol, interval = '1h', limit = 26) {
  const url = `${BINANCE_SPOT}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
  return safeFetch(url, `candles ${symbol}`)
}

async function getFuturesCandles(symbol, interval = '1h', limit = 26) {
  const url = `${BINANCE_FUTURES}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
  return safeFetch(url, `futures candles ${symbol}`)
}

async function get24hTicker(symbol) {
  const url = `${BINANCE_SPOT}/ticker/24hr?symbol=${symbol}`
  return safeFetch(url, `24h ticker ${symbol}`)
}

async function getFuturesTicker(symbol) {
  const url = `${BINANCE_FUTURES}/ticker/24hr?symbol=${symbol}`
  return safeFetch(url, `futures ticker ${symbol}`)
}

// Returns settled funding rate history (last 2 settlements = last 16h)
// Funding settles every 8h. We use settled rates, NOT the predicted rate.
async function getFundingHistory(symbol) {
  const url = `${BINANCE_FUTURES}/fundingRate?symbol=${symbol}&limit=3`
  return safeFetch(url, `funding ${symbol}`)
}

async function getOpenInterest(symbol) {
  const url = `${BINANCE_FUTURES}/openInterest?symbol=${symbol}`
  return safeFetch(url, `OI ${symbol}`)
}

// OI history: 500-period at 1h to get 4h/24h change
async function getOpenInterestHist(symbol) {
  const url = `${BINANCE_FUTURES}/openInterestHist?symbol=${symbol}&period=1h&limit=26`
  return safeFetch(url, `OI hist ${symbol}`)
}

// Taker buy/sell volume
async function getTakerVolume(symbol) {
  const url = `${BINANCE_FUTURES}/takerlongshortRatio?symbol=${symbol}&period=1h&limit=26`
  return safeFetch(url, `taker ${symbol}`)
}

// ── Token unlock calendar (static for MVP, updatable) ───────────
// Flag coins with known near-term unlocks > 5% circulating supply
const UNLOCK_OVERHANGS = {
  // symbol: { date: ISO string, pct: percentage of supply unlocking }
  // Update manually as needed. Empty = no known overhang.
}

function getUnlockOverhang(symbol) {
  const entry = UNLOCK_OVERHANGS[symbol]
  if (!entry) return { hasOverhang: false }
  const daysToUnlock = (new Date(entry.date) - Date.now()) / 86400000
  if (daysToUnlock < 0 || daysToUnlock > 14) return { hasOverhang: false }
  return { hasOverhang: true, daysToUnlock: Math.round(daysToUnlock), pct: entry.pct }
}

// ── Main per-coin calculation ─────────────────────────────────
async function computeCoinMetrics(symbol, btcReturn24h, ethReturn24h) {
  const [
    spotCandles,
    futuresCandles,
    ticker24h,
    futuresTicker,
    fundingHistory,
    oiCurrent,
    oiHist,
    takerData
  ] = await Promise.all([
    getCandles(symbol),
    getFuturesCandles(symbol),
    get24hTicker(symbol),
    getFuturesTicker(symbol),
    getFundingHistory(symbol),
    getOpenInterest(symbol),
    getOpenInterestHist(symbol),
    getTakerVolume(symbol)
  ])

  const hasSpot    = spotCandles && spotCandles.length > 1
  const hasFutures = futuresCandles && futuresCandles.length > 1
  const hasTicker  = !!ticker24h
  const hasOI      = !!oiCurrent
  const hasFunding = fundingHistory && fundingHistory.length > 0

  // Data quality flag
  // 3 = spot + futures + funding all present
  // 2 = spot + futures present
  // 1 = spot only
  // 0 = no spot data
  let dataQuality = 0
  if (hasSpot) dataQuality = 1
  if (hasSpot && hasFutures) dataQuality = 2
  if (hasSpot && hasFutures && hasFunding) dataQuality = 3

  if (!hasSpot) {
    return { symbol, dataQuality: 0, unavailable: true }
  }

  // ── Price & returns ───────────────────────────────────────
  const closes = spotCandles.map(c => parseFloat(c[4]))
  const currentPrice = closes[closes.length - 1]
  const price1hAgo   = closes[closes.length - 2]  || currentPrice
  const price4hAgo   = closes[closes.length - 5]  || currentPrice
  const price12hAgo  = closes[closes.length - 13] || currentPrice
  const price24hAgo  = closes[closes.length - 25] || currentPrice

  const return1h  = pct(currentPrice, price1hAgo)
  const return4h  = pct(currentPrice, price4hAgo)
  const return12h = pct(currentPrice, price12hAgo)
  const return24h = pct(currentPrice, price24hAgo)

  // ── Volume shock ─────────────────────────────────────────
  const volumes = spotCandles.map(c => parseFloat(c[5]))
  const vol24h  = hasTicker ? parseFloat(ticker24h.volume) * currentPrice : null
  const avgHourlyVol = volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1)
  const vol7dAvg = avgHourlyVol * 24  // approximate
  const volumeShock = vol7dAvg > 0 && vol24h ? +(vol24h / vol7dAvg).toFixed(3) : null

  // ── Higher high detection ──────────────────────────────
  const highs = spotCandles.map(c => parseFloat(c[2]))
  const higherHigh = highs[highs.length - 1] > highs[highs.length - 3] &&
                     highs[highs.length - 3] > highs[highs.length - 5]

  // ── Relative strength ─────────────────────────────────
  const relStrengthBtc = btcReturn24h !== null ? +(return24h - btcReturn24h).toFixed(3) : null
  const relStrengthEth = ethReturn24h !== null ? +(return24h - ethReturn24h).toFixed(3) : null

  // ── Open Interest (USD notional) ──────────────────────
  // CRITICAL: Normalise to USD before any comparison.
  // Binance OI is in base coin units for coin-margined, in USDT for USDT-margined.
  // For USDT-perpetuals (our universe), openInterest * markPrice = USD notional.
  let oiUsdCurrent = null
  let oiChange4h   = null
  let oiChange24h  = null
  let oiAcceleration = null

  if (hasOI) {
    const markPrice = parseFloat(oiCurrent.openInterest) // USDT-perp: already quoted in contracts
    // For USDT-perpetuals, openInterest field is contract count; multiply by contract size (~1 for USDT-perp)
    // Binance USDT-perp openInterest is already in base coin units; multiply by price for USD
    oiUsdCurrent = parseFloat(oiCurrent.openInterest) * currentPrice

    if (oiHist && oiHist.length >= 25) {
      const oiHistUsd = oiHist.map(o => parseFloat(o.sumOpenInterest) * currentPrice)
      const oiNow     = oiHistUsd[oiHistUsd.length - 1]
      const oi4hAgo   = oiHistUsd[oiHistUsd.length - 5]  || oiNow
      const oi24hAgo  = oiHistUsd[oiHistUsd.length - 25] || oiNow
      oiChange4h  = pct(oiNow, oi4hAgo)
      oiChange24h = pct(oiNow, oi24hAgo)
      // Acceleration: is 4h OI change rate accelerating vs prior 4h?
      const oi8hAgo = oiHistUsd[oiHistUsd.length - 9] || oiNow
      const prior4hChange = pct(oi4hAgo, oi8hAgo)
      oiAcceleration = +(oiChange4h - prior4hChange).toFixed(3)
    }
  }

  // ── Funding rate (settled, not predicted) ─────────────
  // Binance publishes settled funding rates via /fundingRate endpoint
  // The most recent entry is the LAST SETTLED rate, not the next predicted rate.
  let fundingRate     = null
  let fundingSettled  = false
  let hoursSinceFunding = null
  let fundingCategory = 'unavailable'

  if (hasFunding) {
    const lastSettlement = fundingHistory[fundingHistory.length - 1]
    fundingRate    = parseFloat(lastSettlement.fundingRate)
    fundingSettled = true
    hoursSinceFunding = (Date.now() - parseInt(lastSettlement.fundingTime)) / 3600000

    // Annualised = rate * 3 * 365 (3 settlements per day)
    const annualised = fundingRate * 3 * 365 * 100
    if (Math.abs(fundingRate) < 0.0001)       fundingCategory = 'neutral'
    else if (fundingRate > 0 && annualised < 30) fundingCategory = 'positive_acceptable'
    else if (fundingRate > 0 && annualised >= 30) fundingCategory = 'overheated'
    else if (fundingRate < -0.0001)              fundingCategory = 'negative_squeeze_potential'
  }

  // ── Taker buy/sell ratio ──────────────────────────────
  let takerBuyRatio = null
  if (takerData && takerData.length > 0) {
    const recent = takerData[takerData.length - 1]
    const buy  = parseFloat(recent.buyVol)
    const sell = parseFloat(recent.sellVol)
    takerBuyRatio = buy + sell > 0 ? +(buy / (buy + sell)).toFixed(4) : null
  }

  // ── Basis divergence ─────────────────────────────────
  // Basis = (futures price - spot price) / spot price
  let basisPct = null
  if (hasFutures && futuresTicker) {
    const futuresPrice = parseFloat(futuresTicker.lastPrice)
    basisPct = +((futuresPrice - currentPrice) / currentPrice * 100).toFixed(4)
  }

  // ── Estimated liquidation pressure ───────────────────
  // Simple approximation: if funding is overheated and OI is high,
  // longs are at liquidation risk within the funding sustainability horizon.
  let liquidationPressureScore = 0
  if (fundingCategory === 'overheated' && oiChange24h > 10) liquidationPressureScore = 2
  else if (fundingCategory === 'overheated') liquidationPressureScore = 1
  else if (fundingCategory === 'negative_squeeze_potential' && oiChange4h > 5) liquidationPressureScore = -1 // short squeeze risk

  // ── Volatility compression ────────────────────────────
  const hourlyRanges = spotCandles.map(c => (parseFloat(c[2]) - parseFloat(c[3])) / parseFloat(c[4]))
  const recentVol    = avg(hourlyRanges.slice(-4))
  const historicVol  = avg(hourlyRanges.slice(0, -4))
  const volCompression = historicVol > 0 ? +(recentVol / historicVol).toFixed(3) : null
  // < 0.5 = compressed (potential breakout setup), > 1.5 = expanding

  // ── Token unlock overhang ─────────────────────────────
  const unlockOverhang = getUnlockOverhang(symbol)

  // ── Risk flags ────────────────────────────────────────
  const risks = []
  if (fundingCategory === 'overheated')                          risks.push('overheated_funding')
  if (volumeShock > 5)                                           risks.push('extreme_volume_spike')
  if (return24h > 35)                                            risks.push('extended_price')
  if (relStrengthBtc !== null && Math.abs(relStrengthBtc) < 1)  risks.push('btc_dependent')
  if (oiChange24h > 50)                                          risks.push('aggressive_oi_buildup')
  if (unlockOverhang.hasOverhang)                                risks.push(`unlock_overhang_${unlockOverhang.daysToUnlock}d`)
  if (dataQuality < 2)                                           risks.push('low_data_quality')

  return {
    symbol,
    dataQuality,
    unavailable: false,
    price: +currentPrice.toFixed(8),
    return1h:  +return1h.toFixed(3),
    return4h:  +return4h.toFixed(3),
    return12h: +return12h.toFixed(3),
    return24h: +return24h.toFixed(3),
    volumeShock,
    oiUsdCurrent,
    oiChange4h,
    oiChange24h,
    oiAcceleration,
    fundingRate,
    fundingSettled,
    hoursSinceFunding: hoursSinceFunding ? +hoursSinceFunding.toFixed(1) : null,
    fundingCategory,
    relStrengthBtc,
    relStrengthEth,
    takerBuyRatio,
    basisPct,
    higherHigh,
    volCompression,
    liquidationPressureScore,
    unlockOverhang,
    risks,
    raw: {
      currentPrice, price1hAgo, price4hAgo, price24hAgo,
      vol24h, avgHourlyVol, highs: highs.slice(-6)
    }
  }
}

function pct(current, prior) {
  if (!prior || prior === 0) return 0
  return +((current - prior) / prior * 100).toFixed(3)
}

function avg(arr) {
  if (!arr || arr.length === 0) return 0
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

// ── Fetch all coins ──────────────────────────────────────────
async function fetchAllMetrics() {
  // Fetch BTC and ETH first so we can compute relative strength
  const btcCandles = await getCandles('BTCUSDT')
  const ethCandles = await getCandles('ETHUSDT')

  const btcCloses  = btcCandles ? btcCandles.map(c => parseFloat(c[4])) : []
  const ethCloses  = ethCandles ? ethCandles.map(c => parseFloat(c[4])) : []

  const btcReturn24h = btcCloses.length >= 25
    ? pct(btcCloses[btcCloses.length - 1], btcCloses[btcCloses.length - 25])
    : null
  const ethReturn24h = ethCloses.length >= 25
    ? pct(ethCloses[ethCloses.length - 1], ethCloses[ethCloses.length - 25])
    : null

  // Fetch all coins in parallel (rate limit: batch of 5)
  const results = []
  const batchSize = 5
  for (let i = 0; i < COIN_UNIVERSE.length; i += batchSize) {
    const batch = COIN_UNIVERSE.slice(i, i + batchSize)
    const batchResults = await Promise.all(
      batch.map(sym => computeCoinMetrics(sym, btcReturn24h, ethReturn24h))
    )
    results.push(...batchResults)
    if (i + batchSize < COIN_UNIVERSE.length) {
      await new Promise(r => setTimeout(r, 300)) // brief pause between batches
    }
  }

  return { metrics: results, btcReturn24h, ethReturn24h }
}

module.exports = { fetchAllMetrics, COIN_UNIVERSE }
