// netlify/functions/scan-market.js
// ONLY CHANGE vs previous version: Supabase replaced with db.js (Turso).
// All other logic — market data, scoring, AI — is untouched.

const db = require('./lib/db')
const { fetchAllMetrics } = require('./lib/marketData')
const { scoreAndRank }    = require('./lib/signals')
const { runGptAnalysis, runClaudeChallenge, combineFinalVerdict } = require('./lib/aiAnalysis')

const headers = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json'
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' }
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) }

  // ── Create scan record ──────────────────────────────────────
  let scanRecord = null
  try {
    scanRecord = await db.createScan({ status: 'running', universe_count: 20 })
  } catch (err) {
    console.error('[scan] Failed to create scan record:', err)
    // Continue — return results to frontend even if DB fails
  }
  const scanId = scanRecord?.id || null

  try {
    // ── Step 1: Fetch market data ───────────────────────────
    console.log('[scan] Fetching market data...')
    const { metrics: allMetrics, diagnostics } = await fetchAllMetrics()

    console.log('[scan] Market data diagnostics:', JSON.stringify(diagnostics))

    // Surface hard failure instead of silently returning 0 coins
    if (diagnostics.successCount === 0) {
      const errMsg = `Market data fetch failed: 0/${diagnostics.total} coins returned data. ` +
        `Spot base used: ${diagnostics.spotBase}. ` +
        `Binance may be geo-blocked from this Netlify deployment region. ` +
        `Check function logs for HTTP status codes.`
      console.error('[scan]', errMsg)
      if (scanId) {
        try { await db.updateScan(scanId, { status: 'error' }) } catch {}
      }
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          error: errMsg,
          diagnostics,
          scanId
        })
      }
    }

    // ── Step 2: Deterministic scoring ──────────────────────
    console.log('[scan] Scoring signals...')
    const { allScored, top5 } = scoreAndRank(allMetrics)

    // ── Step 3: Store all coin metrics ─────────────────────
    if (scanId) {
      const metricsToInsert = allScored.map(m => ({
        symbol:               m.symbol,
        price:                m.price,
        return_1h:            m.return1h,
        return_4h:            m.return4h,
        return_12h:           m.return12h,
        return_24h:           m.return24h,
        volume_shock:         m.volumeShock,
        oi_change_4h:         m.oiChange4h,
        oi_change_24h:        m.oiChange24h,
        oi_usd_current:       m.oiUsdCurrent,
        funding_rate:         m.fundingRate,
        funding_settled:      m.fundingSettled,
        hours_since_funding:  m.hoursSinceFunding,
        relative_strength_btc: m.relStrengthBtc,
        relative_strength_eth: m.relStrengthEth,
        taker_buy_ratio:       m.takerBuyRatio,
        data_quality_flag:     m.dataQuality,
        raw_metrics:           m.raw || {}
      }))
      await db.insertCoinMetrics(scanId, metricsToInsert)
    }

    // ── Step 4: AI analysis on top 5 only ──────────────────
    const openaiKey    = process.env.OPENAI_API_KEY
    const anthropicKey = process.env.ANTHROPIC_API_KEY

    const signalResults = []

    for (const candidate of top5) {
      console.log(`[scan] Analysing ${candidate.symbol}...`)

      const gptAnalysis = openaiKey
        ? await runGptAnalysis(candidate, candidate.signal, openaiKey)
        : null

      const claudeChallenge = (anthropicKey && gptAnalysis)
        ? await runClaudeChallenge(candidate, candidate.signal, gptAnalysis, anthropicKey)
        : null

      const combined = combineFinalVerdict(
        candidate.signal.verdict, gptAnalysis, claudeChallenge
      )

      const result = {
        symbol:             candidate.symbol,
        verdict:            combined.verdict,
        risk_label:         claudeChallenge?.final_risk_label || candidate.signal.risk,
        entry_low:          candidate.signal.levels.entryLow,
        entry_high:         candidate.signal.levels.entryHigh,
        stop_loss:          candidate.signal.levels.stopLoss,
        take_profit_1:      candidate.signal.levels.tp1,
        take_profit_2:      candidate.signal.levels.tp2,
        invalidation_condition: candidate.signal.levels.invalidation,
        gpt_analysis:       gptAnalysis,
        claude_challenge:   claudeChallenge,
        final_summary:      combined.summary,
        deterministic_score: candidate.signal.score,
        was_downgraded:      combined.downgraded,
        // Display fields
        price:              candidate.price,
        return1h:           candidate.return1h,
        return4h:           candidate.return4h,
        return12h:          candidate.return12h,
        return24h:          candidate.return24h,
        volumeShock:        candidate.volumeShock,
        fundingCategory:    candidate.fundingCategory,
        relStrengthBtc:     candidate.relStrengthBtc,
        dataQuality:        candidate.dataQuality,
        risks:              candidate.risks
      }

      signalResults.push(result)

      if (scanId) {
        await db.insertSignalResult(scanId, result)
      }
    }

    // ── Step 5: Full table data ─────────────────────────────
    const fullTable = allScored.map(m => ({
      symbol:          m.symbol,
      price:           m.price,
      return1h:        m.return1h,
      return4h:        m.return4h,
      return12h:       m.return12h,
      return24h:       m.return24h,
      volumeShock:     m.volumeShock,
      oiChange4h:      m.oiChange4h,
      oiChange24h:     m.oiChange24h,
      fundingRate:     m.fundingRate,
      fundingCategory: m.fundingCategory,
      relStrengthBtc:  m.relStrengthBtc,
      relStrengthEth:  m.relStrengthEth,
      verdict:         m.signal.verdict,
      score:           m.signal.score,
      risk:            m.signal.risk,
      dataQuality:     m.dataQuality,
      risks:           m.risks
    }))

    // ── Update scan status ──────────────────────────────────
    if (scanId) {
      await db.updateScan(scanId, {
        status:     'complete',
        top_signal: signalResults[0]?.symbol || null,
        summary: {
          top5:          signalResults.map(r => ({ symbol: r.symbol, verdict: r.verdict })),
          totalScanned:  allScored.length,
          timestamp:     new Date().toISOString()
        }
      })
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        scanId,
        timestamp:    new Date().toISOString(),
        topSignals:   signalResults,
        fullTable,
        meta: {
          totalScanned:    allScored.length,
          aiAvailable:     !!openaiKey && !!anthropicKey,
          gptAvailable:    !!openaiKey,
          claudeAvailable: !!anthropicKey,
          diagnostics
        }
      })
    }

  } catch (err) {
    console.error('[scan] Fatal error:', err)
    if (scanId) {
      try { await db.updateScan(scanId, { status: 'error' }) } catch {}
    }
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    }
  }
}
