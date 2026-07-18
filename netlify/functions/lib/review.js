// netlify/functions/lib/review.js
// Claude as weekly performance analyst: reads the full trade log,
// returns a structured review. Human reads it; nothing auto-changes.

const db = require('./db')
const { honestStats, outcomeBreakdown, concentration, isArtifact } = require('./analytics')

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'

async function generateReview() {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { ok: false, error: 'ANTHROPIC_API_KEY not set' }

  const allTrades = await db.getAllPaperTrades()
  const closed = allTrades.filter(t => t.status !== 'open' && !isArtifact(t))
  if (closed.length < 5) {
    return { ok: false, error: `Only ${closed.length} real closed trades — review needs at least 5.` }
  }

  const stats = honestStats(allTrades)
  const outcomes = outcomeBreakdown(allTrades)
  const conc = concentration(allTrades)

  const tradeLines = closed.map(t =>
    `${t.symbol} | opened ${t.opened_at?.slice(0, 16)} | ${t.status} | pnl ${t.pnl_pct}% | mfe ${t.mfe_pct ?? 'n/a'}% | mae ${t.mae_pct ?? 'n/a'}%`
  ).join('\n')

  const prompt = `You are the weekly performance review analyst for a crypto paper-trading system (momentum signals, 24h horizon, long-only).

STATS: n=${stats.n}, expectancy ${stats.mean}%/trade, t-stat ${stats.tStat}, 95% CI [${stats.ci95?.join(', ')}]
OUTCOMES: ${outcomes.tp1_hit} TP hits, ${outcomes.stopped} stops, ${outcomes.expired} expired (${outcomes.barrierPct}% barrier-resolved)
CONCENTRATION: top trade = ${conc.topTradePct}% of gains (${conc.bestTrade?.symbol})

TRADE LOG:
${tradeLines}

Write an honest weekly review. Do not flatter. Ground every claim in the trades above. Return ONLY JSON:
{"summary":"3 sentences max — the honest state of the strategy","loss_patterns":"what the losing trades have in common (be specific: coins, entry conditions, timing)","win_patterns":"what the winning trades have in common","hypothesis_to_test":"ONE specific, falsifiable parameter change worth testing in shadow (not live)","risk_warnings":["array of 1-3 specific risks visible in this data"]}`

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        temperature: 0,
        system: 'You are a rigorous quantitative performance analyst. Return only valid JSON. Never invent numbers not present in the data.',
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: AbortSignal.timeout(20000)
    })
    if (!res.ok) {
      const err = (await res.text()).slice(0, 200)
      console.error('[review] Claude HTTP', res.status, err)
      return { ok: false, error: `Claude HTTP ${res.status}` }
    }
    const data = await res.json()
    const content = data.content?.[0]?.text
    if (!content) return { ok: false, error: 'Empty Claude response' }
    const review = JSON.parse(content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim())
    await db.saveWeeklyReview(closed.length, review)
    console.log('[review] Saved weekly review over', closed.length, 'trades')
    return { ok: true, review, tradesAnalyzed: closed.length }
  } catch (e) {
    console.error('[review] failed:', e.message)
    return { ok: false, error: e.message }
  }
}

module.exports = { generateReview }
