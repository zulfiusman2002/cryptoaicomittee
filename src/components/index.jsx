// src/components/index.jsx

// ── VerdictBadge ─────────────────────────────────────────────
export function VerdictBadge({ verdict }) {
  const cls = (verdict || 'WAIT')
    .replace(/\//g, '')
    .replace(/\s+/g, '-')
    .replace('SELL-EXIT-WARNING', 'SELL')
  return <span className={`verdict-badge verdict-${cls}`}>{verdict}</span>
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
  if (value === null || value === undefined) return <span className="metric-value td-na">—</span>
  const num = typeof value === 'number' ? value : parseFloat(value)
  if (isNaN(num)) return <span className="metric-value td-na">—</span>
  const cls = positiveGreen
    ? (num > 0 ? 'positive' : num < 0 ? 'negative' : 'neutral')
    : 'neutral'
  return <span className={`metric-value ${cls}`}>{num.toFixed(decimals)}{suffix}</span>
}

// ── Helpers ───────────────────────────────────────────────────
function fundingLabel(cat) {
  if (!cat || cat === 'unavailable') return '—'
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

  return (
    <div className={`signal-card${downgraded ? ' was-downgraded' : ''}`}>
      <div className="signal-card-header">
        <div>
          <div className="signal-symbol">{(signal.symbol || '').replace('USDT', '')}</div>
          <div className="signal-price">
            ${signal.price?.toLocaleString(undefined, { maximumFractionDigits: 6 }) || '—'}
          </div>
        </div>
        <VerdictBadge verdict={signal.verdict} />
      </div>

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

      {/* Levels */}
      {signal.entry_low != null && (
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
              GPT + Claude analysis unavailable — deterministic signal only. Check that OPENAI_API_KEY and ANTHROPIC_API_KEY are set in Netlify environment variables.
            </div>
          </div>
        </div>
      )}

      {/* Downgrade notice */}
      {downgraded && (
        <div className="downgrade-notice">⬇ Verdict downgraded by Claude risk challenge</div>
      )}

      {/* Risk flags from deterministic engine */}
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
