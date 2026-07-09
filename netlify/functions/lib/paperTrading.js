// netlify/functions/lib/paperTrading.js
// Paper trading engine — the live validation loop.
//
// On every scan:
//   1. Evaluate all open trades against the ACTUAL price path since entry
//      (CoinGecko market_chart, 5-min granularity for <24h, hourly for older)
//   2. Close trades that hit stop / TP1 / 24h horizon
//   3. Open new paper trades for this scan's BUY signals (one open trade per symbol max)
//
// Rules (locked, from Stage 1 spec):
//   - Entry = scan price + 10bps friction (conservative entry assumption)
//   - Walk price path chronologically: first event wins (stop vs TP1)
//   - Full position closes at TP1 (R:R 1.5) — no partial fills in MVP
//   - 24h horizon: if neither stop nor TP1 hit, close at last price, status 'expired'
//   - MFE/MAE tracked along the full path regardless of outcome

const CG = 'https://api.coingecko.com/api/v3'

const SYMBOL_TO_CG_ID = {
  'BTCUSDT':  'bitcoin',      'ETHUSDT':  'ethereum',   'SOLUSDT':  'solana',
  'BNBUSDT':  'binancecoin',  'XRPUSDT':  'ripple',     'ADAUSDT':  'cardano',
  'DOGEUSDT': 'dogecoin',     'AVAXUSDT': 'avalanche-2','LINKUSDT': 'chainlink',
  'NEARUSDT': 'near',         'INJUSDT':  'injective-protocol',
  'FETUSDT':  'fetch-ai',     'RNDRUSDT': 'render-token','ARBUSDT': 'arbitrum',
  'OPUSDT':   'optimism',     'SUIUSDT':  'sui',        'APTUSDT':  'aptos',
  'PEPEUSDT': 'pepe',         'WIFUSDT':  'dogwifcoin', 'SEIUSDT':  'sei-network',
}

const HORIZON_MS      = 24 * 3600 * 1000  // 24h trade horizon
const ENTRY_FRICTION  = 0.001             // 10bps worse entry

// ── Price path fetcher (injectable for testing) ───────────────
async function fetchPricePath(symbol, sinceMs) {
  const cgId = SYMBOL_TO_CG_ID[symbol]
  if (!cgId) return null
  const ageMs = Date.now() - sinceMs
  const days = ageMs <= 24 * 3600 * 1000 ? 1 : 2
  const url = `${CG}/coins/${cgId}/market_chart?vs_currency=usd&days=${days}`
  const headers = { 'Accept': 'application/json', 'User-Agent': 'CSIE/1.0' }
  if (process.env.COINGECKO_API_KEY) {
    headers['x-cg-demo-api-key'] = process.env.COINGECKO_API_KEY
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) })
      if (res.ok) {
        const json = await res.json()
        if (!Array.isArray(json.prices)) return null
        return json.prices.filter(p => p[0] >= sinceMs)
      }
      if (res.status === 429 && attempt < 3) {
        const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10)
        const waitMs = retryAfter > 0 ? Math.min(retryAfter * 1000, 8000) : Math.pow(3, attempt) * 200
        console.warn(`[paper] 429 for ${symbol}, backing off ${waitMs}ms (attempt ${attempt}/3)`)
        await new Promise(r => setTimeout(r, waitMs))
        continue
      }
      console.error(`[paper] price path HTTP ${res.status} for ${symbol}`)
      return null
    } catch (e) {
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 500 * attempt))
        continue
      }
      console.error(`[paper] price path failed for ${symbol}:`, e.message)
      return null
    }
  }
  return null
}

// ── Core evaluation: walk the price path ──────────────────────
// Pure function — fully unit-testable.
// Returns null if trade stays open, or a close result.
function evaluatePath(trade, pricePath, nowMs = Date.now()) {
  const entry  = trade.entry_price
  const stop   = trade.stop_loss
  const tp1    = trade.tp1
  const opened = new Date(trade.opened_at).getTime()
  const expired = (nowMs - opened) >= HORIZON_MS

  let mfe = 0   // max favourable excursion %
  let mae = 0   // max adverse excursion % (negative)
  let lastPrice = null

  if (Array.isArray(pricePath)) {
    for (const [, price] of pricePath) {
      lastPrice = price
      const excursion = (price - entry) / entry * 100
      if (excursion > mfe) mfe = excursion
      if (excursion < mae) mae = excursion

      // First event wins — chronological walk
      if (stop !== null && stop !== undefined && price <= stop) {
        return {
          status: 'stopped', exit_price: stop,
          pnl_pct: +(((stop - entry) / entry) * 100).toFixed(3),
          mfe_pct: +mfe.toFixed(3), mae_pct: +mae.toFixed(3)
        }
      }
      if (tp1 !== null && tp1 !== undefined && price >= tp1) {
        return {
          status: 'tp1_hit', exit_price: tp1,
          pnl_pct: +(((tp1 - entry) / entry) * 100).toFixed(3),
          mfe_pct: +mfe.toFixed(3), mae_pct: +mae.toFixed(3)
        }
      }
    }
  }

  if (expired) {
    // No price data at all → do NOT fabricate a 0% close at entry.
    // Mark pending; caller closes it with the scan's live market price,
    // or leaves it open to retry next scan (4h later).
    if (lastPrice === null) {
      return { status: 'expired_pending' }
    }
    return {
      status: 'expired', exit_price: lastPrice,
      pnl_pct: +(((lastPrice - entry) / entry) * 100).toFixed(3),
      mfe_pct: +mfe.toFixed(3), mae_pct: +mae.toFixed(3)
    }
  }

  // Still open — return running excursions + last known price for unrealized P&L
  return { status: 'open', mfe_pct: +mfe.toFixed(3), mae_pct: +mae.toFixed(3),
           last_price: lastPrice }
}

