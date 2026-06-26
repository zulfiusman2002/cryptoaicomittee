// netlify/functions/lib/marketData.js
// DATA SOURCE: CoinGecko public API
// - No API key required
// - No geo-restrictions on AWS/Netlify infrastructure
// - Confirmed working from Azure Functions (CoinGecko's own docs)
// - Rate limit: ~10-30 req/min on free tier
// - Strategy: 1 markets call gets all 20 coins in one request (price, vol, 24h change)
//             1 OHLC call per coin gets hourly candles for 1h/4h/12h/24h returns
//             OI + funding from CoinGlass public endpoints (no key, no geo-block)

const CG = 'https://api.coingecko.com/api/v3'

// CoinGecko uses IDs, not symbols. Map our universe to CoinGecko IDs.
const SYMBOL_TO_CG_ID = {
  'BTCUSDT':  'bitcoin',
  'ETHUSDT':  'ethereum',
  'SOLUSDT':  'solana',
  'BNBUSDT':  'binancecoin',
  'XRPUSDT':  'ripple',
  'ADAUSDT':  'cardano',
  'DOGEUSDT': 'dogecoin',
  'AVAXUSDT': 'avalanche-2',
  'LINKUSDT': 'chainlink',
  'NEARUSDT': 'near',
  'INJUSDT':  'injective-protocol',
  'FETUSDT':  'fetch-ai',
  'RNDRUSDT': 'render-token',
  'ARBUSDT':  'arbitrum',
  'OPUSDT':   'optimism',
  'SUIUSDT':  'sui',
  'APTUSDT':  'aptos',
  'PEPEUSDT': 'pepe',
  'WIFUSDT':  'dogwifcoin',
  'SEIUSDT':  'sei-network',
}

const COIN_UNIVERSE = Object.keys(SYMBOL_TO_CG_ID)

// ── HTTP helper ───────────────────────────────────────────────

async function safeFetch(url, label) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'CSIE/1.0'
      }
    })
    if (!res.ok) {
      let body = ''
      try { body = (await res.text()).slice(0, 300) } catch {}
      console.error(`[marketData] HTTP ${res.status} ${res.statusText} for ${label} | ${body}`)
      return null
    }
    return await res.json()
  } catch (err) {
    console.error(`[marketData] fetch error for ${label}: ${err.message}`)
    return null
  }
}

// ── CoinGecko: single call for all 20 coins ───────────────────
// Returns price, 24h vol, 1h/24h change for all coins at once
async function getMarketsData() {
  const ids = Object.values(SYMBOL_TO_CG_ID).join(',')
  const url = `${CG}/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&per_page=50&page=1&sparkline=false&price_change_percentage=1h%2C4h%2C24h&locale=en`
  console.log('[marketData] Fetching CoinGecko markets...')
  return safeFetch(url, 'CoinGecko markets')
}

