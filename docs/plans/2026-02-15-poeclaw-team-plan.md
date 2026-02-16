# PoeClaw Team Implementation Plan

> **MVP Goal:** Give a teammate a URL, they paste their Poe API key, and they can chat with AI models through their own sandboxed OpenClaw instance.

## Team Structure (13 people)

### Leadership (3)

| Role | Name | Responsibility |
|------|------|---------------|
| Engineering Lead | `eng-lead` | Architecture decisions, code review, unblocking technical issues, quality gates |
| Product Lead | `product-lead` | MVP scope, user flow validation, acceptance criteria, prioritization |
| Scrum Master | `scrum-master` | Task breakdown, assignment, dependency tracking, sprint coordination |

### Engineering (10)

| Role | Name | Focus Area |
|------|------|-----------|
| Backend Engineer 1 | `backend-1` | Auth system (Poe validation, session management) |
| Backend Engineer 2 | `backend-2` | Multi-tenant Durable Objects, sandbox resolution |
| Backend Engineer 3 | `backend-3` | Gateway integration (env overrides, process lifecycle) |
| Backend Engineer 4 | `backend-4` | API routes (auth, status, chat proxy) |
| Frontend Engineer 1 | `frontend-1` | Login page (dark theme, key input, validation UX) |
| Frontend Engineer 2 | `frontend-2` | Chat page (message list, input bar, SSE streaming) |
| Frontend Engineer 3 | `frontend-3` | Chat hooks (useChat, useGatewayStatus), model selector |
| Infrastructure Engineer | `infra` | Wrangler config, Dockerfile, start-openclaw.sh, R2 namespacing |
| Security Engineer | `security` | Session crypto, key encryption, CSP, rate limiting, cookie security |
| QA/Test Engineer | `qa` | Test harness, contract tests, property tests, CI validation |

---

## Phase 0: Project Setup (Pre-requisite)

**Owner:** `infra` + `eng-lead`
**Duration:** Quick
**Outcome:** Project renamed, wrangler configured for multi-tenancy

| Task | Owner | Files | Description |
|------|-------|-------|-------------|
| 0.1 Rename project | `infra` | `package.json`, `wrangler.jsonc` | Change name from `moltbot-sandbox` to `poeclaw` |
| 0.2 Configure multi-tenant containers | `infra` | `wrangler.jsonc` | `instance_type: "basic"`, `max_instances: 50` |
| 0.3 Add PoeClaw types | `backend-1` | `src/types.ts` | `PoeSessionUser`, `PoeModel`, update `AppEnv.Variables` |

**Gate:** `npm run typecheck` passes

---

## Phase 1: Auth & Session Core

**Owner:** `backend-1` + `security`
**Duration:** Largest phase
**Outcome:** User pastes key, gets validated, session cookie issued, per-user DO resolved

| Task | Owner | Files | Depends On | Description |
|------|-------|-------|-----------|-------------|
| 1.1 Poe API key validation | `backend-1` | `src/auth/poe.ts`, `src/auth/poe.test.ts` | 0.3 | Validate key against `api.poe.com/v1/models`, extract model list |
| 1.2 Session token management | `security` | `src/auth/session.ts`, `src/auth/session.test.ts` | 0.3 | HMAC-SHA256 signed tokens, 24h expiry, cookie helpers |
| 1.3 API key encryption | `security` | `src/auth/session.ts` (same file) | — | AES-GCM encrypt/decrypt for DO storage, random IV |
| 1.4 Auth routes (login/logout/me) | `backend-4` | `src/routes/auth.ts` | 1.1, 1.2, 1.3 | `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` |
| 1.5 Session middleware | `backend-2` | `src/index.ts` | 1.2 | Extract cookie, verify token, resolve per-user sandbox DO |
| 1.6 Per-user sandbox resolution | `backend-2` | `src/index.ts` | 1.5 | `getSandbox(env.Sandbox, userHash, options)` with `sleepAfter: "1h"` |
| 1.7 Update auth exports | `backend-1` | `src/auth/index.ts` | 1.1, 1.2 | Export new modules from auth barrel |
| 1.8 Rate limiting | `security` | `src/routes/auth.ts` | 1.4 | 10 attempts/IP/minute on login endpoint |

**Gate:** Can POST a Poe API key, get a session cookie, and have `GET /api/auth/me` return user info. `npm test` passes.

---

## Phase 2: Poe Provider Integration

**Owner:** `backend-3` + `infra`
**Duration:** Medium
**Outcome:** Container boots with Poe as the LLM provider, chat works via OpenClaw's built-in UI

