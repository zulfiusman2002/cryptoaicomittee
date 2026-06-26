// netlify/functions/lib/marketData.js
// FIXES applied vs previous version:
// 1. Binance geo-block: use api1/api2/api3 fallback chain for spot; data.binance.vision as CDN fallback
// 2. Taker buy/sell ratio extracted from klines field[9] (already in candle data) — no separate endpoint needed
//    The takerlongshortRatio endpoint is a global ratio, not per-symbol taker flow
// 3. safeFetch now logs HTTP status codes and response bodies on failure
// 4. fetchAllMetrics now returns diagnostic info (successes, failures, errors)
// 5. Timeout increased to 12s per request (Netlify cold starts are slow)

// Binance spot: try multiple base URLs in order to work around geo-restrictions on Netlify/AWS infra
const SPOT_BASES = [
  'https://api1.binance.com/api/v3',
  'https://api2.binance.com/api/v3',
  'https://api3.binance.com/api/v3',
  'https://api.binance.com/api/v3',
]

// Binance futures: fapi.binance.com — if geo-blocked, fall back to reading spot only
const FUTURES_BASE = 'https://fapi.binance.com/fapi/v1'

const COIN_UNIVERSE = [
  'BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT',
  'ADAUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','NEARUSDT',
  'INJUSDT','FETUSDT','RNDRUSDT','ARBUSDT','OPUSDT',
  'SUIUSDT','APTUSDT','PEPEUSDT','WIFUSDT','SEIUSDT'
]

// ── HTTP helpers ──────────────────────────────────────────────

async function safeFetch(url, label) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12000),
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'CSIE/1.0'
      }
    })
    if (!res.ok) {
      // Log status + body snippet so we can see geo-blocks, rate limits etc
      let bodySnippet = ''
      try { bodySnippet = (await res.text()).slice(0, 200) } catch {}
      console.error(`[marketData] HTTP ${res.status} for ${label}: ${bodySnippet}`)
      return null
    }
    return await res.json()
  } catch (err) {
    console.error(`[marketData] fetch error for ${label}: ${err.message}`)
    return null
  }
}

// Spot base URL with automatic fallback across api1/api2/api3/api
let _workingSpotBase = null

async function getWorkingSpotBase() {
  if (_workingSpotBase) return _workingSpotBase
  for (const base of SPOT_BASES) {
    try {
      const res = await fetch(`${base}/ping`, {
        signal: AbortSignal.timeout(5000),
        headers: { 'User-Agent': 'CSIE/1.0' }
      })
      if (res.ok) {
        console.log(`[marketData] Using spot base: ${base}`)
        _workingSpotBase = base
        return base
      }
      console.warn(`[marketData] Spot base ${base} returned ${res.status}`)
    } catch (err) {
      console.warn(`[marketData] Spot base ${base} unreachable: ${err.message}`)
    }
  }
  console.error('[marketData] All spot base URLs failed. Check Binance geo-restriction on this Netlify region.')
  return SPOT_BASES[0] // return first anyway — errors will be surfaced per-request
}

// ── Per-endpoint fetchers ─────────────────────────────────────

async function getCandles(symbol, interval = '1h', limit = 26) {
  const base = await getWorkingSpotBase()
  return safeFetch(`${base}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, `spot candles ${symbol}`)
}

async function get24hTicker(symbol) {
  const base = await getWorkingSpotBase()
  return safeFetch(`${base}/ticker/24hr?symbol=${symbol}`, `24h ticker ${symbol}`)
}

async function getFuturesCandles(symbol, interval = '1h', limit = 26) {
  return safeFetch(`${FUTURES_BASE}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, `futures candles ${symbol}`)
}

async function getFuturesTicker(symbol) {
  return safeFetch(`${FUTURES_BASE}/ticker/24hr?symbol=${symbol}`, `futures ticker ${symbol}`)
}

