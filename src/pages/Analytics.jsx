// src/pages/Analytics.jsx
// The honest performance view. Every section: plain-English verdict first, numbers second.
import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'

const mono = { fontFamily: 'var(--mono)' }

function Card({ title, children, accent }) {
  return (
    <div style={{
      background: 'var(--bg-card)', border: '1px solid var(--border)',
      borderLeft: accent ? `3px solid ${accent}` : '1px solid var(--border)',
      borderRadius: '3px', padding: '1.25rem', marginBottom: '1.25rem'
    }}>
      <div className="section-label" style={{ marginBottom: '0.75rem' }}>{title}</div>
      {children}
    </div>
  )
}

function Verdict({ text, tone = 'neutral' }) {
  const colors = { good: 'var(--green)', bad: 'var(--red)', warn: 'var(--amber)', neutral: 'var(--text)' }
  return (
    <div style={{ ...mono, fontSize: '0.85rem', color: colors[tone], lineHeight: 1.6, marginBottom: '0.75rem' }}>
      {text}
    </div>
  )
}

function fmtPct(n, sign = true) {
  if (n === null || n === undefined) return '—'
  return (sign && +n > 0 ? '+' : '') + (+n).toFixed(2) + '%'
}

// Hand-rolled SVG equity curve — no chart library needed
function EquityChart({ points }) {
  if (!points || points.length < 2) {
    return <div className="empty-state">Not enough closed trades to draw a curve yet.</div>
  }
  const W = 720, H = 200, PAD = 30
  const equities = points.map(p => p.equity)
  const min = Math.min(...equities, 1000) - 5
  const max = Math.max(...equities, 1000) + 5
  const x = i => PAD + (i / (points.length - 1)) * (W - 2 * PAD)
  const y = v => H - PAD - ((v - min) / (max - min)) * (H - 2 * PAD)
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join(' ')
  const baseY = y(1000)
  const last = points[points.length - 1].equity
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }}>
      <line x1={PAD} y1={baseY} x2={W - PAD} y2={baseY} stroke="var(--border)" strokeDasharray="4 4" />
      <text x={W - PAD + 2} y={baseY + 3} fill="var(--text-dim)" fontSize="9" fontFamily="var(--mono)">£1000</text>
      <path d={line} fill="none" stroke={last >= 1000 ? 'var(--green)' : 'var(--red)'} strokeWidth="1.5" />
      {points.map((p, i) => (
        <circle key={i} cx={x(i)} cy={y(p.equity)} r="2.5"
          fill={p.pnl === undefined ? 'var(--text-dim)' : p.pnl > 0 ? 'var(--green)' : 'var(--red)'}>
          <title>{p.symbol ? `${p.symbol}: ${p.pnl > 0 ? '+' : ''}${p.pnl}% → £${p.equity}` : `Start £${p.equity}`}</title>
        </circle>
      ))}
      <text x={x(points.length - 1)} y={y(last) - 8} fill="var(--text)" fontSize="10" fontFamily="var(--mono)" textAnchor="end">£{last}</text>
    </svg>
  )
}

