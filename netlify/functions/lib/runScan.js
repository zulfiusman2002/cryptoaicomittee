// netlify/functions/lib/runScan.js
// The full scan pipeline, extracted so BOTH entry points run identical logic:
//   - scan-market.js   (HTTP, user presses the button; waitForWrites=false for speed)
//   - scheduled-scan.js (cron every 4h; waitForWrites=true — Lambda freezes on return,
//                        so fire-and-forget writes would be silently killed)

const db = require('./db')
const { fetchAllMetrics } = require('./marketData')
const { scoreAndRank }    = require('./signals')
const { runGptAnalysis, runClaudeChallenge, combineFinalVerdict } = require('./aiAnalysis')
const { evaluateOpenTrades, openTradesFromSignals, computeStats, computePortfolio } = require('./paperTrading')

async function runScan({ waitForWrites = false, source = 'manual' } = {}) {
  // ── Create scan record ──────────────────────────────────────
  let scanRecord = null
  try {
    scanRecord = await db.createScan({ status: 'running', universe_count: 20 })
  } catch (err) {
    console.error(`[scan:${source}] Failed to create scan record:`, err.message)
  }
  const scanId = scanRecord?.id || null

  // ── Step 1: market data first, then evaluate open trades with a live
  // price map so expired trades whose path fetch fails still close at
  // the real current price (never a fabricated 0% at entry).
  const marketResult = await fetchAllMetrics()
  const { metrics: allMetrics, diagnostics } = marketResult

  const currentPrices = {}
  for (const m of allMetrics) {
    if (!m.unavailable && m.price) currentPrices[m.symbol] = m.price
  }

  const paperEval = await evaluateOpenTrades(db, undefined, currentPrices).catch(e => {
    console.error(`[scan:${source}] Paper eval failed:`, e.message)
    return { evaluated: 0, closed: 0, pending: [] }
  })
  console.log(`[scan:${source}] Paper: ${paperEval.evaluated} evaluated, ${paperEval.closed} closed, pending: ${paperEval.pending?.length || 0}. Data:`, JSON.stringify(diagnostics))

  if (diagnostics.successCount === 0) {
    const errMsg = `Market data fetch failed: 0/${diagnostics.total} coins. Provider: ${diagnostics.provider}. Check function logs.`
    if (scanId) { try { await db.updateScan(scanId, { status: 'error' }) } catch {} }
    return { ok: false, statusCode: 502, error: errMsg, diagnostics, scanId }
  }

  // ── Step 2: deterministic scoring ───────────────────────────
  const { allScored, top5 } = scoreAndRank(allMetrics)

  // ── Step 3: store coin metrics ──────────────────────────────
  let metricsWrite = Promise.resolve()
  if (scanId) {
    const metricsToInsert = allScored.map(m => ({
      symbol: m.symbol, price: m.price,
      return_1h: m.return1h, return_4h: m.return4h,
      return_12h: m.return12h, return_24h: m.return24h,
      volume_shock: m.volumeShock,
      oi_change_4h: m.oiChange4h, oi_change_24h: m.oiChange24h,
      oi_usd_current: m.oiUsdCurrent,
      funding_rate: m.fundingRate, funding_settled: m.fundingSettled,
      hours_since_funding: m.hoursSinceFunding,
      relative_strength_btc: m.relStrengthBtc,
      relative_strength_eth: m.relStrengthEth,
      taker_buy_ratio: m.takerBuyRatio,
      data_quality_flag: m.dataQuality,
      raw_metrics: m.raw || {}
    }))
    metricsWrite = db.insertCoinMetrics(scanId, metricsToInsert).catch(e =>
      console.error(`[scan:${source}] Metrics insert failed:`, e.message))
    if (waitForWrites) await metricsWrite
  }

  // ── Step 4: AI on top candidates ────────────────────────────
  const openaiKey    = process.env.OPENAI_API_KEY
  const anthropicKey = process.env.ANTHROPIC_API_KEY

  const gptResults = await Promise.all(
    top5.map(c => openaiKey
      ? runGptAnalysis(c, c.signal, openaiKey).catch(e => { console.error(`[GPT] ${c.symbol}:`, e.message); return null })
      : Promise.resolve(null))
  )
  const claudeResults = await Promise.all(
    top5.map((c, i) => (anthropicKey && gptResults[i])
      ? runClaudeChallenge(c, c.signal, gptResults[i], anthropicKey).catch(e => { console.error(`[Claude] ${c.symbol}:`, e.message); return null })
      : Promise.resolve(null))
  )
  console.log(`[scan:${source}] AI done. GPT ${gptResults.filter(Boolean).length}/${top5.length}, Claude ${claudeResults.filter(Boolean).length}/${top5.length}`)

  const signalResults = top5.map((candidate, i) => {
    const gptAnalysis     = gptResults[i]
    const claudeChallenge = claudeResults[i]
    const combined = combineFinalVerdict(candidate.signal.verdict, gptAnalysis, claudeChallenge)
    return {
      symbol: candidate.symbol,
      verdict: combined.verdict,
      risk_label: claudeChallenge?.final_risk_label || candidate.signal.risk,
      entry_low: candidate.signal.levels.entryLow,
      entry_high: candidate.signal.levels.entryHigh,
      stop_loss: candidate.signal.levels.stopLoss,
      take_profit_1: candidate.signal.levels.tp1,
      take_profit_2: candidate.signal.levels.tp2,
      invalidation_condition: candidate.signal.levels.invalidation,
      levelsLabel: candidate.signal.levels.levelsLabel,
      gpt_analysis: gptAnalysis,
      claude_challenge: claudeChallenge,
      final_summary: combined.summary,
      deterministic_score: candidate.signal.score,
      was_downgraded: combined.downgraded,
      dataCompleteness: candidate.signal.dataCompleteness,
      price: candidate.price,
      return1h: candidate.return1h, return4h: candidate.return4h,
      return12h: candidate.return12h, return24h: candidate.return24h,
      volumeShock: candidate.volumeShock,
      fundingCategory: candidate.fundingCategory,
      relStrengthBtc: candidate.relStrengthBtc,
      dataQuality: candidate.dataQuality,
      risks: candidate.risks
    }
  })

  // ── Step 5: full table ──────────────────────────────────────
  const fullTable = allScored.map(m => ({
    symbol: m.symbol, price: m.price,
    return1h: m.return1h, return4h: m.return4h,
    return12h: m.return12h, return24h: m.return24h,
    volumeShock: m.volumeShock,
    oiChange4h: m.oiChange4h, oiChange24h: m.oiChange24h,
    fundingRate: m.fundingRate, fundingCategory: m.fundingCategory,
    relStrengthBtc: m.relStrengthBtc, relStrengthEth: m.relStrengthEth,
    verdict: m.signal.verdict, score: m.signal.score, risk: m.signal.risk,
    dataQuality: m.dataQuality, risks: m.risks
  }))

  // ── Step 6: paper trading — open new trades, gather portfolio ─
  let paperTrading = { openTrades: [], closedTrades: [], stats: computeStats(null), portfolio: computePortfolio([]), tradesOpenedThisScan: 0 }
  try {
    const opened = await openTradesFromSignals(db, scanId, signalResults)
    const [openTrades, closedTrades, rawStats, allTrades] = await Promise.all([
      db.getOpenPaperTrades(),
      db.getClosedPaperTrades(30),
      db.getPaperTradeStats(),
      db.getAllPaperTrades()
    ])
    paperTrading = {
      openTrades, closedTrades,
      stats: computeStats(rawStats),
      portfolio: computePortfolio(allTrades),
      tradesOpenedThisScan: opened,
      evaluatedThisScan: paperEval.evaluated,
      closedThisScan: paperEval.closed
    }
  } catch (e) {
    console.error(`[scan:${source}] Paper trading step failed:`, e.message)
  }

  // ── Step 7: persist signal results + finalise scan record ────
  const finalWrites = scanId
    ? Promise.all(
        signalResults.map(r => db.insertSignalResult(scanId, r).catch(e =>
          console.error(`[scan:${source}] Signal insert failed ${r.symbol}:`, e.message)))
      ).then(() =>
        db.updateScan(scanId, {
          status: 'complete',
          top_signal: signalResults[0]?.symbol || null,
          summary: {
            top5: signalResults.map(r => ({ symbol: r.symbol, verdict: r.verdict })),
            totalScanned: allScored.length,
            source,
            timestamp: new Date().toISOString()
          }
        }).catch(e => console.error(`[scan:${source}] Scan update failed:`, e.message))
      )
    : Promise.resolve()

  if (waitForWrites) {
    await finalWrites
    await metricsWrite
  }

  return {
    ok: true,
    statusCode: 200,
    payload: {
      scanId,
      timestamp: new Date().toISOString(),
      topSignals: signalResults,
      fullTable,
      paperTrading,
      meta: {
        totalScanned: allScored.length,
        aiAvailable: !!openaiKey && !!anthropicKey,
        gptAvailable: !!openaiKey,
        claudeAvailable: !!anthropicKey,
        diagnostics,
        source
      }
    }
  }
}

module.exports = { runScan }
