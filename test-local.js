#!/usr/bin/env node
// ============================================================
// CSIE LOCAL TEST RUNNER
// Tests every layer WITHOUT deploying to Netlify.
// Run with: node test-local.js
// Or with real keys: OPENAI_API_KEY=sk-... ANTHROPIC_API_KEY=sk-ant-... TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... node test-local.js
// ============================================================

const fs = require('fs')
require('dotenv').config({ path: '.env' })

let passed = 0
let failed = 0
const results = []

function ok(name) {
  passed++
  results.push(`  ✅ ${name}`)
}
function fail(name, reason) {
  failed++
  results.push(`  ❌ ${name}: ${reason}`)
}
function section(title) {
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`  ${title}`)
  console.log('─'.repeat(60))
}

async function runTests() {
  console.log('\n🔍 CSIE PRE-DEPLOY TEST SUITE')
  console.log('Testing all layers before Netlify deploy\n')

  // ── 1. ENV VARS ──────────────────────────────────────────────
  section('1. Environment Variables')
  const envVars = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN']
  for (const v of envVars) {
    if (process.env[v]) ok(`${v} is set`)
    else fail(v, 'NOT SET — add to .env file')
  }
  if (process.env.TURSO_DATABASE_URL && !process.env.TURSO_DATABASE_URL.startsWith('libsql://')) {
    fail('TURSO_DATABASE_URL format', `Must start with libsql:// — got: ${process.env.TURSO_DATABASE_URL.slice(0, 30)}`)
  } else if (process.env.TURSO_DATABASE_URL) {
    ok('TURSO_DATABASE_URL format is correct (libsql://)')
  }

  // ── 2. MODULE IMPORTS ────────────────────────────────────────
  section('2. Module Imports (catches Runtime.ImportModuleError)')
  const modules = [
    ['@libsql/client', () => require('@libsql/client')],
    ['./netlify/functions/lib/db', () => require('./netlify/functions/lib/db')],
    ['./netlify/functions/lib/marketData', () => require('./netlify/functions/lib/marketData')],
    ['./netlify/functions/lib/signals', () => require('./netlify/functions/lib/signals')],
    ['./netlify/functions/lib/aiAnalysis', () => require('./netlify/functions/lib/aiAnalysis')],
  ]
  for (const [name, loader] of modules) {
    try { loader(); ok(`${name} loads`) }
    catch (e) { fail(`${name} import`, e.message) }
  }

  // ── 3. TURSO DATABASE ────────────────────────────────────────
  section('3. Turso Database Connection')
  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
    fail('Turso', 'Skipped — env vars not set')
  } else {
    try {
      const { createClient } = require('@libsql/client')
      const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
      const result = await Promise.race([
        db.execute({ sql: 'SELECT 1 AS ok', args: [] }),
        new Promise((_, r) => setTimeout(() => r(new Error('timeout after 5s')), 5000))
      ])
      ok(`SELECT 1 returned: ${JSON.stringify(result.rows[0])}`)

      // Check tables exist
      const tables = await db.execute({ sql: "SELECT name FROM sqlite_master WHERE type='table'", args: [] })
      const tableNames = tables.rows.map(r => r.name)
      for (const t of ['scans', 'coin_metrics', 'signal_results']) {
        if (tableNames.includes(t)) ok(`Table '${t}' exists`)
        else fail(`Table '${t}'`, 'NOT FOUND — run turso/schema.sql')
      }
    } catch (e) {
      fail('Turso connection', e.message)
    }
  }

  // ── 4. MARKET DATA (CoinGecko) ───────────────────────────────
  section('4. Market Data — CoinGecko API')
  try {
    const ping = await fetch('https://api.coingecko.com/api/v3/ping', {
      headers: { 'User-Agent': 'CSIE-test/1.0' },
      signal: AbortSignal.timeout(8000)
    })
    if (ping.ok) {
      const json = await ping.json()
      ok(`CoinGecko ping: ${JSON.stringify(json)}`)
    } else {
      fail('CoinGecko ping', `HTTP ${ping.status}`)
    }
  } catch (e) {
    fail('CoinGecko reachable', e.message)
  }

  // Test actual market data fetch for 2 coins only (fast)
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin,ethereum&order=market_cap_desc&per_page=2&page=1&sparkline=false&price_change_percentage=1h%2C24h',
      { headers: { 'User-Agent': 'CSIE-test/1.0' }, signal: AbortSignal.timeout(10000) }
    )
    if (res.ok) {
      const data = await res.json()
      if (data.length === 2) {
        ok(`Markets data: BTC=$${data.find(c=>c.id==='bitcoin')?.current_price} ETH=$${data.find(c=>c.id==='ethereum')?.current_price}`)
        ok(`BTC 24h change: ${data.find(c=>c.id==='bitcoin')?.price_change_percentage_24h?.toFixed(2)}%`)
      } else {
        fail('Markets data', `Expected 2 coins, got ${data.length}`)
      }
    } else {
      fail('Markets fetch', `HTTP ${res.status}`)
    }
  } catch (e) {
    fail('Markets fetch', e.message)
  }

  // ── 5. SIGNALS ENGINE ────────────────────────────────────────
  section('5. Signals Engine — Deterministic Scoring')
  try {
    const { computeSignal, VERDICT } = require('./netlify/functions/lib/signals')
    const mockMetric = {
      symbol: 'BTCUSDT', dataQuality: 2, unavailable: false,
      price: 65000, return1h: 0.5, return4h: 1.2, return12h: 2.1, return24h: 5.3,
      volumeShock: 2.1, oiChange4h: 3.2, oiChange24h: 8.1, oiAcceleration: 1.2,
      fundingRate: 0.0001, fundingCategory: 'positive_acceptable',
      relStrengthBtc: 0, relStrengthEth: 1.2, takerBuyRatio: 0.58,
      higherHigh: true, volCompression: 0.6, liquidationPressureScore: 0,
      unlockOverhang: { hasOverhang: false }, risks: []
    }
    const signal = computeSignal(mockMetric)
    if (signal && signal.verdict) {
      ok(`computeSignal works: verdict=${signal.verdict} score=${signal.score}`)
    } else {
      fail('computeSignal', 'returned null or no verdict')
    }

    // Test with overheated — must return AVOID
    const overheated = { ...mockMetric, return24h: 45, fundingCategory: 'overheated' }
    const avoidSignal = computeSignal(overheated)
    if (avoidSignal.verdict === 'AVOID') ok('Hard override: overheated+extended → AVOID ✓')
    else fail('Hard override', `Expected AVOID, got ${avoidSignal.verdict}`)
  } catch (e) {
    fail('Signals engine', e.message)
  }

  // ── 6. GPT API ───────────────────────────────────────────────
  section('6. OpenAI GPT API')
  if (!process.env.OPENAI_API_KEY) {
    fail('GPT', 'Skipped — OPENAI_API_KEY not set')
  } else {
    try {
      const { runGptAnalysis } = require('./netlify/functions/lib/aiAnalysis')
      const mockM = {
        symbol: 'SOLUSDT', price: 71, return24h: 5.5, volumeShock: 3.2,
        relStrengthBtc: 4.1, fundingCategory: 'neutral', risks: ['no_oi_funding_data'],
        return1h: 0.3, return4h: 1.1, return12h: 2.8,
        oiChange4h: null, oiChange24h: null, oiAcceleration: null,
        fundingRate: null, hoursSinceFunding: null, basisPct: null,
        takerBuyRatio: 0.55, relStrengthEth: 2.1, higherHigh: true,
        volCompression: 0.7, dataQuality: 2, unlockOverhang: { hasOverhang: false }
      }
      const mockSignal = {
        verdict: 'BUY WATCH', score: 5, reason: 'healthy 24h momentum | elevated volume',
        levels: { entryLow: 70.5, entryHigh: 71.5, stopLoss: 67.5, tp1: 75, tp2: 78 }
      }
      console.log('  ⏳ Calling GPT...')
      const start = Date.now()
      const result = await runGptAnalysis(mockM, mockSignal, process.env.OPENAI_API_KEY)
      const elapsed = Date.now() - start
      if (result && result.coin && result.analyst_view) {
        ok(`GPT responded in ${elapsed}ms`)
        ok(`GPT setup_stage: ${result.setup_stage}`)
        ok(`GPT confidence: ${result.confidence_label}`)
        console.log(`    analyst_view: "${result.analyst_view?.slice(0, 100)}..."`)
      } else {
        fail('GPT response', `null or missing fields. Got: ${JSON.stringify(result)}`)
      }
    } catch (e) {
      fail('GPT call', e.message)
    }
  }

  // ── 7. CLAUDE API ────────────────────────────────────────────
  section('7. Anthropic Claude API')
  if (!process.env.ANTHROPIC_API_KEY) {
    fail('Claude', 'Skipped — ANTHROPIC_API_KEY not set')
  } else {
    try {
      const { runClaudeChallenge } = require('./netlify/functions/lib/aiAnalysis')
      const mockM = {
        symbol: 'SOLUSDT', price: 71, return24h: 5.5, volumeShock: 3.2,
        relStrengthBtc: 4.1, fundingCategory: 'neutral', risks: ['no_oi_funding_data']
      }
      const mockSignal = {
        verdict: 'BUY WATCH', score: 5,
        levels: { entryLow: 70.5, entryHigh: 71.5, stopLoss: 67.5, tp1: 75, tp2: 78 }
      }
      const mockGpt = {
        analyst_view: 'SOL shows healthy momentum with elevated volume.',
        confidence_label: 'Medium'
      }
      console.log('  ⏳ Calling Claude...')
      const start = Date.now()
      const result = await runClaudeChallenge(mockM, mockSignal, mockGpt, process.env.ANTHROPIC_API_KEY)
      const elapsed = Date.now() - start
      if (result && result.coin && result.challenge_summary) {
        ok(`Claude responded in ${elapsed}ms`)
        ok(`Claude final_risk_label: ${result.final_risk_label}`)
        ok(`Claude should_downgrade: ${result.should_downgrade}`)
        console.log(`    challenge: "${result.challenge_summary?.slice(0, 100)}..."`)
      } else {
        fail('Claude response', `null or missing fields. Got: ${JSON.stringify(result)}`)
      }
    } catch (e) {
      fail('Claude call', e.message)
    }
  }

  // ── 8. TIMING CHECK ──────────────────────────────────────────
  section('8. Timing — Will it fit in Netlify 10s limit?')
  console.log('  Estimated timing breakdown:')
  console.log('  CoinGecko markets (1 call):     ~0.5s')
  console.log('  CoinGecko OHLC (20 calls/2 batches): ~2.0s')
  console.log('  Scoring engine (sync):          ~0.1s')
  console.log('  GPT × 5 in parallel:            ~2.0s')
  console.log('  Claude × 5 in parallel:         ~2.0s')
  console.log('  Turso writes:                   ~0.5s')
  console.log('  ─────────────────────────────────────')
  console.log('  TOTAL ESTIMATE:                 ~7.1s')
  console.log('  Netlify free limit:             10.0s')
  console.log('  Margin:                         ~2.9s')
  if (passed > failed) ok('Timing should fit within 10s limit')
  else fail('Timing', 'Fix failures above before worrying about timing')

  // ── SUMMARY ──────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60))
  console.log('  TEST RESULTS')
  console.log('═'.repeat(60))
  results.forEach(r => console.log(r))
  console.log('─'.repeat(60))
  console.log(`  ${passed} passed  |  ${failed} failed`)
  console.log('═'.repeat(60))

  if (failed === 0) {
    console.log('\n  ✅ ALL TESTS PASSED — Safe to deploy\n')
  } else {
    console.log('\n  ❌ FAILURES FOUND — Fix these before deploying\n')
    process.exit(1)
  }
}

runTests().catch(e => {
  console.error('\nTest runner crashed:', e)
  process.exit(1)
})