| Task | Owner | Files | Depends On | Description |
|------|-------|-------|-----------|-------------|
| 2.1 Env overrides in buildEnvVars | `backend-3` | `src/gateway/env.ts`, `src/gateway/env.test.ts` | — | Add `overrides` parameter for per-user env vars |
| 2.2 Process lifecycle with overrides | `backend-3` | `src/gateway/process.ts` | 2.1 | Pass `envOverrides` through `ensureMoltbotGateway` |
| 2.3 Poe provider in start-openclaw.sh | `infra` | `start-openclaw.sh` | — | Detect `POE_API_KEY`, create Poe provider config, enable HTTP chat completions, skip device pairing |
| 2.4 Wire per-user key to container | `backend-2` | `src/index.ts` | 1.6, 2.2 | Decrypt stored key, pass as `POE_API_KEY` env override on container boot |

**Gate:** Login → container starts with Poe provider → can chat via OpenClaw's built-in Control UI through the Worker proxy. `npm test` passes.

---

## Phase 3: Per-User R2 Persistence

**Owner:** `backend-3` + `infra`
**Duration:** Small
**Outcome:** Each user's conversations and config persist across container restarts, isolated from other users

| Task | Owner | Files | Depends On | Description |
|------|-------|-------|-----------|-------------|
| 3.1 R2 path namespacing in sync.ts | `backend-3` | `src/gateway/sync.ts`, `src/gateway/sync.test.ts` | — | Add `userPrefix` param: `users/{userHash}/openclaw/` |
| 3.2 R2 path namespacing in shell | `infra` | `start-openclaw.sh` | — | `R2_USER_PREFIX` env var for rclone paths |
| 3.3 Wire user prefix through | `backend-2` | `src/index.ts`, `src/routes/api.ts` | 3.1, 3.2 | Pass `R2_USER_PREFIX` in env overrides and sync calls |

**Gate:** Two different users have isolated data. Container restart preserves conversations. `npm test` passes.

---

## Phase 4: Chat Frontend

**Owner:** `frontend-1` + `frontend-2` + `frontend-3`
**Duration:** Large
**Outcome:** Full Poe-style dark-themed chat experience

| Task | Owner | Files | Depends On | Description |
|------|-------|-------|-----------|-------------|
| 4.1 Gateway status hook | `frontend-3` | `src/client/hooks/useGatewayStatus.ts` | — | Poll `/api/status`, detect booting/running/error |
| 4.2 SSE chat hook | `frontend-3` | `src/client/hooks/useChat.ts` | — | Stream `/v1/chat/completions`, parse SSE, manage message state |
| 4.3 Styled login page | `frontend-1` | `src/client/pages/LoginPage.tsx`, `LoginPage.css` | — | Dark theme, key input, "Get your API key" link, validation UX |
| 4.4 Chat page with sidebar | `frontend-2` | `src/client/pages/ChatPage.tsx`, `ChatPage.css` | 4.1, 4.2 | Sidebar (model selector, new chat, logout), message list, input bar, boot loading state |
| 4.5 App routing | `frontend-1` | `src/client/App.tsx`, `App.css` | 4.3, 4.4 | Session check → login or chat, global CSS variables |
| 4.6 Vite config update | `infra` | `vite.config.ts` | — | Change `base` from `/_admin/` to `/` |
| 4.7 Remove old AdminPage | `frontend-1` | `src/client/pages/AdminPage.tsx`, `src/routes/index.ts` | 4.5 | Delete AdminPage, remove route export |

**Gate:** Full login → boot loading → chat flow works end-to-end in browser. `npm run build` succeeds.

---

## Phase 5: Polish & Harden

**Owner:** `security` + `qa` + `infra`
**Duration:** Medium
**Outcome:** Production-ready with security headers, clean tests, and PoeClaw branding

| Task | Owner | Files | Depends On | Description |
|------|-------|-------|-----------|-------------|
| 5.1 CSP and security headers | `security` | `src/index.ts` | — | `X-Content-Type-Options`, `X-Frame-Options`, `Content-Security-Policy` |
| 5.2 Update public routes | `backend-4` | `src/routes/public.ts` | — | Health check says `poeclaw`, add SPA serving at `/` |
| 5.3 Loading page branding | `frontend-2` | `src/assets/loading.html` | — | Replace "Moltbot" with "PoeClaw" branding |
| 5.4 Full test suite pass | `qa` | Various | All phases | Run vitest, fix failures, add missing contract tests for auth boundary |
| 5.5 Lint and typecheck clean | `qa` | Various | 5.4 | `npm run lint && npm run typecheck` with zero errors |
| 5.6 Build and deploy verification | `infra` | — | 5.5 | `npm run build`, `wrangler deploy --dry-run`, verify dist output |
| 5.7 Add secrets to Cloudflare | `infra` | — | 5.6 | `wrangler secret put SESSION_SECRET`, `wrangler secret put ENCRYPTION_SECRET` |

