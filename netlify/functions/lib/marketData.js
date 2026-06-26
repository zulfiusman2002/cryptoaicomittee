// netlify/functions/lib/marketData.js
// DATA SOURCE: Bybit V5 public API (replaces Binance — not geo-blocked from AWS/Netlify)
// No API key required. All endpoints are public.
//
// Endpoints used:
//   Klines:        GET /v5/market/kline?category=linear&symbol=X&interval=60&limit=26
//   Ticker:        GET /v5/market/tickers?category=linear&symbol=X
//   Funding hist:  GET /v5/market/funding/history?category=linear&symbol=X&limit=3
//   OI history:    GET /v5/market/open-interest?category=linear&symbol=X&intervalTime=1h&limit=26
//
// NOTE: Bybit klines return NEWEST FIRST — all list processing reverses to chronological.
// NOTE: RNDRUSDT trades as RENDERUSDT on Bybit — see SYMBOL_MAP.
// NOTE: openInterestValue field is already in USDT — no price multiplication needed.

const BYBIT = 'https://api.bybit.com/v5/market'

// Symbols that differ between our universe and Bybit's naming
const SYMBOL_MAP = {
  'RNDRUSDT': 'RENDERUSDT',
}

const COIN_UNIVERSE = [
  'BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT',
  'ADAUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','NEARUSDT',
  'INJUSDT','FETUSDT','RNDRUSDT','ARBUSDT','OPUSDT',
  'SUIUSDT','APTUSDT','PEPEUSDT','WIFUSDT','SEIUSDT'
]

function toBybitSymbol(symbol) {
  return SYMBOL_MAP[symbol] || symbol
}

// ── HTTP helper ───────────────────────────────────────────────

async function safeFetch(url, label) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12000),
      headers: { 'Accept': 'application/json', 'User-Agent': 'CSIE/1.0' }
    })
    if (!res.ok) {
      let body = ''
      try { body = (await res.text()).slice(0, 200) } catch {}
      console.error(`[marketData] HTTP ${res.status} for ${label}: ${body}`)
      return null
    }
    const json = await res.json()
    // Bybit wraps everything in { retCode, result }
    if (json.retCode !== undefined && json.retCode !== 0) {
      console.error(`[marketData] Bybit retCode ${json.retCode} for ${label}: ${json.retMsg}`)
      return null
    }
    return json
  } catch (err) {
    console.error(`[marketData] fetch error for ${label}: ${err.message}`)
    return null
  }
}

// ── Bybit V5 fetchers ─────────────────────────────────────────

// Linear perp klines. interval=60 = 1 hour. Returns newest-first list.
async function getKlines(symbol, limit = 26) {
  const bybitSym = toBybitSymbol(symbol)
  const data = await safeFetch(
    `${BYBIT}/kline?category=linear&symbol=${bybitSym}&interval=60&limit=${limit}`,
    `klines ${symbol}`
  )
  if (!data?.result?.list) return null
  // Reverse so index 0 = oldest, last index = newest (chronological)
  return [...data.result.list].reverse()
  // Each entry: [startTime, open, high, low, close, volume, turnover]
}

// Linear ticker — gives price, 24h change, volume, OI, current funding rate
async function getTicker(symbol) {
  const bybitSym = toBybitSymbol(symbol)
  const data = await safeFetch(
    `${BYBIT}/tickers?category=linear&symbol=${bybitSym}`,
    `ticker ${symbol}`
  )
  return data?.result?.list?.[0] || null
}

// Funding rate history (settled). Newest first — we use last element after reversing.
async function getFundingHistory(symbol) {
  const bybitSym = toBybitSymbol(symbol)
  const data = await safeFetch(
    `${BYBIT}/funding/history?category=linear&symbol=${bybitSym}&limit=3`,
    `funding ${symbol}`
  )
  if (!data?.result?.list) return null
  return [...data.result.list].reverse() // oldest first; last = most recent settled
}

// OI history in base coin units. Newest first — reverse for chronological.
async function getOIHistory(symbol) {
  const bybitSym = toBybitSymbol(symbol)
  const data = await safeFetch(
    `${BYBIT}/open-interest?category=linear&symbol=${bybitSym}&intervalTime=1h&limit=26`,
    `OI hist ${symbol}`
  )
  if (!data?.result?.list) return null
  return [...data.result.list].reverse() // [{ openInterest, timestamp }, ...]
}

