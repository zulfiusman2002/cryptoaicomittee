// src/pages/Dashboard.jsx
import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { SignalCard, StatusPill, VerdictBadge, PaperTradingSection } from '../components/index.jsx'

const verdictOrder = {
  'BUY ON BREAKOUT': 0,
  'BUY WATCH':       1,
  'BUY ON PULLBACK': 2,
  'SELL/EXIT WARNING': 3,
  'WAIT':            4,
  'AVOID':           5,
}

function pctClass(v) {
  if (v === null || v === undefined) return 'td-na'
  return v > 0 ? 'td-pos' : v < 0 ? 'td-neg' : ''
}

function fmt(v, dec = 2) {
  if (v === null || v === undefined) return 'N/A'
  return typeof v === 'number' ? v.toFixed(dec) : v
}

function fundingShort(cat) {
  return { neutral: 'NEUTRAL', positive_acceptable: 'POS', overheated: 'HOT 🔥', negative_squeeze_potential: 'NEG ⬆', unavailable: 'N/A' }[cat] || 'N/A'
}

export default function Dashboard() {
  const [status,       setStatus]    = useState({ turso: null, openai: null, claude: null, binance: null })
  const [scanning,     setScanning]  = useState(false)
  const [scanResult,   setScanResult] = useState(null)
  const [error,        setError]     = useState(null)
  const [history,      setHistory]   = useState([])
  const [histLoading,  setHistLoading] = useState(true)

  // Health check on mount
  useEffect(() => {
    fetch('/.netlify/functions/health-check')
      .then(r => r.json())
      .then(d => setStatus(d))
      .catch(() => {})

    // Load scan history via Netlify function (Turso-backed)
    fetch('/.netlify/functions/get-scans')
      .then(r => r.json())
      .then(data => { setHistory(Array.isArray(data) ? data : []); setHistLoading(false) })
      .catch(() => setHistLoading(false))
  }, [])

  const runScan = useCallback(async () => {
    setScanning(true)
    setError(null)
    setScanResult(null)
    try {
      const res = await fetch('/.netlify/functions/scan-market', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })
      if (!res.ok) {
        const e = await res.json()
        throw new Error(e.error || `HTTP ${res.status}`)
      }
      const data = await res.json()
      setScanResult(data)
      // Prepend to history
      setHistory(prev => [{
        id: data.scanId,
        created_at: data.timestamp,
        status: 'complete',
        top_signal: data.topSignals?.[0]?.symbol,
        summary: { top5: data.topSignals?.map(s => ({ symbol: s.symbol, verdict: s.verdict })) }
      }, ...prev].slice(0, 50))
    } catch (err) {
      setError(err.message)
    } finally {
      setScanning(false)
    }
  }, [])

  const topSignals  = scanResult?.topSignals  || []
  const fullTable   = scanResult?.fullTable   || []
  const sortedTable = [...fullTable].sort((a, b) =>
    (verdictOrder[a.verdict] ?? 9) - (verdictOrder[b.verdict] ?? 9)
  )

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="header-left">
          <span className="header-logo">CSIE</span>
          <span className="header-sub">Crypto Signal Intelligence Engine · MVP · Not financial advice</span>
        </div>
        <div className="status-row">
          <StatusPill label="Market Data" ok={status.binance}  loading={status.binance === null} />
          <StatusPill label="GPT"         ok={status.openai}   loading={status.openai  === null} />
          <StatusPill label="Claude"      ok={status.claude}   loading={status.claude  === null} />
          <StatusPill label="Database"    ok={status.turso}    loading={status.turso    === null} />
        </div>
      </header>

      {/* Scan trigger */}
      <div className="scan-section">
        <button className="btn-scan" onClick={runScan} disabled={scanning}>
          {scanning ? 'Scanning...' : 'Scan Market'}
        </button>
        {scanning && <span className="loading-text">Fetching microstructure data across 20 coins...</span>}
        {scanResult && !scanning && (
          <span className="scan-meta">
            Last scan: {new Date(scanResult.timestamp).toLocaleTimeString()} ·{' '}
            {scanResult.meta?.totalScanned} coins · {topSignals.length} signals found
            {scanResult.meta?.diagnostics && ` · ${scanResult.meta.diagnostics.successCount}/${scanResult.meta.diagnostics.total} fetched`}
            {scanResult.meta?.gptAvailable && scanResult.meta?.claudeAvailable
              ? ' · GPT + Claude active'
              : ' · AI keys missing — check Netlify env vars'}
          </span>
        )}
      </div>

      {scanning && <div className="progress-bar"><div className="progress-bar-fill" /></div>}

      {error && (
        <div className="error-msg">
          Scan error: {error}
          <div style={{ marginTop: '0.5rem', fontSize: '0.65rem', opacity: 0.7 }}>
            Check Netlify function logs for detailed diagnostics. If Binance is geo-blocked, see README for resolution steps.
          </div>
        </div>
      )}

      {/* Top signals */}
      {topSignals.length > 0 && (
        <>
          <div className="section-label">Top Signals · AI-Reviewed</div>
          <div className="signal-cards">
            {topSignals.map(s => <SignalCard key={s.symbol} signal={s} />)}
          </div>
        </>
      )}

      {scanResult && topSignals.length === 0 && (
        <div className="empty-state">No actionable signals detected in current conditions. All coins scored WAIT or below.</div>
      )}

      {/* Full table */}
      {/* Paper trading validation loop */}
      {scanResult?.paperTrading && (
        <PaperTradingSection paperTrading={scanResult.paperTrading} />
      )}

      {sortedTable.length > 0 && (
        <>
          <div className="section-label">Full Universe Scan · {sortedTable.length} coins · Deterministic scoring</div>
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
                  <th>Score</th>
                  <th>Verdict</th>
                  <th>Q</th>
                </tr>
              </thead>
              <tbody>
                {sortedTable.map(row => {
                  const isTop = topSignals.some(s => s.symbol === row.symbol)
                  return (
                    <tr key={row.symbol} className={isTop ? 'top-signal' : ''}>
                      <td>{row.symbol.replace('USDT', '')}</td>
                      <td>{row.price > 1 ? row.price?.toFixed(2) : row.price?.toFixed(6)}</td>
                      <td className={pctClass(row.return1h)}>{fmt(row.return1h)}%</td>
                      <td className={pctClass(row.return4h)}>{fmt(row.return4h)}%</td>
                      <td className={pctClass(row.return12h)}>{fmt(row.return12h)}%</td>
                      <td className={pctClass(row.return24h)}>{fmt(row.return24h)}%</td>
                      <td className={row.volumeShock > 2 ? 'td-warn' : ''}>{fmt(row.volumeShock)}x</td>
                      <td className={pctClass(row.oiChange4h)}>{fmt(row.oiChange4h)}%</td>
                      <td className={pctClass(row.oiChange24h)}>{fmt(row.oiChange24h)}%</td>
                      <td className={row.fundingCategory === 'overheated' ? 'td-warn' : 'td-na'}>
                        {fundingShort(row.fundingCategory)}
                      </td>
                      <td className={pctClass(row.relStrengthBtc)}>{fmt(row.relStrengthBtc)}%</td>
                      <td className={pctClass(row.relStrengthEth)}>{fmt(row.relStrengthEth)}%</td>
                      <td className={row.score > 3 ? 'td-pos' : row.score < 0 ? 'td-neg' : ''}>{row.score}</td>
                      <td><VerdictBadge verdict={row.verdict} /></td>
                      <td>
                        <span className={`quality-dot q${row.dataQuality}`} title={`Data quality: ${row.dataQuality}/3`} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* History */}
      <div className="section-label">Scan History</div>
      {histLoading
        ? <div className="empty-state">Loading history...</div>
        : history.length === 0
          ? <div className="empty-state">No previous scans. Press Scan Market to begin.</div>
          : (
          <div className="history-list">
            {history.map(scan => (
              <Link key={scan.id} to={`/scan/${scan.id}`} className="history-item">
                <div className="history-time">
                  {new Date(scan.created_at).toLocaleString()}
                </div>
                {scan.top_signal && (
                  <div className="history-top">▲ {scan.top_signal?.replace('USDT', '')}</div>
                )}
                <div className="history-pills">
                  {(scan.summary?.top5 || []).map(s => (
                    <span key={s.symbol} className={`history-pill verdict-badge verdict-${
                      s.verdict?.replace(/\//g,'').replace(/\s+/g,'-').replace('SELL-EXIT-WARNING','SELL')
                    }`}>
                      {s.symbol?.replace('USDT', '')}
                    </span>
                  ))}
                </div>
                <div style={{ marginLeft: 'auto', fontSize: '0.65rem', fontFamily: 'var(--mono)', color: 'var(--text-muted)' }}>
                  View →
                </div>
              </Link>
            ))}
          </div>
        )
      }

      <div className="disclaimer">
        CSIE is a research tool for analysing short-term crypto market microstructure. It does not predict prices,
        guarantee returns, or constitute financial advice. All signals are probabilistic and based on deterministic
        rule-based scoring. The rule-based engine has not been statistically backtested — treat all outputs as
        hypothesis generation, not validated edge. Always apply your own risk management. Past market structures
        do not guarantee future results. Data sourced from Binance public APIs; cross-exchange quality scoring
        is applied but does not eliminate data quality risk. Use at your own risk.
      </div>
    </div>
  )
}
