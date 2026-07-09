// src/pages/ScanDetail.jsx
import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { SignalCard, VerdictBadge } from '../components/index.jsx'

function pctClass(v) {
  if (v === null || v === undefined) return 'td-na'
  return v > 0 ? 'td-pos' : v < 0 ? 'td-neg' : ''
}
function fmt(v, d = 2) {
  if (v === null || v === undefined) return '—'
  return typeof v === 'number' ? v.toFixed(d) : v
}
function fundingShort(cat) {
  return { neutral: 'NEUTRAL', positive_acceptable: 'POS', overheated: 'HOT 🔥', negative_squeeze_potential: 'NEG ⬆', unavailable: '—' }[cat] || '—'
}

export default function ScanDetail() {
  const { id } = useParams()
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/.netlify/functions/get-scan-detail?id=${id}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        setData({
          scan:    json.scan,
          metrics: json.metrics || [],
          signals: json.signals || []
        })
      } catch (err) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [id])

  if (loading) return <div className="app"><div className="loading-text">Loading scan...</div></div>
  if (error || !data?.scan) return (
    <div className="app">
      <div className="error-msg">Failed to load scan: {error || 'Not found'}</div>
      <Link to="/" style={{ color: 'var(--amber)', fontFamily: 'var(--mono)', fontSize: '0.75rem' }}>← Back</Link>
    </div>
  )

  const { scan, metrics, signals } = data

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <span className="header-logo">CSIE</span>
          <span className="header-sub">
            Scan · {new Date(scan.created_at).toLocaleString()} · {scan.status}
          </span>
        </div>
        <Link to="/" style={{ fontFamily: 'var(--mono)', fontSize: '0.72rem', color: 'var(--text-dim)', textDecoration: 'none' }}>
          ← Dashboard
        </Link>
      </header>

      {/* Signal results */}
      {signals.length > 0 && (
        <>
          <div className="section-label">AI-Reviewed Signals ({signals.length})</div>
          <div className="signal-cards">
            {signals.map(s => (
              <SignalCard key={s.id} signal={{
                ...s,
                return1h:         metrics.find(m => m.symbol === s.symbol)?.return_1h,
                return4h:         metrics.find(m => m.symbol === s.symbol)?.return_4h,
                return12h:        metrics.find(m => m.symbol === s.symbol)?.return_12h,
                return24h:        metrics.find(m => m.symbol === s.symbol)?.return_24h,
                volumeShock:      metrics.find(m => m.symbol === s.symbol)?.volume_shock,
                fundingCategory:  metrics.find(m => m.symbol === s.symbol)?.raw_metrics?.fundingCategory,
                relStrengthBtc:   metrics.find(m => m.symbol === s.symbol)?.relative_strength_btc,
                dataQuality:      metrics.find(m => m.symbol === s.symbol)?.data_quality_flag,
                oiChange4h:       metrics.find(m => m.symbol === s.symbol)?.oi_change_4h,
                risks:            metrics.find(m => m.symbol === s.symbol)?.raw_metrics?.risks || [],
              }} />
            ))}
          </div>
        </>
      )}

      {/* Full metrics table */}
      {metrics.length > 0 && (
        <>
          <div className="section-label">All Coins — Deterministic Metrics</div>
          <div className="table-wrap">
            <table className="scan-table">
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Coin</th>
                  <th>Price</th>
                  <th>1h</th>
                  <th>4h</th>
                  <th>12h</th>
                  <th>24h</th>
                  <th>Vol Shock</th>
                  <th>OI 4h</th>
                  <th>OI 24h</th>
                  <th>Funding</th>
                  <th>RS/BTC</th>
                  <th>RS/ETH</th>
                  <th>Taker Buy</th>
                  <th>DQ</th>
                </tr>
              </thead>
              <tbody>
                {metrics.map(m => (
                  <tr key={m.id} className={signals.some(s => s.symbol === m.symbol) ? 'top-signal' : ''}>
                    <td>{m.symbol?.replace('USDT', '')}</td>
                    <td>{m.price > 1 ? (+m.price).toFixed(2) : (+m.price).toFixed(6)}</td>
                    <td className={pctClass(m.return_1h)}>{fmt(m.return_1h)}%</td>
                    <td className={pctClass(m.return_4h)}>{fmt(m.return_4h)}%</td>
                    <td className={pctClass(m.return_12h)}>{fmt(m.return_12h)}%</td>
                    <td className={pctClass(m.return_24h)}>{fmt(m.return_24h)}%</td>
                    <td className={m.volume_shock > 2 ? 'td-warn' : ''}>{fmt(m.volume_shock)}x</td>
                    <td className={pctClass(m.oi_change_4h)}>{fmt(m.oi_change_4h)}%</td>
                    <td className={pctClass(m.oi_change_24h)}>{fmt(m.oi_change_24h)}%</td>
                    <td>{fundingShort(m.raw_metrics?.fundingCategory)}</td>
                    <td className={pctClass(m.relative_strength_btc)}>{fmt(m.relative_strength_btc)}%</td>
                    <td className={pctClass(m.relative_strength_eth)}>{fmt(m.relative_strength_eth)}%</td>
                    <td className={m.taker_buy_ratio > 0.6 ? 'td-pos' : m.taker_buy_ratio < 0.4 ? 'td-neg' : ''}>
                      {m.taker_buy_ratio ? (m.taker_buy_ratio * 100).toFixed(1) + '%' : '—'}
                    </td>
                    <td>
                      <span className={`quality-dot q${m.data_quality_flag}`}
                        title={`Data quality: ${m.data_quality_flag}/3`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="disclaimer">
        Historical scan data. Signal validity depends on market conditions at time of scan.
        This is not financial advice. CSIE signals are unvalidated hypotheses.
      </div>
    </div>
  )
}
