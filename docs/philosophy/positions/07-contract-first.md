# Position 07: Contract/API-First Testing

**Author:** Contract Testing Advocate
**Date:** 2026-02-15
**Position:** Define the API contract first, then test against it

---

## Core Thesis

PoeClaw is a *gateway* — its entire value proposition is mediating between browser clients, the Poe API, Cloudflare's sandbox infrastructure, and the OpenClaw runtime. The correctness of a gateway is determined exclusively by whether it honors the promises it makes at its boundaries. Therefore, the primary testing discipline for this project should be defining explicit, versioned API contracts at each boundary and writing tests that verify adherence to those contracts — not testing internal implementation details that can (and should) change freely.

---

## Key Arguments

### 1. Gateway Architecture Demands Interface-First Thinking

PoeClaw has at least five distinct integration boundaries:

| Boundary | Consumer | Provider |
|----------|----------|----------|
| Browser → Worker HTTP API | Chat UI, Login page | Hono routes (`/api/auth/*`, `/api/admin/*`, `/api/status`) |
| Browser → Worker SSE stream | `useChat` hook | `/v1/chat/completions` proxy |
| Worker → Poe API | Session auth module | `api.poe.com/v1/models`, `/v1/chat/completions` |
| Worker → Sandbox API | Process manager, sync | `sandbox.startProcess()`, `sandbox.containerFetch()`, `sandbox.wsConnect()` |
| Worker → R2 Storage | Sync module | Rclone via `sandbox.exec()`, R2 bucket bindings |

Each boundary is a *contract*. When the chat UI sends `POST /api/auth/login` with `{ poe_api_key: "..." }`, it expects a specific response shape, specific status codes, specific cookie behavior. When the worker calls `api.poe.com/v1/models`, it expects a specific JSON schema. These expectations exist whether we write them down or not. Contract-first testing makes them explicit and testable.

A unit test on the `validatePoeKey()` function tells you the function works. A contract test on `POST /api/auth/login` tells you the *system* works from the consumer's perspective. In a gateway, only the latter matters to users.

### 2. Consumer-Driven Contracts Protect Against Multi-Tenant Regression

The PoeClaw transformation introduces multi-tenancy: per-user Durable Objects, session-scoped sandbox resolution, namespaced R2 paths. This multiplies the contract surface. A request from User A must never leak data from User B's sandbox. A session cookie from User A must never resolve to User B's Durable Object.

These are *contract violations*, not implementation bugs. They cannot be reliably caught by unit-testing individual functions because the invariant spans the full request lifecycle: cookie → session verification → user hash → DO resolution → sandbox isolation → R2 namespacing. Contract tests that exercise the full boundary — "given this session cookie, I get back only this user's data" — are the natural expression of this requirement.

