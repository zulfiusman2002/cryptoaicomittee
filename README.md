# Crypto Signal Intelligence Engine (CSIE)

A quantitative crypto market microstructure dashboard. Scans 20 liquid coins, applies deterministic rule-based scoring, then routes the top 5 candidates through GPT (analyst) and Claude (risk challenger) for AI interpretation.

**This is not a trading bot. It does not predict prices. It classifies market setups and presents evidence. All signals are unvalidated hypotheses.**

---

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React + Vite |
| Hosting | Netlify + Netlify Functions |
| Database | Turso (libSQL / SQLite) |
| AI Analyst | OpenAI GPT-4o-mini |
| AI Challenger | Anthropic Claude |
| Market Data | Binance Public APIs (no key required) |

---

## Architecture

```
Market Data (Binance public APIs)
  → Data quality scoring (3-tier cross-exchange confirmation)
  → Deterministic metric calculation (OI in USD, settled funding only)
  → Rule-based signal scoring
  → Top 5 candidates → GPT analysis → Claude risk challenge
  → Final verdict (Claude can downgrade, never upgrade)
  → Stored in Turso
  → Displayed in React dashboard
```

---

## Environment Variables

Only 4 variables required. No Supabase. No frontend-exposed keys.

```env
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
TURSO_DATABASE_URL=libsql://your-db-name-your-org.turso.io
TURSO_AUTH_TOKEN=your-turso-auth-token
```

All variables are server-side only (used in Netlify Functions). Nothing is exposed to the browser.

---

## Setup

### 1. Prerequisites

- Node.js 18+
- Netlify CLI: `npm install -g netlify-cli`
- Turso CLI: `curl -sSfL https://get.tur.so/install.sh | bash`

### 2. Clone and install

```bash
git clone https://github.com/your-username/csie.git
cd csie
npm install
```

### 3. Create Turso database

```bash
# Log in
turso auth login

# Create database
turso db create csie

# Get your database URL
turso db show csie
# → URL: libsql://csie-your-org.turso.io

# Generate auth token
turso db tokens create csie
# → Token: eyJ...
```

### 4. Run schema migrations

```bash
# Open a shell to your database
turso db shell csie

# Paste the contents of turso/schema.sql
# Or pipe it directly:
turso db shell csie < turso/schema.sql
```

### 5. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env`:

```env
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
TURSO_DATABASE_URL=libsql://csie-your-org.turso.io
TURSO_AUTH_TOKEN=eyJ...
```

### 6. Run locally

```bash
netlify dev
```

Visit `http://localhost:8888`

---

## Deployment

### GitHub

```bash
git init
git add .
git commit -m "Initial CSIE build"
git remote add origin https://github.com/your-username/csie.git
git push -u origin main
```

### Netlify

**Option A — Netlify CLI:**

```bash
netlify login
netlify init        # link to GitHub repo

# Set environment variables
netlify env:set OPENAI_API_KEY "sk-..."
netlify env:set ANTHROPIC_API_KEY "sk-ant-..."
netlify env:set TURSO_DATABASE_URL "libsql://csie-your-org.turso.io"
netlify env:set TURSO_AUTH_TOKEN "eyJ..."

netlify deploy --prod
```

**Option B — Netlify Dashboard:**

1. Connect your GitHub repo at app.netlify.com
2. Build command: `npm run build`
3. Publish directory: `dist`
4. Functions directory: `netlify/functions`
5. Add 4 environment variables in Site settings → Environment variables

---

## Netlify Function Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/.netlify/functions/scan-market` | POST | Run a full scan |
| `/.netlify/functions/get-scans` | GET | Fetch scan history |
| `/.netlify/functions/get-scan-detail?id=<id>` | GET | Fetch one scan |
| `/.netlify/functions/health-check` | GET | Check all connections |

---

## Signal Verdicts

| Verdict | Meaning |
|---------|---------|
| BUY WATCH | Setup forming. Metrics align. Monitor for entry. |
| BUY ON BREAKOUT | Breakout candidate. Enter above resistance with confirmation. |
| BUY ON PULLBACK | Strong trend. Wait for retracement to entry zone. |
| WAIT | Conditions insufficient. No clear setup. |
| AVOID | Overheated or deteriorating conditions. |
| SELL/EXIT WARNING | OI/price/funding divergence suggests distribution. |

## Data Quality Flags

| Flag | Meaning |
|------|---------|
| 🟢 3 | Spot + Futures + Funding all confirmed |
| 🟡 2 | Spot + Futures only |
| 🔴 1 | Single venue — reduced confidence |

---

## Key Metrics

- **Volume Shock**: Current 24h volume / 7-day average. >2 = elevated.
- **OI Change**: Open Interest change (USD notional). Positive = new positions opening.
- **Funding**: Based on last **settled** rate (not predicted). "Overheated" = annualised >30%.
- **RS/BTC**: 24h return minus BTC 24h return. Positive = outperforming BTC.
- **Taker Buy Ratio**: Fraction of aggressive buy orders. >0.6 = buy-side pressure.

---

## Limitations

1. **Rule-based engine is not backtested.** Signals are hypothesis generation, not proven edge.
2. **Volume data may contain wash trading.** Binance is more regulated than most, but treat mid-cap volume with scepticism.
3. **Funding rates are 8-hour lagged.** The `hours_since_funding` field tracks staleness.
4. **No regime detection in MVP.** Signals are not conditioned on market regime.
5. **No backtested MFE/MAE distribution.** Entry/TP/SL levels are rule-based approximations.

---

## Cost Estimate (per scan)

| Service | Cost |
|---------|------|
| Binance API | Free |
| OpenAI GPT-4o-mini | ~$0.001–0.003 |
| Anthropic Claude | ~$0.002–0.005 |
| Turso | Free tier (500 reads/writes per day) |
| Netlify Functions | Free tier (125k invocations/month) |
| **Total per scan** | **< $0.01** |

---

## Disclaimer

CSIE is a research and educational tool. It does not constitute financial advice. Crypto markets are highly volatile. The rule-based signals in this MVP have not been statistically validated. Never risk more than you can afford to lose. Always apply your own risk management.
