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

  const systemPrompt = `You are a crypto momentum analyst specialising in short-term market structure.
You are NOT doing fundamental analysis.
You are NOT providing guaranteed financial advice.
You are analysing short-term market microstructure signals.

CRITICAL RULES:
- Do not invent any numbers not present in the metrics provided.
- Do not contradict the provided metrics.
- Do not say "guaranteed", "certain", or "will".
- Keep output concise and actionable.
- If data_quality_flag is 1, note that signal confidence is reduced.
- If token_unlock_overhang is present, flag it as a structural risk.
- Acknowledge uncertainty clearly.

You must return ONLY valid JSON with exactly these fields:`

  const userPrompt = `Analyse this coin for short-term setup quality.

Metrics:
${JSON.stringify(metrics, null, 2)}

Return JSON only, no markdown, no explanation outside JSON:
{
  "coin": "${m.symbol}",
  "setup_stage": "early | developing | confirmed | late | exhausted",
  "setup_type": "momentum | squeeze | breakout | distribution | no_setup",
  "analyst_view": "2-3 sentence assessment of why this setup is or isn't interesting",
  "main_reason": "single most important factor supporting the deterministic verdict",
  "main_risk": "single most important risk to this setup",
  "entry_comment": "comment on the entry zone and stop loss quality",
  "confidence_label": "Low | Medium | High"
}`

  try {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt }
        ],
        temperature: 0.2,
        max_tokens: 400,
        response_format: { type: 'json_object' }
      }),
      signal: AbortSignal.timeout(15000)
    })

    if (!res.ok) {
      const err = await res.text()
      console.error('[GPT] error:', err)
      return null
    }

    const data = await res.json()
    const content = data.choices?.[0]?.message?.content
    return content ? JSON.parse(content) : null
  } catch (e) {
    console.error('[GPT] exception:', e.message)
    return null
  }
}

// ── Claude: risk challenger ───────────────────────────────────
async function runClaudeChallenge(m, signal, gptAnalysis, apiKey) {
  const metrics = buildMetricsSummary(m, signal)

  const systemPrompt = `You are a skeptical crypto risk analyst. Your job is to challenge the bullish case.
You are the second opinion, not the first. GPT has already analysed this.
Your role is to find what GPT may have missed or understated.

CRITICAL RULES:
- Do not invent any numbers not in the provided metrics.
- Do not upgrade a weak deterministic signal — you can only maintain or downgrade.
- If deterministic_verdict is WAIT or AVOID, you must not suggest it should be BUY anything.
- Be specific about risks. Vague warnings are useless.
- If data_quality_flag is 1, note reduced confidence.
- You must return ONLY valid JSON.`

  const userPrompt = `Challenge this setup. Find the risks GPT may have missed or softened.

Deterministic metrics:
${JSON.stringify(metrics, null, 2)}

GPT's analysis:
${JSON.stringify(gptAnalysis, null, 2)}

Look specifically for:
- fake pump risk (volume spike without sustained follow-through)
- late entry risk (move already extended)
- overheated funding (unsustainable carry cost)
- OI / price divergence
- BTC dependency (will collapse if BTC dumps)
- stop loss quality (too tight for the volatility regime)
- poor risk/reward
- liquidation cascade risk
- token unlock overhang
- data quality limitations

Return JSON only, no markdown:
{
  "coin": "${m.symbol}",
  "challenge_summary": "2-3 sentences identifying the key risk(s) the bullish case is ignoring",
  "risk_flags": ["list", "of", "specific", "risks"],
  "should_downgrade": true or false,
  "downgrade_reason": "reason if should_downgrade is true, empty string if false",
  "final_risk_label": "Low | Medium | High | Extreme"
}`

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        messages: [
          { role: 'user', content: systemPrompt + '\n\n' + userPrompt }
        ]
      }),
      signal: AbortSignal.timeout(15000)
    })

    if (!res.ok) {
      const err = await res.text()
      console.error('[Claude] error:', err)
      return null
    }

    const data = await res.json()
    const content = data.content?.[0]?.text
    if (!content) return null

    // Strip any accidental markdown fences
    const clean = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    return JSON.parse(clean)
  } catch (e) {
    console.error('[Claude] exception:', e.message)
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