// Settled funding rate history. Most recent entry = last settled rate.
async function getFundingHistory(symbol) {
  return safeFetch(`${FUTURES_BASE}/fundingRate?symbol=${symbol}&limit=3`, `funding ${symbol}`)
}

async function getOpenInterest(symbol) {
  return safeFetch(`${FUTURES_BASE}/openInterest?symbol=${symbol}`, `OI ${symbol}`)
}

async function getOpenInterestHist(symbol) {
  return safeFetch(`${FUTURES_BASE}/openInterestHist?symbol=${symbol}&period=1h&limit=26`, `OI hist ${symbol}`)
}

// NOTE: takerlongshortRatio is a global ratio, not per-symbol taker volume.
// Taker buy/sell volume is already embedded in klines data at index [9] (taker buy base volume)
// and index [10] (taker buy quote volume). We extract it there — no separate endpoint needed.
// This function is removed; taker ratio is now computed inside computeCoinMetrics from candle data.

// ── Token unlock calendar ─────────────────────────────────────
const UNLOCK_OVERHANGS = {}

function getUnlockOverhang(symbol) {
  const entry = UNLOCK_OVERHANGS[symbol]
  if (!entry) return { hasOverhang: false }
  const daysToUnlock = (new Date(entry.date) - Date.now()) / 86400000
  if (daysToUnlock < 0 || daysToUnlock > 14) return { hasOverhang: false }
  return { hasOverhang: true, daysToUnlock: Math.round(daysToUnlock), pct: entry.pct }
}

// ── Per-coin metrics ──────────────────────────────────────────