Consider what happens when someone refactors the session module. Unit tests on the old module pass (because they're deleted or rewritten). Unit tests on the new module pass (because they test the new implementation). But if the cookie format changed subtly, the browser client breaks silently. A contract test catches this immediately because it tests the *promise*, not the *mechanism*.

### 3. The WebSocket and SSE Protocols Are Contract-Dense

The existing WebSocket proxy (`src/index.ts:283-429`) performs bidirectional message relay with error transformation. Messages from the container have their error strings rewritten before reaching the client. Close codes are propagated. The planned SSE streaming for chat completions will have its own protocol: chunked `data:` lines, `[DONE]` sentinel, specific JSON shapes per chunk.

These are wire protocols — they *are* contracts. Testing them as contracts (expected input → expected output at the boundary) is more natural and more valuable than testing the relay implementation internals. If someone replaces the WebSocket relay with a different approach, every contract test should still pass, because the *client's experience* hasn't changed.

Specific protocol contracts that need definition:

- **SSE stream shape**: Each `data:` line must contain `{"choices":[{"delta":{"content":"..."}}]}` matching OpenAI's streaming format
- **Error transformation**: `gateway token missing/mismatch` must become a user-friendly redirect message
- **Close code propagation**: WebSocket close code 1000 from container must yield 1000 to client
- **Cold start behavior**: `/api/status` must return `{"ok":false,"status":"not_running"}` before container boot, and `{"ok":true,"status":"running"}` after

### 4. Poe API Integration Has Known Sharp Edges That Need Contract Pinning

The design document explicitly identifies Poe API incompatibilities: non-standard model names (`Claude-Sonnet-4.5` vs `claude-sonnet-4-5`), silent failures on tool calling + streaming, silently ignored `response_format`. These are places where the *contract we expect* diverges from *what the API actually does*.

Contract tests against the Poe API boundary serve dual purposes:

1. **Provider contract tests** verify our assumptions about Poe's behavior. When Poe changes (fixes streaming, adds models, changes rate limiting), these tests tell us immediately.
2. **Consumer contract tests** verify that our worker correctly translates Poe's responses into the OpenAI-compatible format our UI expects.

Without explicit contracts here, we're relying on manual discovery of breakage. With contracts, the CI pipeline surfaces it automatically.

### 5. Session Cookie Contract Is a Security Boundary

The authentication flow (`POST /api/auth/login` → HMAC session cookie → encrypted key in DO storage) is a security-critical contract. The design specifies:

- Cookie attributes: `HttpOnly; Secure; SameSite=Lax; Max-Age=86400`
- Rate limiting: 10 attempts/IP/minute
- Key display: `***...last4` only
- Timing-safe comparison

These are testable contract properties. A contract test can verify that a valid login returns a cookie with the correct attributes, that an invalid key returns 401 without setting a cookie, that 11 rapid requests from the same IP yield 429. These tests are more valuable than unit tests on the HMAC function because they test the *security promise* as experienced by an attacker, not just the correctness of a cryptographic primitive.

---

## Counterarguments and Rebuttals

### Against TDD Purists: "Contracts are just a subset of TDD"

**Their argument:** Contract tests are just a specific kind of test. TDD already covers this — write the test first, then implement. Red-green-refactor naturally produces correct interfaces.

**Rebuttal:** TDD says *write a test first*. It does not say *which* test, or *at what level*. In practice, TDD practitioners start with the smallest unit — a function, a class method — and work outward. This produces excellent function-level coverage but can miss integration-level contract violations.

The critical distinction is *who defines the test*. In TDD, the implementer writes tests that express their understanding of requirements. In consumer-driven contract testing, the *consumer* defines what they need, and the provider must satisfy it. For a gateway, these perspectives diverge. The implementer might TDD a `parsePoeModels()` function that correctly parses the current Poe response format. But the consumer contract says "the `/api/models` endpoint must return `[{id: string, name: string}]`" — which survives any refactoring of the parse logic.

TDD and contracts are complementary, not competing. Use TDD for implementation correctness. Use contracts for interface stability. But if you must choose one discipline for a gateway, choose contracts — because the interfaces *are* the product.

### Against Type Advocates: "Hono already gives type-safe routes"

**Their argument:** Hono's typed routes already define the contract. `c.json<DeviceListResponse>(data)` ensures the response matches the type. TypeScript catches contract violations at compile time. Adding contract tests is redundant.

**Rebuttal:** Types are necessary but insufficient. They address three specific gaps:

1. **Types don't cross the wire.** TypeScript types are erased at runtime. The browser client doesn't run TypeScript — it sends HTTP requests and parses JSON. A type says `DeviceListResponse` has a `pending` field. A contract test verifies that the actual HTTP response body, as bytes on the wire, contains a `pending` field with the correct shape. Types prevent the *author* from making mistakes; contracts prevent the *system* from making mistakes.

2. **Types can't express behavioral contracts.** "When the session cookie is expired, return 401" is a contract. "When the Poe API returns 429, retry with backoff and surface a user-friendly error" is a contract. "The SSE stream must end with `data: [DONE]`" is a contract. None of these can be expressed in TypeScript's type system. They require runtime verification.

3. **Types don't prevent regression across deployments.** If someone changes the `DeviceListResponse` type and updates all the callsites, TypeScript is happy. But every deployed client that cached the old response shape is now broken. A contract test against the *published* contract (not the current type) catches this because it tests the *promise made to existing consumers*.

Types and contracts are complementary. Use types for compile-time safety within the codebase. Use contracts for runtime safety across the wire and across time.

### Against Integration Testers: "Contracts test interfaces, not behavior"

**Their argument:** A contract test says "this endpoint returns 200 with this shape." An integration test says "when the user logs in, a sandbox starts, the config is patched, and chat works end-to-end." Contracts test the surface; integration tests test the substance.

**Rebuttal:** This is a real tension, and I partly concede the point. Contract tests alone are insufficient for a system with complex internal orchestration. The gateway startup sequence (find existing process → start if needed → wait for port → inject env vars) involves real behavioral complexity that pure contract tests won't cover.

However, I argue that for PoeClaw, the *majority of the valuable test surface* is at the contract level:

- **80% of bugs users experience are contract violations**: wrong status code, missing field, malformed SSE chunk, broken cookie. These are the bugs that break the chat UI, cause the login to fail silently, or leak data between users.
- **20% of bugs are behavioral**: wrong startup sequence, race conditions in sandbox resolution, R2 sync ordering. These warrant targeted integration tests.

The 80/20 split means contracts should be the *primary* discipline, supplemented by integration tests for complex orchestration. Not the other way around.

Furthermore, well-designed contracts *do* test behavior indirectly. A contract that says "after `POST /api/auth/login` with a valid key, subsequent requests with the returned cookie to `/v1/chat/completions` must return a streaming response" — this implicitly tests that login, session creation, sandbox startup, config patching, and chat routing all work. The contract doesn't care *how* they work, only that the end-to-end promise is kept.

### Against Pragmatists: "Too much ceremony for a small project"

**Their argument:** PoeClaw is a small team, maybe one developer. Writing formal API contracts, maintaining schema files, running contract test suites — this is enterprise overhead that slows down a project targeting 10-50 users.

**Rebuttal:** This is the strongest counterargument, and I take it seriously. Here is my honest assessment:

**What costs more than it's worth:**
- Full Pact-style consumer-driven contract infrastructure with a broker
- OpenAPI specification maintained as a separate YAML file that must be kept in sync
- Contract tests for internal-only interfaces (e.g., the sync module's internal functions)

**What is lightweight and high-value:**
- A single test file per boundary (5 files total) with request-response pairs
- Response shape assertions using the TypeScript types already defined in the codebase
- Snapshot-style contract tests: "this request produces this response shape" stored as fixtures
- Running these in CI on every push (~30 seconds of additional test time)

The ceremony scales with the tool choice, not the philosophy. Contract-first testing for PoeClaw means:

```typescript
// src/__tests__/contracts/auth.contract.test.ts
describe('POST /api/auth/login', () => {
  it('returns session cookie on valid key', async () => {
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ poe_api_key: 'valid-test-key' }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly.*Secure.*SameSite=Lax/)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, models: expect.any(Array) })
  })

  it('returns 401 on invalid key', async () => {
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ poe_api_key: 'invalid' }),
    })
    expect(res.status).toBe(401)
    expect(res.headers.has('set-cookie')).toBe(false)
  })
})
```

This is *not* enterprise ceremony. It is straightforward Vitest. The philosophical commitment is simply: write *these* tests *first*, before writing the implementation. That's the entire ceremony.

---

## Specific Contracts for This Project

### Contract 1: Authentication Boundary

```
POST /api/auth/login
  Request:  { poe_api_key: string }
  Success:  200, Set-Cookie: session=<token>; HttpOnly; Secure; SameSite=Lax; Max-Age=86400
            Body: { ok: true, user: { display: "***...last4" }, models: [{id, name}] }
  Invalid:  401, No Set-Cookie
            Body: { ok: false, error: "invalid_key" }
  Rate:     429 after 10 attempts/IP/min
            Body: { ok: false, error: "rate_limited", retry_after: number }

POST /api/auth/logout
  Request:  Cookie: session=<token>
  Success:  200, Set-Cookie: session=; Max-Age=0
            Body: { ok: true }
```

### Contract 2: Gateway Status

```
GET /api/status
  No Auth Required
  Running:      200 { ok: true,  status: "running", processId: string }
  Starting:     200 { ok: false, status: "not_running" }
  Error:        200 { ok: false, status: "not_responding", error: string }
```

### Contract 3: Chat Completions Proxy

```
POST /v1/chat/completions
  Request:  Cookie: session=<token>
            Body: { model: string, messages: [{role, content}], stream?: boolean }
  Auth:     401 if no/invalid session
  No Container: 503 { error: { message: "Container starting", type: "service_unavailable" } }
  Non-streaming: 200 { id, object: "chat.completion", choices: [{message: {role, content}}] }
  Streaming: 200, Content-Type: text/event-stream
    data: {"id":"...","choices":[{"delta":{"role":"assistant"}}]}
    data: {"id":"...","choices":[{"delta":{"content":"Hello"}}]}
    ...
    data: [DONE]
```

### Contract 4: Device Management (Admin)

```
GET /api/admin/devices
  Auth:     Session cookie required
  Success:  200 { pending: PendingDevice[], paired: PairedDevice[] }
  PendingDevice: { requestId: string, deviceId: string, ts: number, displayName?: string, platform?: string }
  PairedDevice:  { deviceId: string, createdAtMs: number, approvedAtMs: number, displayName?: string }

POST /api/admin/devices/:requestId/approve
  Success:  200 { success: true, requestId: string, message: string }
  NotFound: 404 { success: false, error: "device_not_found" }

POST /api/admin/devices/approve-all
  Success:  200 { approved: string[], failed: [{requestId, success: false, error?}] }
```

### Contract 5: Storage/Sync

```
GET /api/admin/storage
  Success:  200 { configured: boolean, lastSync?: string, missing?: string[] }

POST /api/admin/storage/sync
  Success:  200 { success: true, lastSync: string }
  Failed:   200 { success: false, error: string, details?: string }
  Not Configured: 200 { success: false, error: "not_configured", missing: string[] }
```

### Contract 6: Multi-Tenant Isolation (Cross-Cutting)

```
INVARIANT: Request with User A's session cookie MUST NEVER return data from User B's sandbox.
  - GET /api/admin/devices with session_A returns devices from sandbox_A only
  - POST /v1/chat/completions with session_A routes to container_A only
  - R2 sync for session_A writes to users/{hash_A}/ only

INVARIANT: Expired session cookies MUST return 401, never a stale response.
  - Any authenticated endpoint with expired cookie → 401
  - No partial data, no cached responses from previous session
```

### Contract 7: WebSocket Proxy (Legacy/CDP)

```
WS /ws
  Upgrade:  101 Switching Protocols
  Relay:    Messages from client forwarded verbatim to container
  Error Transform: Container error "gateway token missing" → user-friendly message
  Close:    Container close code propagated to client

WS /cdp?secret=<CDP_SECRET>
  Auth:     403 if secret missing/invalid
  Upgrade:  101 Switching Protocols
  Protocol: Chrome DevTools Protocol JSON-RPC
  Request:  { id: number, method: "Domain.command", params?: {} }
  Response: { id: number, result?: {}, error?: { code: number, message: string } }
  Events:   { method: "Domain.event", params?: {} }
```

---

## Proposed Rules

### Rule 1: Define Before Implement

Before writing any new endpoint or modifying an existing one, write the contract test first. The contract specifies: HTTP method, path, request shape, response shape per status code, required headers (including cookies), and error cases. The implementation is done when the contract tests pass.

### Rule 2: Contracts Are Versioned Promises

Once a contract test is green in CI, changing the response shape requires updating the contract *explicitly*. This forces a conscious decision: "I am changing the promise I made to consumers." The diff is reviewable. The breakage is visible.

### Rule 3: One Contract File Per Boundary

Organize contract tests by boundary, not by feature:

```
src/__tests__/contracts/
  auth.contract.test.ts        # Authentication boundary
  status.contract.test.ts      # Gateway status
  chat.contract.test.ts        # Chat completions proxy
  devices.contract.test.ts     # Device management
  storage.contract.test.ts     # R2 storage/sync
  ws.contract.test.ts          # WebSocket proxy
  isolation.contract.test.ts   # Multi-tenant isolation invariants
```

### Rule 4: Contracts Use Hono's Test Client

Use Hono's built-in `app.request()` for contract tests. No need for external HTTP servers or Pact brokers. Mock the sandbox and external APIs at the boundary, not inside the implementation:

```typescript
// Mock the EXTERNAL boundary (Poe API, Sandbox), test the INTERNAL contract
const app = createApp({ sandbox: mockSandbox, env: testEnv })
const res = await app.request('/api/auth/login', { ... })
// Assert on the response — the CONTRACT
```

### Rule 5: Contract Tests Run First in CI

Contract tests should execute before unit tests in CI. If a contract is broken, nothing else matters — the system is failing its consumers. Unit tests can pass perfectly while a contract is violated (e.g., a type change that ripples correctly through the implementation but breaks the wire format).

### Rule 6: No Contract Tests for Internal Interfaces

Do not write contract tests for module-to-module interactions within the worker (e.g., how `sync.ts` calls `r2.ts`). Contracts are for *external* boundaries — where a different system (browser, Poe API, sandbox container) is on the other side. Internal module boundaries are better served by types and, where necessary, unit tests.

### Rule 7: Maintain Honest Overhead Assessment

The contract test suite for this project should be:
- **7 contract files** (one per boundary above)
- **~30-50 test cases** total across all boundaries
- **< 60 seconds** CI execution time
- **Updated only when the API changes** — not on every internal refactor

If the contract suite grows beyond 100 tests or takes > 2 minutes, something has gone wrong — either contracts are being written for internal interfaces (violating Rule 6) or tests are too granular. Refactor the suite, don't add more.

---

## Honest Limitations

1. **Contract tests won't catch race conditions.** Two users logging in simultaneously, sandbox resolution contention, R2 sync conflicts — these require different testing approaches (load testing, chaos testing, or carefully designed integration tests).

2. **Contract tests require good mocks.** The contract test for `POST /api/auth/login` needs a mock Poe API that returns realistic responses. If the mock diverges from reality, the contract test gives false confidence. Provider contract tests against the *real* Poe API (run periodically, not on every push) mitigate this.

3. **The maintenance burden is real but bounded.** Every API change requires updating both the implementation and the contract test. This is deliberate friction — it forces you to think about backwards compatibility. But for a solo developer moving fast, it can feel like paperwork. The mitigation is Rule 6: only contract-test external boundaries, and keep the suite small.

4. **Contracts test shape, not semantics.** A contract test can verify that `/v1/chat/completions` returns a streaming response with the right JSON shape. It cannot verify that the *content* of the response is a sensible AI completion. For that, you need end-to-end tests with real (or realistic) LLM responses.

5. **Not all boundaries are equal.** The CDP protocol has 50+ commands. Writing a contract test for each is not worth the investment — the CDP shim is a compatibility layer, not a core product surface. Prioritize contracts for the authentication, chat, and multi-tenant isolation boundaries.

---

## Summary

PoeClaw is a gateway. Its product is its interfaces. Contract-first testing is not an enterprise indulgence — it is the natural testing discipline for a system whose value is entirely in the promises it makes to its consumers. Define the contracts. Test them first. Let the implementation change freely behind them.
