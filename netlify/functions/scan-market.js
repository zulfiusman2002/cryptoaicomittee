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
        `Provider: ${diagnostics.provider}. ` +
        `Check Netlify function logs for the exact HTTP status from CoinGecko.`
      console.error('[scan]', errMsg)
      if (scanId) {
        try { await db.updateScan(scanId, { status: 'error' }) } catch {}
      }
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: errMsg, diagnostics, scanId })
      }
    }

    // ── Step 2: Deterministic scoring ──────────────────────
    console.log('[scan] Scoring signals...')
    const { allScored, top5 } = scoreAndRank(allMetrics)

    // ── Step 3: Store all coin metrics (fire-and-forget — don't block AI) ─
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
      // Don't await — let AI calls start immediately
      db.insertCoinMetrics(scanId, metricsToInsert).catch(e =>
        console.error('[scan] Coin metrics insert failed:', e.message)
      )
    }

    // ── Step 4: AI analysis on top 5 only ──────────────────
    const openaiKey    = process.env.OPENAI_API_KEY
    const anthropicKey = process.env.ANTHROPIC_API_KEY

    console.log(`[scan] Running AI on ${top5.length} candidates. GPT: ${!!openaiKey}, Claude: ${!!anthropicKey}`)

    // Run all GPT calls in parallel (not sequential) to stay within timeout
    const gptResults = await Promise.all(
      top5.map(candidate =>
        openaiKey
          ? runGptAnalysis(candidate, candidate.signal, openaiKey).catch(e => {
              console.error(`[scan] GPT failed for ${candidate.symbol}:`, e.message)
              return null
            })
          : Promise.resolve(null)
      )
    )
    console.log(`[scan] GPT done. Results: ${gptResults.filter(Boolean).length}/${top5.length}`)

    // Run all Claude calls in parallel
    const claudeResults = await Promise.all(
      top5.map((candidate, i) => {
        const gptAnalysis = gptResults[i]
        return (anthropicKey && gptAnalysis)
          ? runClaudeChallenge(candidate, candidate.signal, gptAnalysis, anthropicKey).catch(e => {
              console.error(`[scan] Claude failed for ${candidate.symbol}:`, e.message)
              return null
            })
          : Promise.resolve(null)
      })
    )
    console.log(`[scan] Claude done. Results: ${claudeResults.filter(Boolean).length}/${top5.length}`)

    const signalResults = []

    for (let i = 0; i < top5.length; i++) {
      const candidate       = top5[i]
      const gptAnalysis     = gptResults[i]
      const claudeChallenge = claudeResults[i]

      const combined = combineFinalVerdict(
        candidate.signal.verdict, gptAnalysis, claudeChallenge
      )

      signalResults.push({
        symbol:             candidate.symbol,
        verdict:            combined.verdict,
        risk_label:         claudeChallenge?.final_risk_label || candidate.signal.risk,
        entry_low:          candidate.signal.levels.entryLow,
        entry_high:         candidate.signal.levels.entryHigh,
        stop_loss:          candidate.signal.levels.stopLoss,
        take_profit_1:      candidate.signal.levels.tp1,
        take_profit_2:      candidate.signal.levels.tp2,
        invalidation_condition: candidate.signal.levels.invalidation,
        levelsLabel:        candidate.signal.levels.levelsLabel,
        gpt_analysis:       gptAnalysis,
        claude_challenge:   claudeChallenge,
        final_summary:      combined.summary,
        deterministic_score: candidate.signal.score,
        was_downgraded:      combined.downgraded,
        dataCompleteness:   candidate.signal.dataCompleteness,
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
      })
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

    // ── Return to frontend IMMEDIATELY — DB writes happen after ─
    // This ensures the user gets results even if DB writes are slow/fail
    const responseBody = JSON.stringify({
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

    // ── DB writes in parallel after response is ready ───────
    if (scanId) {
      // Fire and forget — don't await, don't block the response
      Promise.all(
        signalResults.map(r => db.insertSignalResult(scanId, r).catch(e =>
          console.error('[scan] DB insert failed for', r.symbol, e.message)
        ))
      ).then(() =>
        db.updateScan(scanId, {
          status:     'complete',
          top_signal: signalResults[0]?.symbol || null,
          summary: {
            top5:         signalResults.map(r => ({ symbol: r.symbol, verdict: r.verdict })),
            totalScanned: allScored.length,
            timestamp:    new Date().toISOString()
          }
        }).catch(e => console.error('[scan] DB update failed:', e.message))
      )
    }

    return { statusCode: 200, headers, body: responseBody }

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
