# PoeClaw

Multi-tenant [OpenClaw](https://github.com/openclaw/openclaw) platform powered by [Poe API keys](https://poe.com/api_key), running in [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/) containers.

![PoeClaw logo](./assets/logo.png)

> **Experimental:** Proof of concept. Not officially supported — may break without notice.

## How It Works

1. You deploy PoeClaw to Cloudflare Workers
2. Share the URL with your team
3. Each person enters their own [Poe API key](https://poe.com/api_key)
4. They get a private sandbox with access to all models on their Poe subscription
5. Each user's data and API key are isolated — separate containers, separate encrypted storage

## Requirements

- [Workers Paid plan](https://www.cloudflare.com/plans/developer-platform/) ($5 USD/month) — required for Cloudflare Sandbox
- Each user needs a [Poe API key](https://poe.com/api_key) — provides access to Claude, GPT, Gemini, and other models through Poe's subscription

The following Cloudflare features used by this project have free tiers:
- Browser Rendering (for browser navigation)
- AI Gateway (optional, for API routing/analytics)
- R2 Storage (optional, for persistence)

## Cost Estimate

PoeClaw uses `basic` Cloudflare Container instances (1 vCPU, 1 GiB memory, 2 GB disk) with a default sleep timeout of 1 hour. This keeps per-user costs low for multi-tenant deployments.

| Resource | Per User/Month (1h sleep) | Notes |
|----------|--------------------------|-------|
| Memory | ~$0.50 | 1 GiB, billed only while awake |
| CPU | ~$0.20 | Billed on active usage (~10% utilization) |
| Disk | ~$0.22 | 2 GB provisioned |
| **Per-user total** | **~$0.92** | Assumes ~4 hrs active/day |

Plus the $5/month Workers Paid plan (flat, not per-user). A team of 10 costs roughly **$14/month** total.

To adjust the sleep timeout, set `SANDBOX_SLEEP_AFTER` (e.g., `10m`, `1h`, `never`). The default is `1h`. Setting `never` keeps containers alive indefinitely but increases cost.

See the [instance types table](https://developers.cloudflare.com/containers/pricing/) for other options.

## Quick Start

```bash
# Clone and install
git clone https://github.com/garethpaul/poeclaw
cd poeclaw
npm install

# Generate session secrets (required for multi-tenant auth)
echo "$(openssl rand -hex 32)" | npx wrangler secret put SESSION_SECRET
echo "$(openssl rand -hex 32)" | npx wrangler secret put ENCRYPTION_SECRET

# Generate gateway token (secures Worker-to-container communication)
echo "$(openssl rand -hex 32)" | npx wrangler secret put MOLTBOT_GATEWAY_TOKEN

# Deploy
make deploy
```

> Run `make help` to see all available commands.

After deploying, visit your worker URL:

```
https://poeclaw.your-subdomain.workers.dev
```

You'll see a login page. Enter a [Poe API key](https://poe.com/api_key) to start chatting.

**Note:** The first request after login may take 1-2 minutes while the per-user container starts.

## Architecture

PoeClaw adds a multi-tenant session layer on top of OpenClaw:

```
User (browser)
  │
  ├─ POST /api/auth/login    → Validates Poe API key, creates session cookie
  │                             Encrypts key with AES-GCM, stores in per-user sandbox
  │
  ├─ Chat UI (React)         → Model selector, SSE streaming, dark theme
  │
  └─ /v1/chat/completions    → Proxied to per-user OpenClaw gateway
                                Each user gets their own Sandbox container
                                resolved by: getSandbox(env.Sandbox, userHash)
```

### Security

- **Session cookies**: HMAC-SHA256 signed, `HttpOnly; Secure; SameSite=Lax`, 24h expiry
- **API key storage**: AES-GCM encrypted with random IV, stored in per-user sandbox
- **User isolation**: Each user gets a separate Durable Object / container, keyed by SHA-256 hash of their API key
- **Rate limiting**: 10 login attempts per IP per minute
- **CSP headers**: `default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'`, plus `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`
- **R2 namespacing**: Per-user paths (`users/{userHash}/openclaw/`) prevent cross-tenant data access

## Authentication

PoeClaw uses **Poe API key authentication** instead of Cloudflare Access:

1. User enters their Poe API key on the login page
2. Key is validated against `api.poe.com/v1/models` — the available models list is returned
3. A session cookie is set (HMAC-SHA256 signed, 24h TTL)
4. The API key is AES-GCM encrypted and stored in the user's sandbox
5. On subsequent requests, the session cookie is verified and the per-user sandbox is resolved

No Cloudflare Access setup is needed. Each user authenticates with their own Poe key.

### Local Development

Start the dev server with `make dev` (cleans stale containers first) or `make dev-fast` (skip cleanup):

```bash
make dev
```

Create a `.dev.vars` file for local config:

```bash
DEV_MODE=true               # Skip session auth, use a single sandbox
DEBUG_ROUTES=true           # Enable /debug/* routes (optional)
```

## Persistent Storage (R2)

By default, user data is lost when a container sleeps. To enable persistence, configure R2:

### 1. Create R2 API Token

1. Go to **R2** > **Overview** in the [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Click **Manage R2 API Tokens**
3. Create a token with **Object Read & Write** permissions
4. Select the `moltbot-data` bucket (created automatically on first deploy)
5. Copy the **Access Key ID** and **Secret Access Key**

### 2. Set Secrets

```bash
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put CF_ACCOUNT_ID
```

### How It Works

Each user's data is stored under `users/{userHash}/openclaw/` in R2, preventing cross-tenant access.

- **On container startup:** Data is restored from R2 to the container
- **During operation:** A sync loop watches for file changes and backs up to R2
- **Without R2:** PoeClaw still works, but data is lost when the container sleeps

## Optional: Chat Channels

Chat platform tokens are set as worker-level secrets and shared across all user instances. Per-user channel configuration is not currently supported.

### Telegram

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
```

### Discord

```bash
npx wrangler secret put DISCORD_BOT_TOKEN
```

### Slack

```bash
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put SLACK_APP_TOKEN
```

## Optional: Browser Automation (CDP)

The worker includes a Chrome DevTools Protocol (CDP) shim for browser automation (screenshots, scraping, etc.).

```bash
npx wrangler secret put CDP_SECRET       # Shared secret for authentication
npx wrangler secret put WORKER_URL       # https://poeclaw.your-subdomain.workers.dev
make deploy
```

| Endpoint | Description |
|----------|-------------|
| `GET /cdp/json/version` | Browser version info |
| `GET /cdp/json/list` | List browser targets |
| `GET /cdp/json/new` | Create new target |
| `WS /cdp/devtools/browser/{id}` | WebSocket CDP connection |

All endpoints require `?secret=<CDP_SECRET>`.

## Optional: Cloudflare AI Gateway

Route API requests through [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) for caching, rate limiting, and analytics.

```bash
npx wrangler secret put CLOUDFLARE_AI_GATEWAY_API_KEY   # Your provider's API key
npx wrangler secret put CF_AI_GATEWAY_ACCOUNT_ID        # Cloudflare account ID
npx wrangler secret put CF_AI_GATEWAY_GATEWAY_ID        # AI Gateway ID
make deploy
```

When configured, AI Gateway takes precedence over direct API keys. See [AI Gateway docs](https://developers.cloudflare.com/ai-gateway/) for provider options.

## All Secrets Reference

| Secret | Required | Description |
|--------|----------|-------------|
| `SESSION_SECRET` | **Yes** | HMAC-SHA256 key for session cookies (32+ chars) |
| `ENCRYPTION_SECRET` | **Yes** | AES-GCM key for encrypting stored API keys (32+ chars) |
| `MOLTBOT_GATEWAY_TOKEN` | **Yes** | Token to secure the internal container gateway |
| `ANTHROPIC_API_KEY` | No | Direct Anthropic API key (alternative to Poe) |
| `OPENAI_API_KEY` | No | Direct OpenAI API key (alternative to Poe) |
| `CLOUDFLARE_AI_GATEWAY_API_KEY` | No | API key for AI Gateway |
| `CF_AI_GATEWAY_ACCOUNT_ID` | No | Cloudflare account ID for AI Gateway |
| `CF_AI_GATEWAY_GATEWAY_ID` | No | AI Gateway ID |
| `CF_AI_GATEWAY_MODEL` | No | Override model: `provider/model-id` |
| `DEV_MODE` | No | `true` to skip auth (local dev only) |
| `DEBUG_ROUTES` | No | `true` to enable `/debug/*` routes |
| `SANDBOX_SLEEP_AFTER` | No | Container sleep timeout: `1h` (default), `10m`, `never` |
| `R2_ACCESS_KEY_ID` | No | R2 access key for persistence |
| `R2_SECRET_ACCESS_KEY` | No | R2 secret key for persistence |
| `CF_ACCOUNT_ID` | No | Cloudflare account ID (for R2) |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token |
| `DISCORD_BOT_TOKEN` | No | Discord bot token |
| `SLACK_BOT_TOKEN` | No | Slack bot token |
| `SLACK_APP_TOKEN` | No | Slack app token |
| `CDP_SECRET` | No | Shared secret for CDP authentication |
| `WORKER_URL` | No | Public URL of the worker (for CDP) |

## Debug Endpoints

Available at `/debug/*` when `DEBUG_ROUTES=true` (requires valid session):

- `GET /debug/processes` - List container processes
- `GET /debug/logs?id=<process_id>` - Process logs
- `GET /debug/version` - Container and gateway version info

## Troubleshooting

**Login fails with "Invalid API key":** Ensure your Poe API key starts with `pb-` and is valid at [poe.com/api_key](https://poe.com/api_key).

**"Server configuration error" on login:** `SESSION_SECRET` or `ENCRYPTION_SECRET` is not set. Run the secret setup commands from Quick Start.

**Slow first request after login:** Cold starts take 1-2 minutes while the per-user container boots. Subsequent requests are fast.

**Data lost after inactivity:** Containers sleep after 1 hour by default. Configure R2 storage for persistence across restarts.

**`npm run dev` fails with "Unauthorized":** Enable Cloudflare Containers in the [Containers dashboard](https://dash.cloudflare.com/?to=/:account/workers/containers).

**WebSocket issues in local dev:** `wrangler dev` has known limitations with WebSocket proxying through the sandbox. Deploy to Cloudflare for full functionality.

## Known Issues

### Windows: Gateway fails to start with exit code 126

Git may check out shell scripts with CRLF line endings. Ensure LF line endings: `git config --global core.autocrlf input` or add `.gitattributes` with `* text=auto eol=lf`.

## Links

- [OpenClaw](https://github.com/openclaw/openclaw)
- [Poe API Keys](https://poe.com/api_key)
- [Cloudflare Sandbox Docs](https://developers.cloudflare.com/sandbox/)
- [Cloudflare Containers Pricing](https://developers.cloudflare.com/containers/pricing/)