export default function Analytics() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [reviewBusy, setReviewBusy] = useState(false)

  const load = () => {
    fetch('/.netlify/functions/get-analytics')
      .then(r => r.json())
      .then(d => d.error ? setError(d.error) : setData(d))
      .catch(e => setError(e.message))
  }
  useEffect(load, [])

  const runReview = async () => {
    setReviewBusy(true)
    try {
      await fetch('/.netlify/functions/generate-review', { method: 'POST' })
      load()
    } finally { setReviewBusy(false) }
  }

  if (error) return <div className="container"><div className="empty-state">Analytics failed: {error}</div></div>
  if (!data) return <div className="container"><div className="empty-state">Computing analytics…</div></div>

  const { stats, equityCurve, outcomes, concentration, shadowBarriers, scoreVsOutcome, regime, benchmark, readiness, weeklyReview } = data
  const statsToneMap = stats.n < 30 ? 'warn' : (stats.tStat >= 2 && stats.mean > 0) ? 'good' : 'bad'

  return (
    <div className="container">
      <header className="header" style={{ marginBottom: '1.5rem' }}>
        <div className="header-title">
          <h1>CSIE <span style={{ color: 'var(--text-dim)' }}>Analytics</span></h1>
          <span className="header-sub">Read-only · computed live from the trade log</span>
        </div>
        <Link to="/" style={{ ...mono, fontSize: '0.7rem', color: 'var(--amber)', textDecoration: 'none', letterSpacing: '0.1em' }}>
          ← BACK TO SCANNER
        </Link>
      </header>

      {/* ── READINESS: the go/no-go panel ── */}
      <Card title="Real-Money Readiness Gates" accent={readiness.ready ? 'var(--green)' : 'var(--red)'}>
        <Verdict text={readiness.summary} tone={readiness.ready ? 'good' : 'bad'} />
        {readiness.gates.map(g => (
          <div key={g.id} style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', padding: '0.4rem 0', borderBottom: '1px solid var(--border)' }}>
            <span style={{ ...mono, fontSize: '0.9rem', color: g.pass ? 'var(--green)' : 'var(--red)', minWidth: '1.5rem' }}>
              {g.pass ? '✓' : '✗'}
            </span>
            <span style={{ ...mono, fontSize: '0.75rem', flex: 1 }}>{g.label}</span>
            <span style={{ ...mono, fontSize: '0.7rem', color: 'var(--text-dim)' }}>{g.detail}</span>
          </div>
        ))}
      </Card>

      {/* ── The honest statistics ── */}
      <Card title="Is There An Edge? (Honest Statistics)" accent="var(--amber)">
        <Verdict text={stats.verdict} tone={statsToneMap} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '1rem' }}>
          {[
            ['Closed trades', stats.n],
            ['Expectancy/trade', fmtPct(stats.mean)],
            ['Std deviation', stats.sd !== null ? stats.sd + '%' : '—'],
            ['t-statistic', stats.tStat ?? '—'],
            ['95% CI', stats.ci95 ? `${stats.ci95[0]}% to ${stats.ci95[1]}%` : '—'],
          ].map(([l, v]) => (
            <div key={l}>
              <div className="metric-label">{l}</div>
              <div className="metric-value" style={{ fontSize: '1rem' }}>{v}</div>
            </div>
          ))}
        </div>
        {stats.ci95 && stats.ci95[0] < 0 && stats.ci95[1] > 0 && (
          <div style={{ ...mono, fontSize: '0.65rem', color: 'var(--amber)', marginTop: '0.75rem' }}>
            ⚠ The confidence interval includes zero — statistically, the true edge could be negative.
          </div>
        )}
      </Card>

      {/* ── Equity curve + benchmark ── */}
      <Card title="Equity Curve vs Doing Nothing">
        <Verdict
          text={benchmark.beatsBtc === null ? 'No benchmark data yet.'
            : benchmark.beatsBtc
              ? `Portfolio ${fmtPct(benchmark.portfolioReturnPct)} vs BTC buy-and-hold ${fmtPct(benchmark.btcReturnPct)} — alpha ${fmtPct(benchmark.alpha)}. The strategy is currently adding value over just holding BTC.`
              : `Portfolio ${fmtPct(benchmark.portfolioReturnPct)} vs BTC buy-and-hold ${fmtPct(benchmark.btcReturnPct)} — alpha ${fmtPct(benchmark.alpha)}. Simply holding BTC would have done better with zero effort.`}
          tone={benchmark.beatsBtc === null ? 'neutral' : benchmark.beatsBtc ? 'good' : 'bad'}
        />
        <EquityChart points={equityCurve} />
      </Card>

      {/* ── Outcome structure ── */}
      <Card title="How Trades Actually End">
        <Verdict text={outcomes.diagnosis || 'No closed trades yet.'} tone={outcomes.barrierPct < 20 ? 'warn' : 'good'} />
        <div style={{ display: 'flex', gap: '2rem' }}>
          {[
            ['TP1 hit', outcomes.tp1_hit, 'var(--green)'],
            ['Stopped', outcomes.stopped, 'var(--red)'],
            ['Expired (24h)', outcomes.expired, 'var(--text-dim)'],
          ].map(([l, v, c]) => (
            <div key={l}>
              <div className="metric-label">{l}</div>
              <div className="metric-value" style={{ fontSize: '1.3rem', color: c }}>{v}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* ── Concentration ── */}
      <Card title="Is One Trade Carrying Everything?">
        <Verdict
          text={concentration.warning || (concentration.topTradePct !== null
            ? `Top trade is ${concentration.topTradePct}% of gains — within acceptable concentration.`
            : 'No gains recorded yet.')}
          tone={concentration.warning ? 'warn' : 'good'}
        />
        <div className="table-wrap">
          <table className="scan-table">
            <thead><tr><th style={{ textAlign: 'left' }}>Coin</th><th>Trades</th><th>Total P&L</th></tr></thead>
            <tbody>
              {concentration.byCoin.map(c => (
                <tr key={c.symbol}>
                  <td>{c.symbol.replace('USDT', '')}</td>
                  <td>{c.trades}</td>
                  <td className={c.totalPnl > 0 ? 'td-pos' : c.totalPnl < 0 ? 'td-neg' : ''}>{fmtPct(c.totalPnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* ── Shadow barrier simulation ── */}
      <Card title="What If The Stop/Target Were Different? (Shadow Simulation)">
        <Verdict text={`Replayed ${shadowBarriers.usableTrades} trades against alternative barrier geometries using logged MFE/MAE. ${shadowBarriers.skipped} trades lacked excursion data and were excluded. This is analysis only — live parameters are untouched.`} tone="neutral" />
        <div className="table-wrap">
          <table className="scan-table">
            <thead><tr>
              <th>TP</th><th>Stop</th><th>Expectancy (conservative)</th><th>Expectancy (optimistic)</th><th>Ambiguous</th>
            </tr></thead>
            <tbody>
              {shadowBarriers.combos.map((c, i) => (
                <tr key={i} style={i === 0 ? { background: 'rgba(52,201,122,0.06)' } : {}}>
                  <td className="td-pos">+{c.tp}%</td>
                  <td className="td-neg">{c.stop}%</td>
                  <td className={c.expectancyConservative > 0 ? 'td-pos' : 'td-neg'}>{fmtPct(c.expectancyConservative)}</td>
                  <td className={c.expectancyOptimistic > 0 ? 'td-pos' : 'td-neg'}>{fmtPct(c.expectancyOptimistic)}</td>
                  <td className="td-na">{c.ambiguous}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ ...mono, fontSize: '0.62rem', color: 'var(--text-dim)', marginTop: '0.5rem', fontStyle: 'italic' }}>
          {shadowBarriers.caveat}
        </div>
      </Card>

      {/* ── Score vs outcome ── */}
      <Card title="Does The Score Actually Predict Anything?">
        <Verdict text={scoreVsOutcome.note || 'Insufficient data.'} tone={
          scoreVsOutcome.correlation === null ? 'neutral'
            : scoreVsOutcome.correlation > 0.15 ? 'good'
            : scoreVsOutcome.correlation < -0.15 ? 'bad' : 'warn'} />
        <div style={{ display: 'flex', gap: '2rem' }}>
          <div>
            <div className="metric-label">Correlation (score → P&L)</div>
            <div className="metric-value" style={{ fontSize: '1.3rem' }}>{scoreVsOutcome.correlation ?? '—'}</div>
          </div>
          {scoreVsOutcome.buckets.map(b => (
            <div key={b.label}>
              <div className="metric-label">{b.label} (n={b.n})</div>
              <div className={`metric-value ${b.avgPnl > 0 ? 'td-pos' : 'td-neg'}`} style={{ fontSize: '1.3rem' }}>
                {fmtPct(b.avgPnl)}
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* ── Regime ── */}
      <Card title="Does It Only Work When BTC Is Green?">
        <div style={{ display: 'flex', gap: '2.5rem' }}>
          <div>
            <div className="metric-label">BTC green at entry (n={regime.btcGreen.n})</div>
            <div className={`metric-value ${regime.btcGreen.avgPnl > 0 ? 'td-pos' : 'td-neg'}`} style={{ fontSize: '1.3rem' }}>
              {fmtPct(regime.btcGreen.avgPnl)}
            </div>
          </div>
          <div>
            <div className="metric-label">BTC red at entry (n={regime.btcRed.n})</div>
            <div className={`metric-value ${regime.btcRed.avgPnl > 0 ? 'td-pos' : 'td-neg'}`} style={{ fontSize: '1.3rem' }}>
              {fmtPct(regime.btcRed.avgPnl)}
            </div>
          </div>
        </div>
      </Card>

      {/* ── Weekly Claude review ── */}
      <Card title="Claude's Weekly Review" accent="#8a63d2">
        {weeklyReview?.review ? (
          <>
            <div style={{ ...mono, fontSize: '0.62rem', color: 'var(--text-dim)', marginBottom: '0.75rem' }}>
              Generated {new Date(weeklyReview.created_at).toLocaleString()} · {weeklyReview.trades_analyzed} trades analysed · auto-runs Mondays 08:00 UTC
            </div>
            <Verdict text={weeklyReview.review.summary} tone="neutral" />
            {[
              ['Loss patterns', weeklyReview.review.loss_patterns],
              ['Win patterns', weeklyReview.review.win_patterns],
              ['Hypothesis to test (shadow only)', weeklyReview.review.hypothesis_to_test],
            ].map(([l, v]) => v && (
              <div key={l} style={{ marginBottom: '0.6rem' }}>
                <div className="metric-label">{l}</div>
                <div style={{ ...mono, fontSize: '0.75rem', lineHeight: 1.5 }}>{v}</div>
              </div>
            ))}
            {weeklyReview.review.risk_warnings?.length > 0 && (
              <div className="risk-flags" style={{ marginTop: '0.5rem' }}>
                {weeklyReview.review.risk_warnings.map((r, i) => <span key={i} className="risk-flag">{r}</span>)}
              </div>
            )}
          </>
        ) : (
          <Verdict text="No review generated yet. Runs automatically every Monday, or generate one now." tone="neutral" />
        )}
        <button className="scan-btn" style={{ marginTop: '0.75rem', fontSize: '0.65rem', padding: '0.5rem 1rem' }}
          onClick={runReview} disabled={reviewBusy}>
          {reviewBusy ? 'ANALYSING…' : 'GENERATE REVIEW NOW'}
        </button>
      </Card>
    </div>
  )
}
