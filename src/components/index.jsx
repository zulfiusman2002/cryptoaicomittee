// src/components/index.jsx

// ── VerdictBadge ─────────────────────────────────────────────
export function VerdictBadge({ verdict }) {
  const cls = (verdict || 'WAIT')
    .replace(/\//g, '')
    .replace(/\s+/g, '-')
    .replace('SELL-EXIT-WARNING', 'SELL')
  return <span className={`verdict-badge verdict-${cls}`}>{verdict}</span>
}

// ── DataCompletenessBadge ─────────────────────────────────────
export function DataCompletenessBadge({ label }) {
  if (!label) return null
  const colors = {
    'Full Confirmation':    { bg: '#0d2d1a', color: '#34c97a', border: '#1a5030' },
    'Partial Confirmation': { bg: '#1a1a0d', color: '#e8a930', border: '#4a3a00' },
    'Momentum Only':        { bg: '#0d1a2d', color: '#4a9cf0', border: '#1a3a5a' },
    'Insufficient Data':    { bg: '#2d1010', color: '#e87060', border: '#6a1a1a' },
  }
  const s = colors[label] || colors['Insufficient Data']
  return (
    <span style={{
      fontFamily: 'var(--mono)', fontSize: '0.6rem', letterSpacing: '0.1em',
      textTransform: 'uppercase', padding: '0.2rem 0.5rem', borderRadius: '2px',
      background: s.bg, color: s.color, border: `1px solid ${s.border}`,
      whiteSpace: 'nowrap'
    }}>
      {label}
    </span>
  )
}

// ── StatusPill ────────────────────────────────────────────────
export function StatusPill({ label, ok, loading }) {
  const cls = loading ? 'status-unk' : ok ? 'status-ok' : 'status-err'
  return (
    <div className={`status-pill ${cls}`}>
      <div className="dot" />
      {label}
    </div>
  )
}

// ── MetricVal ─────────────────────────────────────────────────
export function MetricVal({ value, suffix = '', decimals = 2, positiveGreen = true }) {
  if (value === null || value === undefined) return <span className="metric-value td-na">N/A</span>
  const num = typeof value === 'number' ? value : parseFloat(value)
  if (isNaN(num)) return <span className="metric-value td-na">N/A</span>
  const cls = positiveGreen
    ? (num > 0 ? 'positive' : num < 0 ? 'negative' : 'neutral')
    : 'neutral'
  return <span className={`metric-value ${cls}`}>{num.toFixed(decimals)}{suffix}</span>
}

// ── Helpers ───────────────────────────────────────────────────
function fundingLabel(cat) {
  if (!cat || cat === 'unavailable') return 'N/A'
  return {
    neutral: 'Neutral',
    positive_acceptable: 'Positive',
    overheated: 'Overheated',
    negative_squeeze_potential: 'Squeeze Risk'
  }[cat] || cat
}

function riskClass(label) {
  if (!label) return 'neutral'
  return { Low: 'positive', Medium: 'neutral', High: 'warning', Extreme: 'negative' }[label] || 'neutral'
}

function fmtPrice(n) {
  if (!n && n !== 0) return '—'
  return n > 1 ? n.toFixed(2) : n.toFixed(6)
}

// ── SignalCard ────────────────────────────────────────────────
export function SignalCard({ signal }) {
  const gpt    = signal.gpt_analysis    || signal.gptAnalysis
  const claude = signal.claude_challenge || signal.claudeChallenge
  const risks  = signal.risks || []
  const downgraded = signal.was_downgraded || signal.wasDowngraded
  const dataCompleteness = signal.dataCompleteness || signal.data_completeness

  // Levels label from signal or default
  const levelsLabel = signal.levels?.levelsLabel || signal.levelsLabel ||
    'Mechanical levels — not confirmed by S/R or volume profile'

  return (
    <div className={`signal-card${downgraded ? ' was-downgraded' : ''}`}>
      {/* Header */}
      <div className="signal-card-header">
        <div>
          <div className="signal-symbol">{(signal.symbol || '').replace('USDT', '')}</div>
          <div className="signal-price">
            ${signal.price?.toLocaleString(undefined, { maximumFractionDigits: 6 }) || '—'}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.4rem' }}>
          <VerdictBadge verdict={signal.verdict} />
          {dataCompleteness && <DataCompletenessBadge label={dataCompleteness} />}
        </div>
      </div>

      {/* Metrics grid */}
      <div className="signal-card-grid">
        <div className="metric-item">
          <div className="metric-label">1h / 4h / 24h</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: '0.82rem' }}>
            <MetricVal value={signal.return1h ?? signal.return_1h} suffix="%" decimals={2} />
            {' / '}
            <MetricVal value={signal.return4h ?? signal.return_4h} suffix="%" decimals={2} />
            {' / '}
            <MetricVal value={signal.return24h ?? signal.return_24h} suffix="%" decimals={2} />
          </div>
        </div>

        <div className="metric-item">
          <div className="metric-label">Volume Shock</div>
          <MetricVal value={signal.volumeShock ?? signal.volume_shock} suffix="x" positiveGreen={false} />
        </div>

        <div className="metric-item">
          <div className="metric-label">OI Change 4h</div>
          <MetricVal value={signal.oiChange4h ?? signal.oi_change_4h} suffix="%" />
        </div>

        <div className="metric-item">
          <div className="metric-label">Funding</div>
          <span className={`metric-value ${
            signal.fundingCategory === 'overheated'                  ? 'negative' :
            signal.fundingCategory === 'negative_squeeze_potential'  ? 'warning'  : 'neutral'
          }`}>
            {fundingLabel(signal.fundingCategory)}
          </span>
        </div>

        <div className="metric-item">
          <div className="metric-label">RS vs BTC</div>
          <MetricVal value={signal.relStrengthBtc ?? signal.relative_strength_btc} suffix="%" />
        </div>

        <div className="metric-item">
          <div className="metric-label">Risk Level</div>
          <span className={`metric-value ${riskClass(signal.risk_label)}`}>
            {signal.risk_label || 'Medium'}
          </span>
        </div>
      </div>

      {/* Levels — always labelled mechanical */}
      {signal.entry_low != null && (
        <>
          <div className="levels-block">
            <div className="level-item">
              <div className="metric-label">Entry</div>
              <div className="metric-value" style={{ fontSize: '0.7rem' }}>
                {fmtPrice(signal.entry_low)} – {fmtPrice(signal.entry_high)}
              </div>
            </div>
            <div className="level-item">
              <div className="metric-label">Stop</div>
              <div className="metric-value negative" style={{ fontSize: '0.7rem' }}>
                {fmtPrice(signal.stop_loss)}
              </div>
            </div>
            <div className="level-item">
              <div className="metric-label">TP1</div>
              <div className="metric-value positive" style={{ fontSize: '0.7rem' }}>
                {fmtPrice(signal.take_profit_1)}
              </div>
            </div>
            <div className="level-item">
              <div className="metric-label">TP2</div>
              <div className="metric-value positive" style={{ fontSize: '0.7rem' }}>
                {fmtPrice(signal.take_profit_2)}
              </div>
            </div>
          </div>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: '0.58rem', color: 'var(--text-muted)',
            marginBottom: '0.5rem', letterSpacing: '0.06em', fontStyle: 'italic'
          }}>
            ⚠ {levelsLabel}
          </div>
        </>
      )}

      {/* AI analysis */}
      {(gpt || claude) ? (
        <div className="ai-section">
          {gpt && (
            <div className="ai-block gpt">
              <div className="ai-tag">
                GPT Analyst · {gpt.setup_stage} · {gpt.confidence_label} confidence
              </div>
              <div className="ai-text">{gpt.analyst_view}</div>
              {gpt.main_risk && (
                <div className="ai-text" style={{ marginTop: '0.35rem', color: '#e87060' }}>
                  Main risk: {gpt.main_risk}
                </div>
              )}
            </div>
          )}
          {claude && (
            <div className="ai-block claude">
              <div className="ai-tag">Claude Risk Challenge · {claude.final_risk_label} risk</div>
              <div className="ai-text">{claude.challenge_summary}</div>
              {claude.risk_flags?.length > 0 && (
                <div className="risk-flags" style={{ marginTop: '0.4rem' }}>
                  {claude.risk_flags.map((f, i) => (
                    <span key={i} className="risk-flag">{f}</span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="ai-section">
          <div className="ai-block" style={{ borderLeftColor: 'var(--border)', opacity: 0.5 }}>
            <div className="ai-tag">AI Analysis</div>
            <div className="ai-text" style={{ color: 'var(--text-muted)' }}>
              GPT + Claude analysis unavailable — deterministic signal only.
              Check that OPENAI_API_KEY and ANTHROPIC_API_KEY are set in Netlify environment variables.
            </div>
          </div>
        </div>
      )}

      {/* Downgrade notice */}
      {downgraded && (
        <div className="downgrade-notice">⬇ Verdict downgraded by Claude risk challenge</div>
      )}

      {/* Risk flags */}
      {risks.length > 0 && (
        <div className="risk-flags">
          {risks.map(r => (
            <span key={r} className="risk-flag">{r.replace(/_/g, ' ')}</span>
          ))}
        </div>
      )}

      {/* Invalidation */}
      {signal.invalidation_condition && (
        <div className="invalidation">{signal.invalidation_condition}</div>
      )}
    </div>
  )
}

// ── PaperTradingSection ───────────────────────────────────────
export function PaperTradingSection({ paperTrading }) {
  if (!paperTrading) return null
  const { openTrades = [], closedTrades = [], stats = {}, portfolio = null } = paperTrading

  const statusLabel = (s) => ({
    open: 'OPEN', stopped: 'STOPPED', tp1_hit: 'TP1 HIT', expired: 'EXPIRED (24h)'
  }[s] || s)

  const statusClass = (s) => ({
    open: 'neutral', stopped: 'negative', tp1_hit: 'positive', expired: 'neutral'
  }[s] || 'neutral')

  const fmtP = (n) => {
    if (n === null || n === undefined) return '—'
    const v = +n
    return v > 1 ? v.toFixed(2) : v.toFixed(6)
  }
  const fmtPct = (n) => {
    if (n === null || n === undefined) return '—'
    return (+n > 0 ? '+' : '') + (+n).toFixed(2) + '%'
  }
  const fmtGBP = (n) => {
    if (n === null || n === undefined) return '—'
    return (+n >= 0 ? '£' : '−£') + Math.abs(+n).toFixed(2)
  }
  const pnlClass = (n) => n === null || n === undefined ? 'td-na' : +n > 0 ? 'td-pos' : +n < 0 ? 'td-neg' : ''

  return (
    <div style={{ marginBottom: '2.5rem' }}>
      {/* ── £1000 Virtual Portfolio ── */}
      {portfolio && (
        <>
          <div className="section-label">
            Virtual Portfolio · £{portfolio.startingCapital} starting · £{portfolio.notionalPerTrade} per trade · running {portfolio.daysRunning}d
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
            gap: '1px', background: 'var(--border)',
            border: '1px solid var(--border)', borderRadius: '3px',
            overflow: 'hidden', marginBottom: '1rem'
          }}>
            {[
              ['Equity', fmtGBP(portfolio.equity), portfolio.equity >= portfolio.startingCapital ? 'td-pos' : 'td-neg'],
              ['Total Return', fmtPct(portfolio.returnPct), pnlClass(portfolio.returnPct)],
              ['Realized P&L', fmtGBP(portfolio.realized), pnlClass(portfolio.realized)],
              ['Unrealized P&L', fmtGBP(portfolio.unrealized), pnlClass(portfolio.unrealized)],
              ['Open / Closed', `${portfolio.openCount} / ${portfolio.closedCount}`, ''],
            ].map(([label, value, cls]) => (
              <div key={label} style={{ background: 'var(--bg-card)', padding: '0.75rem 1rem' }}>
                <div className="metric-label">{label}</div>
                <div className={`metric-value ${cls}`} style={{ fontSize: '1.15rem' }}>{value}</div>
              </div>
            ))}
          </div>
          {portfolio.note && (
            <div style={{
              fontFamily: 'var(--mono)', fontSize: '0.65rem', color: 'var(--amber)',
              marginBottom: '1.25rem', letterSpacing: '0.05em'
            }}>
              ⚠ {portfolio.note}
            </div>
          )}
        </>
      )}

      <div className="section-label">
        Paper Trading · Live Validation Loop · {stats.total || 0} closed trades
      </div>

      {/* Stats bar */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
        gap: '1px', background: 'var(--border)',
        border: '1px solid var(--border)', borderRadius: '3px',
        overflow: 'hidden', marginBottom: '1rem'
      }}>
        {[
          ['Closed Trades', stats.total ?? 0, ''],
          ['Win Rate', stats.winRate !== null && stats.winRate !== undefined ? stats.winRate + '%' : '—',
            stats.winRate > 50 ? 'td-pos' : stats.winRate !== null ? 'td-neg' : ''],
          ['Avg Win', stats.avgWin !== null && stats.avgWin !== undefined ? '+' + stats.avgWin + '%' : '—', 'td-pos'],
          ['Avg Loss', stats.avgLoss !== null && stats.avgLoss !== undefined ? stats.avgLoss + '%' : '—', 'td-neg'],
          ['Expectancy/Trade', stats.expectancy !== null && stats.expectancy !== undefined ? fmtPct(stats.expectancy) : '—',
            pnlClass(stats.expectancy)],
          ['Cumulative P&L', stats.cumulativePnl !== null && stats.cumulativePnl !== undefined ? fmtPct(stats.cumulativePnl) : '—',
            pnlClass(stats.cumulativePnl)],
        ].map(([label, value, cls]) => (
          <div key={label} style={{ background: 'var(--bg-card)', padding: '0.75rem 1rem' }}>
            <div className="metric-label">{label}</div>
            <div className={`metric-value ${cls}`} style={{ fontSize: '1.1rem' }}>{value}</div>
          </div>
        ))}
      </div>

      {stats.note && (
        <div style={{
          fontFamily: 'var(--mono)', fontSize: '0.65rem', color: 'var(--amber)',
          marginBottom: '1rem', letterSpacing: '0.05em'
        }}>
          ⚠ {stats.note}
        </div>
      )}

      {/* Open trades */}
      {openTrades.length > 0 && (
        <>
          <div style={{ fontFamily: 'var(--mono)', fontSize: '0.62rem', letterSpacing: '0.15em',
            textTransform: 'uppercase', color: 'var(--text-dim)', margin: '1rem 0 0.5rem' }}>
            Open Positions ({openTrades.length})
          </div>
          <div className="table-wrap">
            <table className="scan-table">
              <thead><tr>
                <th style={{ textAlign: 'left' }}>Coin</th><th>Entry</th><th>Stop</th>
                <th>TP1</th><th>Opened</th><th>MFE</th><th>MAE</th><th>Status</th>
              </tr></thead>
              <tbody>
                {openTrades.map(t => (
                  <tr key={t.id}>
                    <td>{t.symbol?.replace('USDT','')}</td>
                    <td>{fmtP(t.entry_price)}</td>
                    <td className="td-neg">{fmtP(t.stop_loss)}</td>
                    <td className="td-pos">{fmtP(t.tp1)}</td>
                    <td className="td-na">{new Date(t.opened_at).toLocaleString()}</td>
                    <td className="td-pos">{fmtPct(t.mfe_pct)}</td>
                    <td className="td-neg">{fmtPct(t.mae_pct)}</td>
                    <td><span className="verdict-badge verdict-WAIT">{statusLabel(t.status)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Closed trades */}
      {closedTrades.length > 0 && (
        <>
          <div style={{ fontFamily: 'var(--mono)', fontSize: '0.62rem', letterSpacing: '0.15em',
            textTransform: 'uppercase', color: 'var(--text-dim)', margin: '1rem 0 0.5rem' }}>
            Closed Trades (last {closedTrades.length})
          </div>
          <div className="table-wrap">
            <table className="scan-table">
              <thead><tr>
                <th style={{ textAlign: 'left' }}>Coin</th><th>Entry</th><th>Exit</th>
                <th>P&amp;L</th><th>MFE</th><th>MAE</th><th>Outcome</th><th>Closed</th>
              </tr></thead>
              <tbody>
                {closedTrades.map(t => (
                  <tr key={t.id}>
                    <td>{t.symbol?.replace('USDT','')}</td>
                    <td>{fmtP(t.entry_price)}</td>
                    <td>{fmtP(t.exit_price)}</td>
                    <td className={pnlClass(t.pnl_pct)}>{fmtPct(t.pnl_pct)}</td>
                    <td className="td-pos">{fmtPct(t.mfe_pct)}</td>
                    <td className="td-neg">{fmtPct(t.mae_pct)}</td>
                    <td>
                      <span className={`metric-value ${statusClass(t.status)}`}
                        style={{ fontFamily: 'var(--mono)', fontSize: '0.65rem' }}>
                        {statusLabel(t.status)}
                      </span>
                    </td>
                    <td className="td-na">{t.closed_at ? new Date(t.closed_at).toLocaleString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {openTrades.length === 0 && closedTrades.length === 0 && (
        <div className="empty-state">
          No paper trades yet. BUY signals from each scan are automatically locked as paper trades
          and evaluated against the real price path on your next scan.
        </div>
      )}
    </div>
  )
}