**Gate:** `npm run typecheck && npm run lint && npm test && npm run build` all pass. Dry-run deploy succeeds.

---

## MVP Definition of Done

A teammate can:

1. Visit the PoeClaw URL in their browser
2. See a dark-themed login page
3. Paste their Poe API key from `poe.com/api_key`
4. Key is validated against the Poe API
5. Their personal sandbox container boots (with loading indicator)
6. They can chat with AI models (Claude Sonnet 4.5, GPT 5.2, Gemini 3 Pro)
7. They can switch models via the sidebar
8. Their conversations persist across page refreshes
9. They can log out and their session is cleared
10. Another teammate can log in simultaneously with their own key and get isolated data

---

## Dependency Graph

```
Phase 0 ─────────────────────────────────────────────────
  0.1 Rename ──┐
  0.2 Config ──┤
  0.3 Types ───┤
               │
Phase 1 ───────┼──────────────────────────────────────────
               ├── 1.1 Poe validation ──┐
               ├── 1.2 Session tokens ──┼── 1.4 Auth routes ── 1.8 Rate limit
               ├── 1.3 Key encryption ──┘         │
               │                                   │
               └── 1.5 Session middleware ── 1.6 Per-user DO
                                                   │
Phase 2 ───────────────────────────────────────────┤
  2.1 Env overrides ── 2.2 Process overrides ──────┤
  2.3 start-openclaw.sh ──────────────────── 2.4 Wire key
                                                   │
Phase 3 ───────────────────────────────────────────┤
  3.1 sync.ts namespacing ─────────────────── 3.3 Wire prefix
  3.2 Shell namespacing ───────────────────────┘
                                                   │
Phase 4 (parallel with Phase 2-3 for frontend) ───┤
  4.1 Status hook ────┐                            │
  4.2 Chat hook ──────┼── 4.4 ChatPage ─┐          │
  4.3 LoginPage ──────┼─────────────────┼── 4.5 App routing ── 4.7 Cleanup
  4.6 Vite config ────┘                 │
                                        │
Phase 5 ────────────────────────────────┴──────────
  5.1 CSP ─────────┐
  5.2 Public routes ┤
  5.3 Branding ─────┼── 5.4 Tests ── 5.5 Lint ── 5.6 Build ── 5.7 Secrets
```

## Parallel Work Streams

**Stream A (Backend):** Phase 0 → Phase 1 → Phase 2 → Phase 3
**Stream B (Frontend):** Phase 0 → Tasks 4.1-4.3 (no backend dependency) → Phase 4 remaining (needs Phase 1 auth)
**Stream C (Infra):** Phase 0 → Tasks 2.3, 3.2, 4.6 (independent shell/config work)
**Stream D (Security):** Tasks 1.2, 1.3, 1.8, 5.1 (auth crypto + hardening)
**Stream E (QA):** Write test harnesses during Phase 1-3, full validation in Phase 5

Frontend engineers can start building UI components (hooks, pages) in parallel with backend auth work. They converge at Phase 4 task 4.5 (App routing) which needs the auth API to be functional.

---

## Risk Mitigations

| Risk | Mitigation | Owner |
|------|-----------|-------|
| Cold start UX (1-2 min) | Boot loading indicator in ChatPage, polling via useGatewayStatus | `frontend-3` |
| Poe streaming + tool calling breaks | Ship non-streaming MVP first | `eng-lead` decision |
| OpenClaw won't fit in 1 GiB (basic) | Test early in Phase 2; fallback to standard-1 | `infra` |
| Key rotation orphans DO data | Investigate Poe user ID in `/v1/models` response | `backend-1` |
| Session token timing attacks | Use `crypto.subtle.verify` (timing-safe) | `security` |

---

## Sprint Cadence (Suggested)

- **Sprint 1:** Phase 0 + Phase 1 (auth foundation)
- **Sprint 2:** Phase 2 + Phase 3 + Phase 4 frontend hooks/pages (parallel streams)
- **Sprint 3:** Phase 4 integration + Phase 5 (polish, test, ship)

Each sprint ends with a working increment:
- Sprint 1: Login works, session established
- Sprint 2: Chat works end-to-end via built-in UI + frontend components ready
- Sprint 3: Full Poe-style UI, production-ready, deployable
