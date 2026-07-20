// netlify/functions/lib/aiAnalysis.js
// GPT = primary analyst. Claude = risk challenger.
// Neither invents numbers. Both receive only deterministic metrics.
// Claude can downgrade. Claude cannot upgrade.

const OPENAI_URL   = 'https://api.openai.com/v1/chat/completions'
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'

function buildMetricsSummary(m, signal) {
  // Deliberately concise. AI should not get raw dumps — it gets clean summaries.
  return {
    symbol:          m.symbol,
    price:           m.price,
    return_1h:       `${m.return1h}%`,
    return_4h:       `${m.return4h}%`,
    return_12h:      `${m.return12h}%`,
    return_24h:      `${m.return24h}%`,
    volume_shock:    m.volumeShock ?? 'unavailable',
    oi_change_4h:    m.oiChange4h  !== null ? `${m.oiChange4h}%`  : 'unavailable',
    oi_change_24h:   m.oiChange24h !== null ? `${m.oiChange24h}%` : 'unavailable',
    oi_acceleration: m.oiAcceleration ?? 'unavailable',
    funding_rate:    m.fundingRate  !== null ? m.fundingRate       : 'unavailable',
    funding_category: m.fundingCategory,
    hours_since_funding_settlement: m.hoursSinceFunding ?? 'unknown',
    basis_pct:       m.basisPct ?? 'unavailable',
    taker_buy_ratio: m.takerBuyRatio ?? 'unavailable',
    relative_strength_vs_btc: m.relStrengthBtc ?? 'unavailable',
    relative_strength_vs_eth: m.relStrengthEth ?? 'unavailable',
    higher_highs_forming: m.higherHigh ?? false,
    volatility_compression: m.volCompression ?? 'unavailable',
    data_quality_flag: m.dataQuality,
    token_unlock_overhang: m.unlockOverhang?.hasOverhang
      ? `YES — ${m.unlockOverhang.daysToUnlock} days (${m.unlockOverhang.pct}% supply)`
      : 'none known',
    deterministic_verdict: signal.verdict,
    deterministic_score:   signal.score,
    deterministic_reason:  signal.reason,
    risk_flags: m.risks,
    entry_zone:   signal.levels.entryLow  ? `${signal.levels.entryLow} – ${signal.levels.entryHigh}` : 'N/A',
    stop_loss:    signal.levels.stopLoss  ?? 'N/A',
    take_profit_1: signal.levels.tp1     ?? 'N/A',
    take_profit_2: signal.levels.tp2     ?? 'N/A',
  }
}

// ── GPT: primary analyst ─────────────────────────────────────
async function runGptAnalysis(m, signal, apiKey) {
  const metrics = buildMetricsSummary(m, signal)

  const systemPrompt = `You are a crypto momentum analyst. Analyse short-term market structure only.
Rules: never invent numbers, never say "guaranteed", return ONLY valid JSON.`

  const userPrompt = `Coin: ${m.symbol} | Price: $${m.price} | 24h: ${m.return24h}% | Vol shock: ${m.volumeShock}x | RS/BTC: ${m.relStrengthBtc}% | Verdict: ${signal.verdict} | Score: ${signal.score} | Reasons: ${signal.reason}

Return JSON only:
{"coin":"${m.symbol}","setup_stage":"early|developing|confirmed|late|exhausted","setup_type":"momentum|squeeze|breakout|distribution|no_setup","analyst_view":"2 sentence max assessment","main_reason":"top supporting factor","main_risk":"top risk factor","entry_comment":"entry/stop quality comment","confidence_label":"Low|Medium|High"}`

  try {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt }
        ],
        temperature: 0,
        max_tokens: 250,
        response_format: { type: 'json_object' }
      }),
      signal: AbortSignal.timeout(8000)
    })

    if (!res.ok) {
      const err = await res.text()
      console.error(`[GPT] HTTP ${res.status} for ${m.symbol}:`, err.slice(0, 200))
      return null
    }

    const data = await res.json()
    const content = data.choices?.[0]?.message?.content
    if (!content) { console.error('[GPT] empty content for', m.symbol); return null }
    return JSON.parse(content)
  } catch (e) {
    console.error(`[GPT] ${m.symbol} failed:`, e.message)
    return null
  }
}