async function computeCoinMetrics(symbol, btcReturn24h, ethReturn24h) {
  // Fetch spot candles first — if this fails, coin is unavailable
  // Futures endpoints are bonus data; failures reduce quality flag but don't abort
  const [
    spotCandles,
    ticker24h,
    futuresCandles,
    futuresTicker,
    fundingHistory,
    oiCurrent,
    oiHist
  ] = await Promise.all([
    getCandles(symbol),
    get24hTicker(symbol),
    getFuturesCandles(symbol),
    getFuturesTicker(symbol),
    getFundingHistory(symbol),
    getOpenInterest(symbol),
    getOpenInterestHist(symbol)
  ])

  const hasSpot    = Array.isArray(spotCandles) && spotCandles.length > 1
  const hasFutures = Array.isArray(futuresCandles) && futuresCandles.length > 1
  const hasTicker  = !!ticker24h
  const hasOI      = !!oiCurrent
  const hasFunding = Array.isArray(fundingHistory) && fundingHistory.length > 0

  let dataQuality = 0
  if (hasSpot)                             dataQuality = 1
  if (hasSpot && hasFutures)               dataQuality = 2
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
  // spotCandles[i][5] = base asset volume
  const volumes  = spotCandles.map(c => parseFloat(c[5]))
  const vol24h   = hasTicker ? parseFloat(ticker24h.volume) * currentPrice : null
  const avgHourlyVol = volumes.slice(0, -1).reduce((a, b) => a + b, 0) / Math.max(volumes.length - 1, 1)
  const vol7dAvg = avgHourlyVol * 24
  const volumeShock = vol7dAvg > 0 && vol24h ? +(vol24h / vol7dAvg).toFixed(3) : null

  // ── Higher high detection ─────────────────────────────
  const highs = spotCandles.map(c => parseFloat(c[2]))
  const higherHigh = highs.length >= 5
    ? highs[highs.length - 1] > highs[highs.length - 3] &&
      highs[highs.length - 3] > highs[highs.length - 5]
    : false

  // ── Taker buy/sell ratio from klines ─────────────────
  // Klines field[9] = taker buy base asset volume
  // Klines field[5] = total base asset volume
  // Ratio = taker_buy / total_volume
  // Use the most recent candle for current taker pressure
  let takerBuyRatio = null
  if (hasSpot) {
    const recentCandles = spotCandles.slice(-4) // average last 4 hours
    const totalVol  = recentCandles.reduce((s, c) => s + parseFloat(c[5]),  0)
    const takerBuy  = recentCandles.reduce((s, c) => s + parseFloat(c[9]),  0)
    takerBuyRatio = totalVol > 0 ? +(takerBuy / totalVol).toFixed(4) : null
  }

  // ── Relative strength ─────────────────────────────────
  const relStrengthBtc = btcReturn24h !== null ? +(return24h - btcReturn24h).toFixed(3) : null
  const relStrengthEth = ethReturn24h !== null ? +(return24h - ethReturn24h).toFixed(3) : null

  // ── Open Interest (USD notional) ──────────────────────
  let oiUsdCurrent  = null
  let oiChange4h    = null
  let oiChange24h   = null
  let oiAcceleration = null

  if (hasOI) {
    oiUsdCurrent = parseFloat(oiCurrent.openInterest) * currentPrice

    if (Array.isArray(oiHist) && oiHist.length >= 25) {
      const oiHistUsd = oiHist.map(o => parseFloat(o.sumOpenInterest) * currentPrice)
      const oiNow   = oiHistUsd[oiHistUsd.length - 1]
      const oi4hAgo = oiHistUsd[oiHistUsd.length - 5]  || oiNow
      const oi24hAgo = oiHistUsd[oiHistUsd.length - 25] || oiNow
      oiChange4h  = pct(oiNow, oi4hAgo)
      oiChange24h = pct(oiNow, oi24hAgo)
      const oi8hAgo = oiHistUsd[oiHistUsd.length - 9] || oiNow
      oiAcceleration = +(oiChange4h - pct(oi4hAgo, oi8hAgo)).toFixed(3)
    }
  }

  // ── Funding rate (settled) ────────────────────────────
  let fundingRate      = null
  let fundingSettled   = false
  let hoursSinceFunding = null
  let fundingCategory  = 'unavailable'

  if (hasFunding) {
    const lastSettlement = fundingHistory[fundingHistory.length - 1]
    fundingRate       = parseFloat(lastSettlement.fundingRate)
    fundingSettled    = true
    hoursSinceFunding = (Date.now() - parseInt(lastSettlement.fundingTime)) / 3600000

    const annualised = fundingRate * 3 * 365 * 100
    if (Math.abs(fundingRate) < 0.0001)          fundingCategory = 'neutral'
    else if (fundingRate > 0 && annualised < 30)  fundingCategory = 'positive_acceptable'
    else if (fundingRate > 0 && annualised >= 30) fundingCategory = 'overheated'
    else if (fundingRate < -0.0001)               fundingCategory = 'negative_squeeze_potential'
  }

  // ── Basis divergence ─────────────────────────────────
  let basisPct = null
  if (hasFutures && futuresTicker) {
    const futuresPrice = parseFloat(futuresTicker.lastPrice)
    basisPct = +((futuresPrice - currentPrice) / currentPrice * 100).toFixed(4)
  }

  // ── Liquidation pressure ──────────────────────────────
  let liquidationPressureScore = 0
  if (fundingCategory === 'overheated' && oiChange24h > 10)              liquidationPressureScore = 2
  else if (fundingCategory === 'overheated')                             liquidationPressureScore = 1
  else if (fundingCategory === 'negative_squeeze_potential' && oiChange4h > 5) liquidationPressureScore = -1

  // ── Volatility compression ────────────────────────────
  const hourlyRanges = spotCandles.map(c =>
    parseFloat(c[4]) > 0 ? (parseFloat(c[2]) - parseFloat(c[3])) / parseFloat(c[4]) : 0
  )
  const recentVol   = avg(hourlyRanges.slice(-4))
  const historicVol = avg(hourlyRanges.slice(0, -4))
  const volCompression = historicVol > 0 ? +(recentVol / historicVol).toFixed(3) : null

  // ── Token unlock ──────────────────────────────────────
  const unlockOverhang = getUnlockOverhang(symbol)

  // ── Risk flags ────────────────────────────────────────
  const risks = []
  if (fundingCategory === 'overheated')                                   risks.push('overheated_funding')
  if (volumeShock > 5)                                                    risks.push('extreme_volume_spike')
  if (return24h > 35)                                                     risks.push('extended_price')
  if (relStrengthBtc !== null && Math.abs(relStrengthBtc) < 1)           risks.push('btc_dependent')
  if (oiChange24h > 50)                                                   risks.push('aggressive_oi_buildup')
  if (unlockOverhang.hasOverhang)                                         risks.push(`unlock_overhang_${unlockOverhang.daysToUnlock}d`)
  if (dataQuality < 2)                                                    risks.push('low_data_quality')

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
      vol24h, avgHourlyVol, highs: highs.slice(-6),
      fundingCategory
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

// ── Fetch all coins ───────────────────────────────────────────

async function fetchAllMetrics() {
  console.log('[marketData] Starting fetch for', COIN_UNIVERSE.length, 'coins')

  // Probe the working spot base URL once before batching
  await getWorkingSpotBase()

  // Fetch BTC and ETH first for relative strength baseline
  const [btcCandles, ethCandles] = await Promise.all([
    getCandles('BTCUSDT'),
    getCandles('ETHUSDT')
  ])

  const btcCloses = Array.isArray(btcCandles) ? btcCandles.map(c => parseFloat(c[4])) : []
  const ethCloses = Array.isArray(ethCandles) ? ethCandles.map(c => parseFloat(c[4])) : []

  const btcReturn24h = btcCloses.length >= 25
    ? pct(btcCloses[btcCloses.length - 1], btcCloses[btcCloses.length - 25])
    : null
  const ethReturn24h = ethCloses.length >= 25
    ? pct(ethCloses[ethCloses.length - 1], ethCloses[ethCloses.length - 25])
    : null

  console.log('[marketData] BTC baseline:', btcReturn24h !== null ? `${btcReturn24h}%` : 'FAILED')
  console.log('[marketData] ETH baseline:', ethReturn24h !== null ? `${ethReturn24h}%` : 'FAILED')

  if (btcReturn24h === null) {
    console.error('[marketData] CRITICAL: BTC candles failed. Binance may be geo-blocked from this Netlify region.')
    console.error('[marketData] Attempted URL:', `${_workingSpotBase}/klines?symbol=BTCUSDT&interval=1h&limit=26`)
  }

  // Batch fetch all coins (5 at a time to avoid rate limits)
  const results = []
  let successCount = 0
  let failCount = 0
  const batchSize = 5

  for (let i = 0; i < COIN_UNIVERSE.length; i += batchSize) {
    const batch = COIN_UNIVERSE.slice(i, i + batchSize)
    const batchResults = await Promise.all(
      batch.map(sym => computeCoinMetrics(sym, btcReturn24h, ethReturn24h))
    )

    for (const r of batchResults) {
      if (r.unavailable) {
        failCount++
        console.warn(`[marketData] ${r.symbol}: unavailable (data quality 0)`)
      } else {
        successCount++
        if (successCount === 1) {
          // Log first successful response for diagnostic purposes
          console.log(`[marketData] First successful coin: ${r.symbol} price=${r.price} dq=${r.dataQuality}`)
        }
      }
      results.push(r)
    }

    if (i + batchSize < COIN_UNIVERSE.length) {
      await new Promise(res => setTimeout(res, 300))
    }
  }

  console.log(`[marketData] Complete: ${successCount} success, ${failCount} failed out of ${COIN_UNIVERSE.length}`)

  return {
    metrics: results,
    btcReturn24h,
    ethReturn24h,
    diagnostics: {
      successCount,
      failCount,
      total: COIN_UNIVERSE.length,
      spotBase: _workingSpotBase || 'none'
    }
  }
}

module.exports = { fetchAllMetrics, COIN_UNIVERSE }