// Hard cap: a trade stuck without data for this long closes at entry,
// flagged 'expired_nodata' (excluded from statistics — it is an artifact, not a trade).
const NODATA_CAP_MS = 72 * 3600 * 1000

// Tiny concurrency limiter — CoinGecko 429s parallel bursts.
// Runs tasks with at most `limit` in flight, small gap between starts.
async function throttledMap(items, limit, gapMs, fn) {
  const results = new Array(items.length)
  let i = 0
  async function worker() {
    while (i < items.length) {
      const idx = i++
      results[idx] = await fn(items[idx])
      if (i < items.length && gapMs) await new Promise(r => setTimeout(r, gapMs))
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

// ── Evaluate all open trades (called at start of every scan) ──
// currentPrices: optional { SYMBOL: price } map from the scan's market fetch —
// used to close expired trades whose path fetch failed (rate limit etc).
async function evaluateOpenTrades(db, pathFetcher = fetchPricePath, currentPrices = null) {
  const openTrades = await db.getOpenPaperTrades()
  if (!openTrades.length) return { evaluated: 0, closed: 0, pending: [] }

  console.log(`[paper] Evaluating ${openTrades.length} open trades (throttled)...`)

  // Concurrency 2 with 300ms gap — avoids the 429 burst that produced fake-zero closes
  const results = await throttledMap(openTrades, 1, 800, async trade => {
    const openedMs = new Date(trade.opened_at).getTime()
    const path = await pathFetcher(trade.symbol, openedMs)
    const outcome = evaluatePath(trade, path)
    return { trade, outcome }
  })

  let closed = 0
  const pending = []
  for (const { trade, outcome } of results) {
    if (!outcome) continue

    if (outcome.status === 'expired_pending') {
      const entry = Number(trade.entry_price)
      const cur   = currentPrices?.[trade.symbol]
      const ageMs = Date.now() - new Date(trade.opened_at).getTime()

      if (cur) {
        // Close at live market price — real exit, MFE/MAE unknown (null, not fake 0)
        const close = {
          status: 'expired', exit_price: cur,
          pnl_pct: +(((cur - entry) / entry) * 100).toFixed(3),
          mfe_pct: null, mae_pct: null
        }
        await db.closePaperTrade(trade.id, close).catch(e =>
          console.error('[paper] close failed:', e.message))
        closed++
        console.log(`[paper] ${trade.symbol}: expired, closed at market ${cur} pnl=${close.pnl_pct}%`)
      } else if (ageMs >= NODATA_CAP_MS) {
        // 72h without any data — close as artifact, excluded from stats
        await db.closePaperTrade(trade.id, {
          status: 'expired_nodata', exit_price: entry,
          pnl_pct: 0, mfe_pct: null, mae_pct: null
        }).catch(e => console.error('[paper] nodata close failed:', e.message))
        closed++
        console.warn(`[paper] ${trade.symbol}: 72h with no price data — closed as expired_nodata (excluded from stats)`)
      } else {
        pending.push(trade.symbol)
        console.warn(`[paper] ${trade.symbol}: expired but no price data — staying open, retry next scan`)
      }
      continue
    }

    if (outcome.status === 'open') {
      await db.updatePaperTradeExcursions(trade.id, outcome).catch(e =>
        console.error('[paper] excursion update failed:', e.message))
    } else {
      await db.closePaperTrade(trade.id, outcome).catch(e =>
        console.error('[paper] close failed:', e.message))
      closed++
      console.log(`[paper] ${trade.symbol}: ${outcome.status} pnl=${outcome.pnl_pct}%`)
    }
  }

  return { evaluated: openTrades.length, closed, pending }
}

// ── Open new paper trades from scan signals ────────────────────
async function openTradesFromSignals(db, scanId, signalResults) {
  const openTrades = await db.getOpenPaperTrades()
  const openSymbols = new Set(openTrades.map(t => t.symbol))

  let opened = 0
  for (const s of signalResults) {
    // Only BUY verdicts become paper trades; one open trade per symbol
    if (!s.verdict?.includes('BUY')) continue
    if (openSymbols.has(s.symbol)) continue
    if (!s.price) continue

    const entryPrice = +(s.price * (1 + ENTRY_FRICTION)).toFixed(10)

    await db.openPaperTrade({
      scan_id:           scanId,
      symbol:            s.symbol,
      verdict:           s.verdict,
      entry_price:       entryPrice,
      stop_loss:         s.stop_loss ?? null,
      tp1:               s.take_profit_1 ?? null,
      tp2:               s.take_profit_2 ?? null,
      data_completeness: s.dataCompleteness ?? null
    }).catch(e => console.error('[paper] open failed for', s.symbol, e.message))
    opened++
    console.log(`[paper] Opened: ${s.symbol} entry=${entryPrice} stop=${s.stop_loss} tp1=${s.take_profit_1}`)
  }
  return opened
}

// ── Summary stats for the UI ──────────────────────────────────
function computeStats(raw) {
  if (!raw || !raw.total) {
    return { total: 0, wins: 0, losses: 0, winRate: null, avgWin: null,
             avgLoss: null, expectancy: null, cumulativePnl: null,
             note: 'No closed trades yet — statistics require sample size' }
  }
  const total  = Number(raw.total)
  const wins   = Number(raw.wins   || 0)
  const losses = Number(raw.losses || 0)
  const avgWin  = raw.avg_win  !== null ? +Number(raw.avg_win).toFixed(3)  : null
  const avgLoss = raw.avg_loss !== null ? +Number(raw.avg_loss).toFixed(3) : null
  const winRate = total > 0 ? +(wins / total * 100).toFixed(1) : null
  const expectancy = (winRate !== null && avgWin !== null && avgLoss !== null)
    ? +((winRate/100) * avgWin + (1 - winRate/100) * avgLoss).toFixed(3)
    : null
  return {
    total, wins, losses, winRate, avgWin, avgLoss, expectancy,
    cumulativePnl: raw.cumulative_pnl !== null ? +Number(raw.cumulative_pnl).toFixed(2) : null,
    note: total < 30 ? `Sample size ${total} — statistically insufficient, treat as anecdotal` : null
  }
}

// ── £1000 virtual portfolio simulation ────────────────────────
// Rules (fixed, stated in UI):
//   Starting capital: £1000
//   Position size:    £100 fixed notional per trade (10% of starting capital)
//   Realized P&L:     Σ £100 × pnl_pct/100 across closed trades
//   Unrealized P&L:   Σ £100 × (last_price − entry)/entry across open trades
//                     (last_price = most recent evaluation; null → 0 until first eval)
//   Equity:           1000 + realized + unrealized
// Fixed notional (not compounding) keeps every trade's contribution comparable —
// correct for measuring signal quality, which is what this month is for.
const STARTING_CAPITAL = 1000
const NOTIONAL_PER_TRADE = 100

function isDataArtifact(t) {
  // expired_nodata, or the legacy fake-zero fingerprint (physically impossible in crypto)
  if (t.status === 'expired_nodata') return true
  return t.status === 'expired' &&
    Number(t.pnl_pct) === 0 && Number(t.mfe_pct) === 0 && Number(t.mae_pct) === 0
}

function computePortfolio(allTrades) {
  const trades = (Array.isArray(allTrades) ? allTrades : []).filter(t => !isDataArtifact(t))
  const closed = trades.filter(t => t.status !== 'open')
  const open   = trades.filter(t => t.status === 'open')

  let realized = 0
  for (const t of closed) {
    if (t.pnl_pct !== null && t.pnl_pct !== undefined)
      realized += NOTIONAL_PER_TRADE * (Number(t.pnl_pct) / 100)
  }

  let unrealized = 0
  for (const t of open) {
    if (t.last_price !== null && t.last_price !== undefined && t.entry_price) {
      unrealized += NOTIONAL_PER_TRADE * ((Number(t.last_price) - Number(t.entry_price)) / Number(t.entry_price))
    }
  }

  const equity = STARTING_CAPITAL + realized + unrealized
  const returnPct = ((equity - STARTING_CAPITAL) / STARTING_CAPITAL) * 100

  // Track period so a 30-day read has context
  const firstOpen = trades.length
    ? trades.reduce((min, t) => {
        const ts = new Date(t.opened_at).getTime()
        return ts < min ? ts : min
      }, Infinity)
    : null
  const daysRunning = firstOpen && firstOpen !== Infinity
    ? +(((Date.now() - firstOpen) / 86400000)).toFixed(1)
    : 0

  return {
    startingCapital: STARTING_CAPITAL,
    notionalPerTrade: NOTIONAL_PER_TRADE,
    realized:   +realized.toFixed(2),
    unrealized: +unrealized.toFixed(2),
    equity:     +equity.toFixed(2),
    returnPct:  +returnPct.toFixed(2),
    closedCount: closed.length,
    openCount:   open.length,
    daysRunning,
    note: closed.length < 30
      ? `${closed.length} closed trades over ${daysRunning}d — return figure is not yet statistically meaningful`
      : null
  }
}

module.exports = { evaluateOpenTrades, openTradesFromSignals, computeStats, computePortfolio, evaluatePath, fetchPricePath, isDataArtifact }
