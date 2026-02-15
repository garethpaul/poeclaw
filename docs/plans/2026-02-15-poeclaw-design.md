# PoeClaw Design Document

> Multi-tenant OpenClaw platform powered by Poe API keys on Cloudflare Workers

## 1. Overview

PoeClaw transforms the single-tenant moltworker/OpenClaw project into a multi-tenant platform where users authenticate with their Poe API key and get their own sandboxed AI agent instance.

**User flow:**
1. Visit landing page
2. Paste POE_API_KEY
3. Key is validated against `api.poe.com/v1/models`
4. Container spins up with their key as the LLM provider
5. Chat via a Poe-style dark-themed UI

## 2. Architecture

```
User Browser
    |
+-------------------------------------------+
|  Cloudflare Worker (Hono)                  |
|                                            |
|  GET /          -> Landing/Login Page      |
|  POST /api/auth/login  -> Validate key     |
|       |                                    |
|       v                                    |
|  Session Middleware                         |
|   - Verify session cookie                  |
|   - Resolve user's Sandbox DO              |
|   - Decrypt POE_API_KEY from DO storage    |
|       |                                    |
|       v                                    |
|  Per-User Sandbox (Durable Object)         |
|   - Container with OpenClaw                |
|   - Poe provider config patched in         |
|   - Proxy HTTP/SSE to container            |
+-------------------------------------------+
```

**Key architectural decisions:**
- One Sandbox Durable Object per user, keyed by stable user identifier (hashed)
- Poe API accessed via OpenAI-compatible endpoint (`api.poe.com/v1/chat/completions`)
- Custom Poe provider config patched into OpenClaw at container boot
- HTTP API + SSE for chat (not WebSocket) to avoid protocol complexity
- Session cookies with HMAC-SHA256 signing

## 3. Design Decisions (Informed by Adversarial Debate)

Five parallel research agents investigated risks. Key findings and mitigations:

### 3.1 Multi-Tenancy (H1: Conditionally Feasible)

**How it works:** `getSandbox(env.Sandbox, userHash, options)` — each unique hash creates a separate Durable Object with its own container.

**Constraints:**
- `max_instances` must be raised from 1 (current) to expected concurrent users
- Account-level hard cap: ~400 GiB memory = 100 concurrent `standard-1` or 400 `basic` containers
- `keepAlive: true` is catastrophic for multi-tenant — must use `sleepAfter`

**Decision:** Use `basic` instance type (1 GiB RAM) with `sleepAfter: "1h"`. Target 10-50 concurrent users for v1.

### 3.2 Poe API Compatibility (H2: Sharp Edges)

**What works:** Basic chat completions via `api.poe.com/v1/chat/completions` with bearer token auth.

**What breaks:**
- Model names: Poe uses `Claude-Sonnet-4.5`, `GPT-5.2` — not standard OpenAI IDs
- Tool calling + streaming: Known Poe bug causes silent failures
- `response_format`, `strict` mode: Silently ignored
- 500 RPM rate limit could be hit during heavy agentic use

**Decision:** Create a custom `poe` provider entry in OpenClaw config (same pattern as KimiClaw). Start with non-streaming for reliability, add streaming as a follow-up. Hardcode 2-3 model names initially.

### 3.3 Authentication Security (H3: Approved with Mitigations)

**Model:** Paste API key -> validate -> HMAC session cookie -> encrypted key in DO storage.

**Required mitigations:**
1. Rate limit login: 10 attempts/IP/minute
2. Cookie: `HttpOnly; Secure; SameSite=Lax; Max-Age=86400`
3. Separate secrets: one for HMAC signing, one for key encryption
4. Never display full API key in UI (show `***...last4` only)
5. Timing-safe comparison for session validation
6. Input validation on key format before sending to Poe

**Key rotation risk:** If user rotates their Poe key, the old key's hash (DO ID) orphans their data. Mitigation: check if Poe's `/v1/models` response includes a stable user ID — use that for DO ID instead of key hash.

**Decision:** Store encrypted key in DO storage (not KV) — colocated, strongly consistent, no extra cost. Use DO storage for session metadata too.

### 3.4 Cost Model (H4: Viable)