// ── Claude: risk challenger ───────────────────────────────────
async function runClaudeChallenge(m, signal, gptAnalysis, apiKey) {
  const userPrompt = `You are a skeptical crypto risk analyst challenging a bullish setup.
Coin: ${m.symbol} | Price: $${m.price} | 24h: ${m.return24h}% | Vol shock: ${m.volumeShock}x | Funding: ${m.fundingCategory} | RS/BTC: ${m.relStrengthBtc}%
GPT view: ${gptAnalysis.analyst_view} | GPT confidence: ${gptAnalysis.confidence_label}
Deterministic verdict: ${signal.verdict} (score: ${signal.score})
Risk flags: ${(m.risks || []).join(', ') || 'none'}

IMPORTANT CONTEXT: derivatives data (OI/funding) is unavailable for ALL coins in this system — a constant limitation, already penalised by the scoring engine and labelled "Momentum Only" to the user. Do NOT set should_downgrade=true solely because derivatives are missing; that adds no coin-specific information. You may still mention it in risk_flags.

Downgrade ONLY for coin-specific red flags such as: 24h move already overextended (>15%), volume shock extreme relative to the move (>8x on <5% gain — manipulation pattern), price at obvious round-number resistance, or GPT confidence clearly unjustified by the numbers shown.

DO NOT downgrade a setup merely for a soft or slightly-negative 1h return when the 24h trend is up — that is a PULLBACK (buying a dip inside an uptrend), which is a high-conviction entry pattern, not a weakness. A negative 1h inside a positive 24h trend is a feature of the best entries, not a red flag.

Return JSON only — no markdown:
{"coin":"${m.symbol}","challenge_summary":"2 sentence max risk assessment","risk_flags":["specific","risks"],"should_downgrade":false,"downgrade_reason":"","final_risk_label":"Low|Medium|High|Extreme"}`

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 250,
        temperature: 0,
        system: 'You are a skeptical crypto risk analyst. Return only valid JSON. Never invent numbers.',
        messages: [{ role: 'user', content: userPrompt }]
      }),
      signal: AbortSignal.timeout(8000)
    })

    if (!res.ok) {
      const err = await res.text()
      console.error(`[Claude] HTTP ${res.status} for ${m.symbol}:`, err.slice(0, 200))
      return null
    }

    const data = await res.json()
    const content = data.content?.[0]?.text
    if (!content) { console.error('[Claude] empty response for', m.symbol); return null }

    const clean = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    return JSON.parse(clean)
  } catch (e) {
    console.error(`[Claude] ${m.symbol} failed:`, e.message)
    return null
  }
}

// ── Final verdict combiner ─────────────────────────────────────
// Rules (immutable — AI cannot override these):
// 1. Metrics are overheated → WAIT or AVOID
// 2. GPT High + Claude Extreme → WAIT
// 3. GPT Medium + Claude Medium → maintain BUY WATCH
// 4. Deterministic WAIT/AVOID → stays WAIT/AVOID
// 5. Claude can downgrade, never upgrade
function combineFinalVerdict(deterministicVerdict, gptAnalysis, claudeChallenge) {
  const DOWNGRADE_MAP = {
    'BUY ON BREAKOUT': 'BUY WATCH',
    'BUY WATCH':       'WAIT',
    'BUY ON PULLBACK': 'WAIT',
    'WAIT':            'AVOID',
    'AVOID':           'AVOID',
  }

  // Hard overrides
  if (deterministicVerdict === 'WAIT' || deterministicVerdict === 'AVOID' ||
      deterministicVerdict === 'SELL/EXIT WARNING') {
    return {
      verdict:  deterministicVerdict,
      summary:  gptAnalysis?.analyst_view || 'Deterministic signal is cautious.',
      downgraded: false
    }
  }

  // If both AIs unavailable, return deterministic
  if (!gptAnalysis && !claudeChallenge) {
    return {
      verdict:  deterministicVerdict,
      summary:  'AI analysis unavailable — deterministic signal only.',
      downgraded: false
    }
  }

  let finalVerdict   = deterministicVerdict
  let wasDowngraded  = false
  let downgradedBy   = ''

  const gptConf   = gptAnalysis?.confidence_label
  const claudeRisk = claudeChallenge?.final_risk_label

  // GPT High + Claude Extreme → downgrade
  if (gptConf === 'High' && claudeRisk === 'Extreme') {
    finalVerdict = DOWNGRADE_MAP[deterministicVerdict] || deterministicVerdict
    wasDowngraded = true
    downgradedBy = 'Claude flagged Extreme risk against High GPT confidence'
  }

  // Claude says downgrade explicitly
  if (!wasDowngraded && claudeChallenge?.should_downgrade) {
    finalVerdict = DOWNGRADE_MAP[deterministicVerdict] || deterministicVerdict
    wasDowngraded = true
    downgradedBy = claudeChallenge.downgrade_reason
  }

  const summary = [
    gptAnalysis?.analyst_view || '',
    claudeChallenge ? `Risk challenge: ${claudeChallenge.challenge_summary}` : '',
    wasDowngraded ? `⬇ Downgraded: ${downgradedBy}` : ''
  ].filter(Boolean).join(' — ')

  return { verdict: finalVerdict, summary, downgraded: wasDowngraded }
}

module.exports = { runGptAnalysis, runClaudeChallenge, combineFinalVerdict }