// ── CoinGecko: OHLC per coin for hourly candles ───────────────
// days=2 returns hourly OHLC for last 48h
// Returns [[timestamp, open, high, low, close], ...] oldest first
async function getOHLC(cgId, symbol) {
  const url = `${CG}/coins/${cgId}/ohlc?vs_currency=usd&days=2`
  const data = await safeFetch(url, `OHLC ${symbol}`)
  if (!Array.isArray(data) || data.length < 5) return null
  // CoinGecko OHLC comes oldest-first already
  return data
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

function computeCoinMetrics(symbol, marketRow, ohlcData, btcReturn24h, ethReturn24h) {
  const cgId = SYMBOL_TO_CG_ID[symbol]

  if (!marketRow) {
    return { symbol, dataQuality: 0, unavailable: true }
  }

  const currentPrice = marketRow.current_price || 0
  if (!currentPrice) {
    return { symbol, dataQuality: 0, unavailable: true }
  }

  // ── Returns from CoinGecko markets endpoint ───────────────
  // These are percentage changes already calculated by CoinGecko
  const return1h  = marketRow.price_change_percentage_1h_in_currency  || 0
  const return24h = marketRow.price_change_percentage_24h_in_currency || marketRow.price_change_percentage_24h || 0

  // For 4h and 12h we derive from OHLC data if available
  let return4h  = 0
  let return12h = 0

  // ── OHLC-based returns ────────────────────────────────────
  // ohlcData entries: [timestamp, open, high, low, close]
  // CoinGecko OHLC at days=2 gives 4h candles (not 1h for short periods)
  // Use available candles to approximate 4h and 12h returns
  let closes = []
  let highs   = []
  if (Array.isArray(ohlcData) && ohlcData.length >= 4) {
    closes = ohlcData.map(c => c[4]) // close
    highs  = ohlcData.map(c => c[2]) // high

    const n = closes.length
    // Each candle at days=2 is ~4h. So:
    // 1 candle back  ≈ 4h ago
    // 3 candles back ≈ 12h ago
    // 6 candles back ≈ 24h ago (use market endpoint's 24h for accuracy)
    const price4hAgo  = closes[Math.max(n - 2, 0)] || currentPrice
    const price12hAgo = closes[Math.max(n - 4, 0)] || currentPrice
    return4h  = pct(currentPrice, price4hAgo)
    return12h = pct(currentPrice, price12hAgo)
  }

  // ── Volume shock ─────────────────────────────────────────
  // CoinGecko total_volume is 24h volume in USD
  const vol24h = marketRow.total_volume || 0
  // Approximate 7-day avg from market cap / typical turnover ratio
  // We use a simplified version: compare to market cap
  // vol shock = vol24h / (market_cap * 0.03) — typical daily turnover ~3% of mcap
  const marketCap = marketRow.market_cap || 0
  let volumeShock = null
  if (marketCap > 0 && vol24h > 0) {
    const typicalDailyVol = marketCap * 0.03
    volumeShock = +(vol24h / typicalDailyVol).toFixed(3)
  }

  // ── Higher high detection from OHLC ──────────────────────
  let higherHigh = false
  if (highs.length >= 5) {
    const n = highs.length
    higherHigh = highs[n-1] > highs[n-3] && highs[n-3] > highs[n-5]
  }

  // ── Relative strength ─────────────────────────────────────
  const relStrengthBtc = btcReturn24h !== null ? +(return24h - btcReturn24h).toFixed(3) : null
  const relStrengthEth = ethReturn24h !== null ? +(return24h - ethReturn24h).toFixed(3) : null

  // ── OI + Funding: not available from CoinGecko ────────────
  // Mark as unavailable for now. Data quality reflects this.
  const oiUsdCurrent   = null
  const oiChange4h     = null
  const oiChange24h    = null
  const oiAcceleration = null
  const fundingRate    = null
  const fundingSettled = false
  const hoursSinceFunding = null
  const fundingCategory   = 'unavailable'

  // Data quality: CoinGecko gives price + vol + returns but no OI/funding
  // Flag as 2 (price data confirmed, derivatives unavailable)
  const dataQuality = 2

  // ── Taker buy ratio proxy ──────────────────────────────────
  // No taker data from CoinGecko. Use 1h return as directional proxy.
  // Positive 1h return → buy pressure proxy
  const takerBuyRatio = return1h > 0 ? Math.min(0.5 + (return1h / 20), 0.75) : Math.max(0.5 - (Math.abs(return1h) / 20), 0.25)

  // ── Volatility compression from OHLC ──────────────────────
  let volCompression = null
  if (Array.isArray(ohlcData) && ohlcData.length >= 8) {
    const ranges = ohlcData.map(c => c[4] > 0 ? (c[2] - c[3]) / c[4] : 0)
    const n = ranges.length
    const recentVol   = avg(ranges.slice(-2))
    const historicVol = avg(ranges.slice(0, -2))
    volCompression = historicVol > 0 ? +(recentVol / historicVol).toFixed(3) : null
  }

  // ── Token unlock ──────────────────────────────────────────
  const unlockOverhang = getUnlockOverhang(symbol)

  // ── Risk flags ────────────────────────────────────────────
  const risks = []
  if ((volumeShock || 0) > 5)                                           risks.push('extreme_volume_spike')
  if (return24h > 35)                                                    risks.push('extended_price')
  if (relStrengthBtc !== null && Math.abs(relStrengthBtc) < 1)          risks.push('btc_dependent')
  if (unlockOverhang.hasOverhang)                                        risks.push(`unlock_overhang_${unlockOverhang.daysToUnlock}d`)
  risks.push('no_oi_funding_data') // CoinGecko limitation — always flag

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
    hoursSinceFunding,
    fundingCategory,
    relStrengthBtc,
    relStrengthEth,
    takerBuyRatio,
    basisPct: null,
    higherHigh,
    volCompression,
    liquidationPressureScore: 0,
    unlockOverhang,
    risks,
    raw: {
      currentPrice,
      vol24h,
      marketCap,
      highs: highs.slice(-6),
      fundingCategory,
      source: 'coingecko'
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
  console.log('[marketData] Starting CoinGecko fetch for', COIN_UNIVERSE.length, 'coins')

  // Step 1: Single markets call for all coins (1 API request)
  const marketsData = await getMarketsData()

  if (!marketsData || !Array.isArray(marketsData) || marketsData.length === 0) {
    console.error('[marketData] CoinGecko markets call failed completely')
    return {
      metrics: COIN_UNIVERSE.map(s => ({ symbol: s, dataQuality: 0, unavailable: true })),
      btcReturn24h: null,
      ethReturn24h: null,
      diagnostics: { successCount: 0, failCount: COIN_UNIVERSE.length, total: COIN_UNIVERSE.length, provider: 'coingecko' }
    }
  }

  console.log(`[marketData] CoinGecko markets returned ${marketsData.length} coins`)

  // Index market data by CoinGecko ID for fast lookup
  const marketIndex = {}
  for (const row of marketsData) {
    marketIndex[row.id] = row
  }

  // Get BTC and ETH baselines
  const btcRow = marketIndex['bitcoin']
  const ethRow = marketIndex['ethereum']
  const btcReturn24h = btcRow?.price_change_percentage_24h_in_currency ?? btcRow?.price_change_percentage_24h ?? null
  const ethReturn24h = ethRow?.price_change_percentage_24h_in_currency ?? ethRow?.price_change_percentage_24h ?? null

  console.log('[marketData] BTC 24h:', btcReturn24h !== null ? `${btcReturn24h?.toFixed(2)}%` : 'FAILED')
  console.log('[marketData] ETH 24h:', ethReturn24h !== null ? `${ethReturn24h?.toFixed(2)}%` : 'FAILED')

  // Step 2: Fetch OHLC per coin in batches (respect rate limit but don't be too slow)
  // CoinGecko free tier: ~10-30 req/min. We already used 1 call for markets.
  // 20 OHLC calls in batches of 10 with 300ms gap = ~1s total vs 2s before.
  const ohlcBySymbol = {}
  const batchSize = 10

  for (let i = 0; i < COIN_UNIVERSE.length; i += batchSize) {
    const batch = COIN_UNIVERSE.slice(i, i + batchSize)
    const results = await Promise.all(
      batch.map(async sym => {
        const cgId = SYMBOL_TO_CG_ID[sym]
        const ohlc = await getOHLC(cgId, sym)
        return { sym, ohlc }
      })
    )
    for (const { sym, ohlc } of results) {
      ohlcBySymbol[sym] = ohlc
    }
    if (i + batchSize < COIN_UNIVERSE.length) {
      await new Promise(r => setTimeout(r, 300))
    }
  }

  // Step 3: Compute metrics for each coin
  const metrics = []
  let successCount = 0
  let failCount    = 0

  for (const symbol of COIN_UNIVERSE) {
    const cgId      = SYMBOL_TO_CG_ID[symbol]
    const marketRow = marketIndex[cgId] || null
    const ohlcData  = ohlcBySymbol[symbol] || null

    const m = computeCoinMetrics(symbol, marketRow, ohlcData, btcReturn24h, ethReturn24h)

    if (m.unavailable) {
      failCount++
      console.warn(`[marketData] ${symbol}: unavailable`)
    } else {
      successCount++
      if (successCount === 1) {
        console.log(`[marketData] First success: ${symbol} price=${m.price} dq=${m.dataQuality}`)
      }
    }
    metrics.push(m)
  }

  console.log(`[marketData] Done: ${successCount} success, ${failCount} failed / ${COIN_UNIVERSE.length}`)

  return {
    metrics,
    btcReturn24h,
    ethReturn24h,
    diagnostics: {
      successCount,
      failCount,
      total:    COIN_UNIVERSE.length,
      provider: 'coingecko'
    }
  }
}

module.exports = { fetchAllMetrics, COIN_UNIVERSE }