| Instance | Per-user/mo (30min/day, 1h sleep) | 100 users/mo |
|----------|-----------------------------------|--------------|
| standard-1 (4 GiB) | ~$3.24 | ~$329 |
| basic (1 GiB) | ~$0.92 | ~$97 |

**Cold start: 1-2 minutes** (heavy Dockerfile: image pull + R2 restore + OpenClaw onboard + config patch + gateway start). This is the #1 UX risk.

**Decision:** Use `basic` instances. Accept cold starts with a good loading UI. Explore Dockerfile optimization to reduce boot time as a follow-up.

### 3.5 Chat UI Architecture (H5: Feasible via HTTP API)

**Decision:** Use OpenClaw's HTTP API (`/v1/chat/completions` + SSE) instead of the WebSocket JSON-RPC protocol.

**Why:** The WebSocket protocol requires a complex challenge-response handshake, device identity, and custom event parsing. The HTTP API is standard OpenAI-compatible — just `fetch` + SSE.

**Requirements:**
- Enable `gateway.http.endpoints.chatCompletions.enabled: true` in config patch
- Model switching via `model` field or `x-openclaw-agent-id` header
- Add Worker endpoints: `GET /api/sessions` (proxy to CLI), `GET /api/models`
- Handle cold starts: check `/api/status` before attempting chat

## 4. File Changes

### Modified Files

| File | Change |
|------|--------|
| `src/index.ts` | Per-user sandbox resolution, session middleware, remove CF Access requirement, add auth routes |
| `src/types.ts` | Add `POE_API_KEY`, session types |
| `src/gateway/env.ts` | Add `POE_API_KEY` env var passthrough to container |
| `src/gateway/process.ts` | Per-user env var injection at container startup |
| `src/gateway/sync.ts` | Namespace R2 paths: `users/{userHash}/` |
| `src/gateway/r2.ts` | Same R2 namespacing |
| `start-openclaw.sh` | Detect `POE_API_KEY`, create Poe provider config, enable HTTP API, accept `OPENAI_BASE_URL` |
| `wrangler.jsonc` | Rename to `poeclaw`, instance_type `basic`, raise `max_instances`, add rate limiting |
| `package.json` | Rename to `poeclaw` |

### New Files

| File | Purpose |
|------|---------|
| `src/auth/session.ts` | Session creation, cookie management, key encryption, HMAC signing |
| `src/auth/poe.ts` | POE_API_KEY validation via `/v1/models`, model list extraction |
| `src/routes/auth.ts` | `POST /api/auth/login`, `POST /api/auth/logout` |
| `src/client/pages/LoginPage.tsx` | Dark-themed landing page with key input |
| `src/client/pages/LoginPage.css` | Landing page styles |
| `src/client/pages/ChatPage.tsx` | Poe-style chat: sidebar + messages + input |
| `src/client/pages/ChatPage.css` | Dark theme chat styles |
| `src/client/hooks/useChat.ts` | SSE streaming hook for chat completions |
| `src/client/hooks/useGatewayStatus.ts` | Poll `/api/status` for cold start handling |

### Removed/Replaced

| File | Reason |
|------|--------|
| `src/auth/jwt.ts` | No CF Access — replaced by session auth |
| `src/auth/middleware.ts` | Replaced by session middleware |
| `src/client/pages/AdminPage.tsx` | Replaced by ChatPage |
| `src/routes/admin-ui.ts` | Replaced by chat UI serving |

## 5. Implementation Phases

### Phase 1: Auth & Multi-Tenant Core
*Foundation — must be first. Estimated: largest phase.*

- `src/auth/poe.ts` — validate POE_API_KEY against `api.poe.com/v1/models`
- `src/auth/session.ts` — HMAC session tokens, cookie management, key encryption in DO storage
- `src/routes/auth.ts` — login/logout endpoints with rate limiting
- `src/index.ts` — per-user Sandbox DO resolution (`getSandbox(env.Sandbox, userHash, options)`), session middleware
- `src/types.ts` — new types for `POE_API_KEY`, sessions, Poe models
- `wrangler.jsonc` — rename to `poeclaw`, `instance_type: "basic"`, `max_instances: 50`, `sleepAfter: "1h"`
- Minimal unstyled login page to test end-to-end

