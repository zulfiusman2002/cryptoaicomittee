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

function computeCoinMetrics(symbol, marketRow, ohlcData, btcReturn24h, ethReturn24h, derivData = null) {
  const cgId = SYMBOL_TO_CG_ID[symbol]

  if (!marketRow) {
    return { symbol, dataQuality: 0, unavailable: true }
  }

  const currentPrice = marketRow.current_price || 0
  if (!currentPrice) {
    return { symbol, dataQuality: 0, unavailable: true }
  }

  // ── Returns from CoinGecko markets endpoint ───────────────
  const return1h  = marketRow.price_change_percentage_1h_in_currency  ?? null
  const return24h = marketRow.price_change_percentage_24h_in_currency
                 ?? marketRow.price_change_percentage_24h
                 ?? null

  // 4h and 12h are unavailable without OHLC data (OHLC calls removed to avoid 429s)
  // Return null explicitly — display layer shows N/A instead of misleading 0.00%
  const return4h  = null
  const return12h = null

  // higherHigh unavailable without OHLC
  const higherHigh = false
  const highs = []

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

  // ── Relative strength ─────────────────────────────────────
  const relStrengthBtc = btcReturn24h !== null && return24h !== null ? +(return24h - btcReturn24h).toFixed(3) : null
  const relStrengthEth = ethReturn24h !== null && return24h !== null ? +(return24h - ethReturn24h).toFixed(3) : null

  // ── OI + Funding from Bybit (if available) ────────────────
  // derivData comes from the Bybit batch tickers call in fetchAllMetrics
  const oiUsdCurrent   = derivData?.oiUsdCurrent   ?? null
  const oiChange4h     = derivData?.oiChange4h     ?? null
  const oiChange24h    = derivData?.oiChange24h    ?? null
  const oiAcceleration = derivData?.oiAcceleration ?? null
  const fundingRate    = derivData?.fundingRate    ?? null
  const fundingSettled = false // Bybit ticker rate is predicted, not settled history
  const hoursSinceFunding = null
  const fundingCategory   = derivData?.fundingCategory ?? 'unavailable'

  // Data quality: 2 = price confirmed, 3 = price + derivatives confirmed
  const dataQuality = derivData ? 3 : 2

  // ── Taker buy ratio proxy (null-safe) ─────────────────────
  const r1h = return1h ?? 0
  const takerBuyRatio = r1h > 0
    ? Math.min(0.5 + (r1h / 20), 0.75)
    : Math.max(0.5 - (Math.abs(r1h) / 20), 0.25)

  // ── Volatility compression — unavailable without OHLC ─────
  const volCompression = null

  // ── Token unlock ──────────────────────────────────────────
  const unlockOverhang = getUnlockOverhang(symbol)

  // ── Risk flags ────────────────────────────────────────────
  const risks = []
  if ((volumeShock || 0) > 5)                                           risks.push('extreme_volume_spike')
  if (return24h > 35)                                                    risks.push('extended_price')
  if (relStrengthBtc !== null && Math.abs(relStrengthBtc) < 1)          risks.push('btc_dependent')
  if (unlockOverhang.hasOverhang)                                        risks.push(`unlock_overhang_${unlockOverhang.daysToUnlock}d`)
  if (!derivData)                                                        risks.push('no_oi_funding_data')
  if (fundingCategory === 'overheated')                                  risks.push('overheated_funding')

  return {
    symbol,
    dataQuality,
    unavailable: false,
    price:    +currentPrice.toFixed(8),
    return1h:  return1h !== null ? +return1h.toFixed(3) : null,
    return4h:  null,
    return12h: null,
    return24h: return24h !== null ? +return24h.toFixed(3) : null,
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
// Data source: CoinGecko only (confirmed working from AWS/Netlify).
// Bybit/Binance/OKX all geo-block AWS US infrastructure via CloudFront.
// Derivatives (OI/funding) are unavailable from cloud-safe free sources.
// Signal engine handles this gracefully: score penalty applied, confidence reduced,
// dataCompleteness shows 'Momentum Only', but signals are not blocked.

async function fetchAllMetrics() {
  console.log('[marketData] Starting CoinGecko fetch for', COIN_UNIVERSE.length, 'coins')

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

  console.log(`[marketData] CoinGecko markets: ${marketsData.length} coins`)

  const marketIndex = {}
  for (const row of marketsData) marketIndex[row.id] = row

  const btcRow = marketIndex['bitcoin']
  const ethRow = marketIndex['ethereum']
  const btcReturn24h = btcRow?.price_change_percentage_24h_in_currency ?? btcRow?.price_change_percentage_24h ?? null
  const ethReturn24h = ethRow?.price_change_percentage_24h_in_currency ?? ethRow?.price_change_percentage_24h ?? null

  console.log('[marketData] BTC 24h:', btcReturn24h !== null ? `${btcReturn24h?.toFixed(2)}%` : 'FAILED')

  const metrics = []
  let successCount = 0
  let failCount    = 0

  for (const symbol of COIN_UNIVERSE) {
    const cgId      = SYMBOL_TO_CG_ID[symbol]
    const marketRow = marketIndex[cgId] || null

    // derivData = null: no derivatives available from cloud-safe free sources
    const m = computeCoinMetrics(symbol, marketRow, null, btcReturn24h, ethReturn24h, null)

    if (m.unavailable) {
      failCount++
    } else {
      successCount++
      if (successCount === 1) {
        console.log(`[marketData] First: ${symbol} price=${m.price} dq=${m.dataQuality}`)
      }
    }
    metrics.push(m)
  }

  console.log(`[marketData] Done: ${successCount} success, ${failCount} failed / ${COIN_UNIVERSE.length}`)

  return {
    metrics,
    btcReturn24h,
    ethReturn24h,
    diagnostics: { successCount, failCount, total: COIN_UNIVERSE.length, provider: 'coingecko' }
  }
}

module.exports = { fetchAllMetrics, COIN_UNIVERSE }