// ── Token unlock calendar ─────────────────────────────────────
const UNLOCK_OVERHANGS = {}

function getUnlockOverhang(symbol) {
  const entry = UNLOCK_OVERHANGS[symbol]
  if (!entry) return { hasOverhang: false }
  const daysToUnlock = (new Date(entry.date) - Date.now()) / 86400000
  if (daysToUnlock < 0 || daysToUnlock > 14) return { hasOverhang: false }
  return { hasOverhang: true, daysToUnlock: Math.round(daysToUnlock), pct: entry.pct }
}

// ── Per-coin calculation ──────────────────────────────────────

async function computeCoinMetrics(symbol, btcReturn24h, ethReturn24h) {
  // Fetch klines + ticker in parallel; funding + OI history if ticker succeeds
  const [klines, ticker] = await Promise.all([
    getKlines(symbol),
    getTicker(symbol)
  ])

  const hasKlines = Array.isArray(klines) && klines.length >= 2
  const hasTicker = !!ticker

  if (!hasKlines) {
    return { symbol, dataQuality: 0, unavailable: true }
  }

  // Fetch funding + OI history only if we have a valid ticker
  const [fundingHistory, oiHistory] = await Promise.all([
    hasTicker ? getFundingHistory(symbol) : Promise.resolve(null),
    hasTicker ? getOIHistory(symbol)     : Promise.resolve(null)
  ])

  const hasFunding = Array.isArray(fundingHistory) && fundingHistory.length > 0
  const hasOIHist  = Array.isArray(oiHistory)      && oiHistory.length >= 2

  // Data quality flag
  let dataQuality = 1                               // klines only
  if (hasKlines && hasTicker)   dataQuality = 2    // + ticker
  if (dataQuality === 2 && hasFunding) dataQuality = 3 // + funding

  // ── Price & returns from klines ───────────────────────────
  // klines[i] = [startTime, open, high, low, close, volume, turnover]
  const closes = klines.map(c => parseFloat(c[4]))
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
  // klines[i][6] = turnover in USDT (quote volume) — use this for USD comparison
  const turnovers    = klines.map(c => parseFloat(c[6]))
  const vol24hUsdt   = hasTicker ? parseFloat(ticker.turnover24h) : null
  const avgHourlyVol = turnovers.slice(0, -1).reduce((a, b) => a + b, 0) / Math.max(turnovers.length - 1, 1)
  const vol7dAvg     = avgHourlyVol * 24
  const volumeShock  = vol7dAvg > 0 && vol24hUsdt ? +(vol24hUsdt / vol7dAvg).toFixed(3) : null

  // ── Higher high detection ─────────────────────────────
  const highs      = klines.map(c => parseFloat(c[2]))
  const higherHigh = klines.length >= 5
    ? highs[highs.length - 1] > highs[highs.length - 3] &&
      highs[highs.length - 3] > highs[highs.length - 5]
    : false

  // ── Taker buy ratio ───────────────────────────────────
  // Bybit klines don't include taker buy field.
  // Approximate from bid/ask spread in ticker: if bid price is close to last price → buy pressure.
  // Use a simple proxy: price vs prevPrice24h direction indicates taker dominance.
  // This is a coarse approximation — mark as null if ticker unavailable.
  let takerBuyRatio = null
  if (hasTicker) {
    const bid  = parseFloat(ticker.bid1Price || 0)
    const ask  = parseFloat(ticker.ask1Price || 0)
    const last = parseFloat(ticker.lastPrice)
    if (bid > 0 && ask > 0 && ask > bid) {
      // Micro-price proxy: position of last within spread
      takerBuyRatio = +((last - bid) / (ask - bid)).toFixed(4)
    }
  }

  // ── Relative strength ─────────────────────────────────
  const relStrengthBtc = btcReturn24h !== null ? +(return24h - btcReturn24h).toFixed(3) : null
  const relStrengthEth = ethReturn24h !== null ? +(return24h - ethReturn24h).toFixed(3) : null

  // ── Open Interest (USD) ───────────────────────────────
  // openInterestValue from ticker is already in USDT — no multiplication needed
  let oiUsdCurrent  = null
  let oiChange4h    = null
  let oiChange24h   = null
  let oiAcceleration = null

  if (hasTicker && ticker.openInterestValue) {
    oiUsdCurrent = parseFloat(ticker.openInterestValue)
  }

  if (hasOIHist) {
    // OI history is in base coin units; multiply by current price for USD
    const oiUsd = oiHistory.map(o => parseFloat(o.openInterest) * currentPrice)
    const oiNow    = oiUsd[oiUsd.length - 1]
    const oi4hAgo  = oiUsd[Math.max(oiUsd.length - 5,  0)] || oiNow
    const oi24hAgo = oiUsd[Math.max(oiUsd.length - 25, 0)] || oiNow
    const oi8hAgo  = oiUsd[Math.max(oiUsd.length - 9,  0)] || oiNow
    oiChange4h     = pct(oiNow, oi4hAgo)
    oiChange24h    = pct(oiNow, oi24hAgo)
    oiAcceleration = +(oiChange4h - pct(oi4hAgo, oi8hAgo)).toFixed(3)
  }

  // ── Funding rate (settled) ────────────────────────────
  // Bybit ticker.fundingRate = current/next predicted rate — NOT settled
  // fundingHistory[-1] = most recently settled rate
  let fundingRate      = null
  let fundingSettled   = false
  let hoursSinceFunding = null
  let fundingCategory  = 'unavailable'

  if (hasFunding) {
    const last = fundingHistory[fundingHistory.length - 1]
    fundingRate       = parseFloat(last.fundingRate)
    fundingSettled    = true
    hoursSinceFunding = (Date.now() - parseInt(last.fundingRateTimestamp)) / 3600000

    const annualised = fundingRate * 3 * 365 * 100
    if (Math.abs(fundingRate) < 0.0001)          fundingCategory = 'neutral'
    else if (fundingRate > 0 && annualised < 30)  fundingCategory = 'positive_acceptable'
    else if (fundingRate > 0 && annualised >= 30) fundingCategory = 'overheated'
    else if (fundingRate < -0.0001)               fundingCategory = 'negative_squeeze_potential'
  } else if (hasTicker && ticker.fundingRate) {
    // Fall back to ticker's predicted rate with lower confidence
    fundingRate     = parseFloat(ticker.fundingRate)
    fundingSettled  = false
    const annualised = fundingRate * 3 * 365 * 100
    if (Math.abs(fundingRate) < 0.0001)          fundingCategory = 'neutral'
    else if (fundingRate > 0 && annualised < 30)  fundingCategory = 'positive_acceptable'
    else if (fundingRate > 0 && annualised >= 30) fundingCategory = 'overheated'
    else if (fundingRate < -0.0001)               fundingCategory = 'negative_squeeze_potential'
  }

  // ── Basis (perp vs spot proxy) ────────────────────────
  // On Bybit linear perps, lastPrice IS the perp price.
  // We don't have a separate spot feed in this setup.
  // Mark basisPct as null — not computable without a separate spot source.
  const basisPct = null

  // ── Liquidation pressure ──────────────────────────────
  let liquidationPressureScore = 0
  if (fundingCategory === 'overheated' && (oiChange24h || 0) > 10)              liquidationPressureScore = 2
  else if (fundingCategory === 'overheated')                                     liquidationPressureScore = 1
  else if (fundingCategory === 'negative_squeeze_potential' && (oiChange4h||0) > 5) liquidationPressureScore = -1

  // ── Volatility compression ────────────────────────────
  const hourlyRanges = klines.map(c => {
    const h = parseFloat(c[2]), l = parseFloat(c[3]), cl = parseFloat(c[4])
    return cl > 0 ? (h - l) / cl : 0
  })
  const recentVol    = avg(hourlyRanges.slice(-4))
  const historicVol  = avg(hourlyRanges.slice(0, -4))
  const volCompression = historicVol > 0 ? +(recentVol / historicVol).toFixed(3) : null

  // ── Token unlock ──────────────────────────────────────
  const unlockOverhang = getUnlockOverhang(symbol)

  // ── Risk flags ────────────────────────────────────────
  const risks = []
  if (fundingCategory === 'overheated')                                    risks.push('overheated_funding')
  if ((volumeShock || 0) > 5)                                              risks.push('extreme_volume_spike')
  if (return24h > 35)                                                      risks.push('extended_price')
  if (relStrengthBtc !== null && Math.abs(relStrengthBtc) < 1)            risks.push('btc_dependent')
  if ((oiChange24h || 0) > 50)                                             risks.push('aggressive_oi_buildup')
  if (unlockOverhang.hasOverhang)                                          risks.push(`unlock_overhang_${unlockOverhang.daysToUnlock}d`)
  if (dataQuality < 2)                                                     risks.push('low_data_quality')

  return {
    symbol,
    dataQuality,
    unavailable: false,
    price:    +currentPrice.toFixed(8),
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
      vol24hUsdt, avgHourlyVol, highs: highs.slice(-6),
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
  console.log('[marketData] Starting Bybit fetch for', COIN_UNIVERSE.length, 'coins')

  // Verify Bybit is reachable with a single ping
  try {
    const ping = await fetch(`${BYBIT}/time`, {
      signal: AbortSignal.timeout(6000),
      headers: { 'User-Agent': 'CSIE/1.0' }
    })
    if (ping.ok) {
      console.log('[marketData] Bybit reachable ✓')
    } else {
      console.error(`[marketData] Bybit ping returned HTTP ${ping.status}`)
    }
  } catch (err) {
    console.error('[marketData] Bybit unreachable:', err.message)
  }

  // BTC and ETH baselines for relative strength
  const [btcKlines, ethKlines] = await Promise.all([
    getKlines('BTCUSDT'),
    getKlines('ETHUSDT')
  ])

  const btcCloses = Array.isArray(btcKlines) ? btcKlines.map(c => parseFloat(c[4])) : []
  const ethCloses = Array.isArray(ethKlines) ? ethKlines.map(c => parseFloat(c[4])) : []

  const btcReturn24h = btcCloses.length >= 25
    ? pct(btcCloses[btcCloses.length - 1], btcCloses[btcCloses.length - 25])
    : null
  const ethReturn24h = ethCloses.length >= 25
    ? pct(ethCloses[ethCloses.length - 1], ethCloses[ethCloses.length - 25])
    : null

  console.log('[marketData] BTC 24h return:', btcReturn24h !== null ? `${btcReturn24h}%` : 'FAILED')
  console.log('[marketData] ETH 24h return:', ethReturn24h !== null ? `${ethReturn24h}%` : 'FAILED')

  if (btcReturn24h === null) {
    console.error('[marketData] CRITICAL: BTC klines failed — Bybit may also be unreachable from this region.')
  }

  // Batch fetch all coins (5 at a time)
  const results = []
  let successCount = 0
  let failCount    = 0
  const batchSize  = 5

  for (let i = 0; i < COIN_UNIVERSE.length; i += batchSize) {
    const batch = COIN_UNIVERSE.slice(i, i + batchSize)
    const batchResults = await Promise.all(
      batch.map(sym => computeCoinMetrics(sym, btcReturn24h, ethReturn24h))
    )

    for (const r of batchResults) {
      if (r.unavailable) {
        failCount++
        console.warn(`[marketData] ${r.symbol}: no data`)
      } else {
        successCount++
        if (successCount === 1) {
          console.log(`[marketData] First success: ${r.symbol} price=${r.price} dq=${r.dataQuality}`)
        }
      }
      results.push(r)
    }

    if (i + batchSize < COIN_UNIVERSE.length) {
      await new Promise(res => setTimeout(res, 200))
    }
  }

  console.log(`[marketData] Done: ${successCount} success, ${failCount} failed / ${COIN_UNIVERSE.length}`)

  return {
    metrics: results,
    btcReturn24h,
    ethReturn24h,
    diagnostics: {
      successCount,
      failCount,
      total:    COIN_UNIVERSE.length,
      provider: 'bybit-v5'
    }
  }
}

module.exports = { fetchAllMetrics, COIN_UNIVERSE }