**Testable outcome:** User pastes key, gets session cookie, Worker resolves per-user Sandbox DO.

### Phase 2: Poe Provider Integration
*Make containers work with Poe API. Estimated: medium.*

- `src/gateway/env.ts` — add `POE_API_KEY` to container env vars
- `start-openclaw.sh` — detect `POE_API_KEY`, create custom Poe provider config in `openclaw.json`:
  ```json
  {
    "poe": {
      "baseUrl": "https://api.poe.com/v1",
      "apiKey": "${POE_API_KEY}",
      "api": "openai-completions",
      "models": [
        { "id": "Claude-Sonnet-4.5", "name": "Claude Sonnet 4.5" },
        { "id": "GPT-5.2", "name": "GPT 5.2" },
        { "id": "Gemini-3-Pro", "name": "Gemini 3 Pro" }
      ]
    }
  }
  ```
- Enable HTTP chat completions endpoint in config patch
- Set `OPENCLAW_DEV_MODE=true` to skip device pairing (Worker handles auth)
- Auto-generate per-user gateway token from `userHash`

**Testable outcome:** Login -> container starts -> can chat via OpenClaw's built-in Control UI through the Worker proxy.

### Phase 3: Per-User R2 Persistence
*Data isolation. Estimated: small.*

- `src/gateway/sync.ts` — namespace R2 paths with `users/{userHash}/`
- `src/gateway/r2.ts` — pass user prefix to rclone config
- `start-openclaw.sh` — restore/sync from user-prefixed R2 paths

**Testable outcome:** User's conversations persist across container restarts. Different users have isolated data.

### Phase 4: Poe-Style Chat Frontend
*The UI. Estimated: large.*

- `src/client/pages/LoginPage.tsx` — dark-themed landing with key input, link to `poe.com/api_key`
- `src/client/pages/ChatPage.tsx` — left sidebar (models, conversations), main chat area, input bar
- `src/client/hooks/useChat.ts` — `fetch` to `/v1/chat/completions` with SSE streaming
- `src/client/hooks/useGatewayStatus.ts` — poll `/api/status`, show loading during cold start
- `src/client/App.tsx` — router between login/chat based on session state
- Model selector populated from cached `/v1/models` response (stored during login)
- Markdown rendering for code blocks, lists, etc.
- Remove old AdminPage

**Testable outcome:** Full Poe-like chat experience with model switching and conversation history.

### Phase 5: Polish & Harden
*Production readiness. Estimated: medium.*

- Loading page redesign with PoeClaw branding
- Error pages (invalid key, expired session, container errors, Poe credit exhaustion)
- CSP headers for XSS protection
- Model icons/metadata in sidebar
- README and deployment docs
- Dockerfile optimization to reduce cold start time
- Investigate streaming + tool calling workaround
- Session expiry and renewal flow

## 6. Open Questions

1. **Does `api.poe.com/v1/models` return a stable user/account ID?** If yes, use it for DO ID instead of key hash (solves key rotation problem).
2. **Can OpenClaw run in 1 GiB RAM?** Need to validate `basic` instance type works. Fallback: `standard-1` at higher cost.
3. **Streaming + tool calling on Poe:** Is this fixed? If not, non-streaming MVP is the safe path.
4. **Poe model name discovery:** Should we hardcode models or dynamically populate from the `/v1/models` response at login?

## 7. Risk Matrix

| Risk | Severity | Likelihood | Mitigation |
|------|----------|------------|------------|
| Cold start UX (1-2 min) | HIGH | CERTAIN | Good loading UI, Dockerfile optimization |
| Tool calling + streaming breaks | HIGH | HIGH | Non-streaming MVP, follow up with Poe |
| OpenClaw won't run on 1 GiB | MEDIUM | MEDIUM | Fall back to standard-1 |
| Key rotation orphans data | MEDIUM | LOW | Use stable Poe user ID for DO ID |
| 100-user account cap | LOW | LOW | basic instances push to 400; sufficient for v1 |
| Poe API rate limit (500 RPM) | LOW | LOW | Backoff logic, mostly chat-only use |
