# Getting Started with PoeClaw

This guide walks you through deploying PoeClaw from scratch. By the end, you'll have a URL you can share with your team where each person logs in with their own [Poe API key](https://poe.com/api_key) and gets a private AI assistant.

## Prerequisites

- **Node.js 22+** ([download](https://nodejs.org/))
- **Cloudflare account** with [Workers Paid plan](https://www.cloudflare.com/plans/developer-platform/) ($5/month) — required for Sandbox containers
- **Wrangler CLI** — installed automatically via npm
- Each user needs a [Poe API key](https://poe.com/api_key) (starts with `pb-`)

### Enable Cloudflare Containers

Before your first deploy, enable Containers in your Cloudflare dashboard:

1. Go to [Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages)
2. Click **Containers** in the sidebar
3. Enable the feature if prompted

## Step 1: Clone and Install

```bash
git clone https://github.com/garethpaul/poeclaw
cd poeclaw
npm install
```

## Step 2: Set Required Secrets

PoeClaw needs three secrets. Generate them with `openssl` and store them via Wrangler:

```bash
# 1. Session signing key (HMAC-SHA256 for session cookies)
echo "$(openssl rand -hex 32)" | npx wrangler secret put SESSION_SECRET

# 2. Encryption key (AES-GCM for encrypting stored API keys)
echo "$(openssl rand -hex 32)" | npx wrangler secret put ENCRYPTION_SECRET

# 3. Gateway token (secures Worker ↔ container communication)
echo "$(openssl rand -hex 32)" | npx wrangler secret put MOLTBOT_GATEWAY_TOKEN
```

Each command will prompt you to confirm. That's it for required setup — users bring their own Poe API keys, so no AI provider key is needed at the platform level.

## Step 3: Deploy

```bash
npm run deploy
```

This builds the React client, bundles the Worker, builds the container image, and deploys everything to Cloudflare. First deploy takes a few minutes while the container image uploads.

Your app is now live at:

```
https://poeclaw.<your-subdomain>.workers.dev
```

Find your subdomain in the [Workers dashboard](https://dash.cloudflare.com/?to=/:account/workers-and-pages) under your worker's settings.

## Step 4: First Login

1. Open your worker URL in a browser
2. You'll see the PoeClaw login page
3. Paste a [Poe API key](https://poe.com/api_key) (starts with `pb-`)
4. The key is validated against the Poe API — available models are fetched automatically
5. On success, a session cookie is set and you're taken to the chat interface

**First request takes 1-2 minutes** while your per-user container boots. After that, responses are fast.

## Step 5: Share with Your Team

Send your team the URL. Each person:
1. Gets their own Poe API key from [poe.com/api_key](https://poe.com/api_key)
2. Visits the URL and enters their key
3. Gets a private sandbox with their own model access, chat history, and encrypted key storage

Users are isolated — each gets a separate container keyed by a SHA-256 hash of their API key.

---

## Local Development

For local development without deploying:

### 1. Create `.dev.vars`

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars`:

```bash
DEV_MODE=true
MOLTBOT_GATEWAY_TOKEN=dev-token
```

`DEV_MODE=true` skips session auth and uses a single shared sandbox — no Poe key needed locally.

### 2. Start the Worker

```bash
npm run start
```

Open http://localhost:8787. In dev mode, you skip the login page and go straight to the chat interface.

> **Note:** WebSocket connections have known limitations with `wrangler dev`. Deploy to Cloudflare for full functionality.

### 3. Client-Only Dev (Optional)

For faster React iteration with hot reload:

```bash
npm run dev
```

This runs the Vite dev server on http://localhost:5173, proxying API requests to the Worker.

---

## Optional: Persistent Storage (R2)

Without R2, user data is lost when containers sleep (default: after 1 hour of inactivity). To persist chat history and settings across restarts:

### 1. Create R2 API Token

1. Go to **R2 > Overview** in the [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Click **Manage R2 API Tokens**
3. Create a token with **Object Read & Write** permissions for the `moltbot-data` bucket
4. Copy the **Access Key ID** and **Secret Access Key**

### 2. Set R2 Secrets

```bash
npx wrangler secret put R2_ACCESS_KEY_ID
# Paste your access key ID

npx wrangler secret put R2_SECRET_ACCESS_KEY
# Paste your secret access key

npx wrangler secret put CF_ACCOUNT_ID
# Paste your Cloudflare Account ID
# (Found at: Dashboard → any zone → Overview → API section, or URL bar)
```

### 3. Redeploy

```bash
npm run deploy
```

R2 is now active. Each user's data is stored under `users/{userHash}/openclaw/` in the `moltbot-data` bucket, synced every 30 seconds via rclone inside the container.

---

## Optional: Container Sleep Timeout

Containers sleep after 1 hour of inactivity by default. To change this:

```bash
npx wrangler secret put SANDBOX_SLEEP_AFTER
# Enter: 10m, 30m, 1h, or never
```

- `10m` — saves cost for rarely-used instances
- `1h` — default, good balance of cost and responsiveness
- `never` — always-on, fastest response but highest cost

With R2 configured, data persists across sleep/wake cycles.

---

## Optional: Debug Routes

Enable debug endpoints for troubleshooting container issues:

```bash
npx wrangler secret put DEBUG_ROUTES
# Enter: true
```

Then access (requires valid session):
- `GET /debug/processes` — list container processes
- `GET /debug/logs?id=<process_id>` — view process logs
- `GET /debug/version` — container and gateway version info

---

## Testing and Development

```bash
# Run the test suite
npm test

# Watch mode for TDD
npm run test:watch

# Type checking (TypeScript strict mode)
npm run typecheck

# Lint
npm run lint

# Format check
npm run format:check
```

Run all three before considering work complete:

```bash
npm run typecheck && npm run lint && npm test
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Invalid API key" on login | Key must start with `pb-`. Verify at [poe.com/api_key](https://poe.com/api_key) |
| "Server configuration error" | `SESSION_SECRET` or `ENCRYPTION_SECRET` not set. Re-run Step 2 |
| Slow first request (1-2 min) | Normal — container is booting. Subsequent requests are fast |
| Data lost after inactivity | Configure R2 storage (see above) or set `SANDBOX_SLEEP_AFTER=never` |
| `npm run start` fails with "Unauthorized" | Enable Containers in [dashboard](https://dash.cloudflare.com/?to=/:account/workers/containers) |
| Gateway exit code 126 (Windows) | CRLF line endings. Run `git config --global core.autocrlf input` and re-clone |

---

## All Secrets Reference

| Secret | Required | Description |
|--------|----------|-------------|
| `SESSION_SECRET` | **Yes** | HMAC-SHA256 key for session cookies |
| `ENCRYPTION_SECRET` | **Yes** | AES-GCM key for encrypting stored API keys |
| `MOLTBOT_GATEWAY_TOKEN` | **Yes** | Token securing Worker-to-container communication |
| `R2_ACCESS_KEY_ID` | No | R2 access key (enables persistence) |
| `R2_SECRET_ACCESS_KEY` | No | R2 secret key (enables persistence) |
| `CF_ACCOUNT_ID` | No | Cloudflare account ID (required for R2) |
| `SANDBOX_SLEEP_AFTER` | No | Sleep timeout: `1h` (default), `10m`, `never` |
| `DEBUG_ROUTES` | No | Set to `true` for `/debug/*` endpoints |
| `DEV_MODE` | No | Set to `true` for local dev (skip auth) |
| `CDP_SECRET` | No | Shared secret for browser automation |
| `WORKER_URL` | No | Public worker URL (required for CDP) |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot integration |
| `DISCORD_BOT_TOKEN` | No | Discord bot integration |
| `SLACK_BOT_TOKEN` | No | Slack bot integration |
| `SLACK_APP_TOKEN` | No | Slack app token (required with Slack bot) |

## Using Direct API Keys (Without Poe)

If you want to use direct API keys instead of Poe, set them as worker secrets:

```bash
# Anthropic
npx wrangler secret put ANTHROPIC_API_KEY

# OpenAI
npx wrangler secret put OPENAI_API_KEY

# Or Cloudflare AI Gateway (see README.md for details)
npx wrangler secret put CLOUDFLARE_AI_GATEWAY_API_KEY
npx wrangler secret put CF_AI_GATEWAY_ACCOUNT_ID
npx wrangler secret put CF_AI_GATEWAY_GATEWAY_ID
```

See the full secrets reference in [README.md](../README.md) for all available options.

## Next Steps

- **Add R2** for persistent storage across container restarts
- **Connect chat channels** (Telegram, Discord, Slack) — see [README.md](../README.md)
- **Enable browser automation** via CDP — see [README.md](../README.md)
- **Configure AI Gateway** for analytics and caching — see [README.md](../README.md)
