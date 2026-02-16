# Bug: Login page never shown

**Date:** 2026-02-15
**Status:** Fixed

## Symptoms

The PoeClaw login page (where users enter their Poe API key) was never displayed in any configuration:

- **DEV_MODE=true**: Showed "waiting for poeclaw to load" then OpenClaw's own UI. Login was completely bypassed.
- **DEV_MODE=off**: Redirect loop (401/302). SPA HTML never reached the browser.

## Root Causes

### 1. `/api/auth/me` faked authentication in DEV_MODE

**File:** `src/routes/auth.ts` (former lines 120-128)

The `GET /api/auth/me` endpoint had a DEV_MODE early-return that told the SPA the user was already authenticated:

```typescript
if (c.env.DEV_MODE === 'true') {
  return c.json({
    authenticated: true,     // ← Told SPA user was already logged in
    userHash: 'dev-user',
    keyLast4: '0000',
    models: [{ id: 'default', name: 'Default Model' }],
  });
}
```

The SPA flow (`src/client/App.tsx`):
1. App mounts → `fetch('/api/auth/me')`
2. Response says `authenticated: true` → SPA sets session → shows ChatPage
3. LoginPage is **never rendered**

### 2. ASSETS.fetch() was fragile

**Files:** `src/routes/public.ts`, `src/index.ts`

Two issues combined:

- **No try-catch** around `ASSETS.fetch()` — if it threw, the request fell through silently to the next handler (the catch-all proxy, which served the container's own UI).
- **Requesting `/` instead of `/index.html`** — with `html_handling: "auto-trailing-slash"` in wrangler config, ASSETS could return a 3xx redirect for the root path, causing a redirect loop.

### Contributing: Catch-all proxy serves container UI

**File:** `src/index.ts` (catch-all `app.all('*', ...)`)

Once the OpenClaw container started, the catch-all proxy forwarded `GET /` to the container, which served its own web UI. If the public route or session middleware failed to serve the SPA, users saw the container UI (no login) or a redirect loop.

## Investigation Method

Five parallel investigation agents explored:

1. **SPA routing agent**: Found `/api/auth/me` DEV_MODE bypass fakes authentication, preventing LoginPage from rendering.
2. **ASSETS binding agent**: Found `ASSETS.fetch()` with `/` path could trigger `auto-trailing-slash` redirects; no error handling.
3. **DEV_MODE proxy agent**: Found catch-all proxy serves container UI, loading.html flow replaces SPA.
4. **Hono routing agent**: Confirmed no Hono routing bug; the issue was ASSETS.fetch() failure causing silent fall-through.
5. **Miniflare agent**: Confirmed miniflare's ASSETS should return 200 for `/` when `index.html` exists, but redirect behavior depends on config.

## Fixes Applied

### Fix 1: Remove DEV_MODE bypass from `/api/auth/me`

**File:** `src/routes/auth.ts`

Removed the DEV_MODE early-return block. The endpoint now always checks for a valid session cookie, regardless of DEV_MODE. Without a cookie, it returns `{ authenticated: false }` with 401, which causes the SPA to show the login page.

### Fix 2: Harden ASSETS.fetch() in public route and session middleware

**Files:** `src/routes/public.ts`, `src/index.ts`

- Changed `ASSETS.fetch()` to request `/index.html` explicitly (avoids `auto-trailing-slash` redirect)
- Wrapped in try-catch — if ASSETS fails, returns 500 with helpful message ("SPA not available. Run: make build")
- Removed debug `console.log` statements from session middleware

## Tests Added

### `src/routes/auth.test.ts`

- "returns 401 without session cookie even in DEV_MODE" — verifies DEV_MODE cannot bypass login
- "returns session info with valid cookie in DEV_MODE" — verifies authenticated sessions work in DEV_MODE
- "returns 401 with expired session cookie" — verifies expired sessions are rejected
- "POST /api/auth/login creates session that GET /api/auth/me accepts" — full login→me flow

### `src/routes/public.test.ts` (new file)

- "GET / returns 200 with HTML content" — SPA shell is served
- "GET / requests /index.html explicitly from ASSETS" — avoids redirect
- "GET / returns 500 if ASSETS binding fails" — error is caught, not silent
- "GET / does not redirect" — no 3xx responses
- "GET /assets/* serves static files" — passthrough works
- "GET /sandbox-health returns health check JSON" — health endpoint works
- "Session middleware serves SPA for unauthenticated HTML requests" — no redirect loop

## Lessons Learned

1. **DEV_MODE should never fake auth status.** Dev convenience shortcuts in auth endpoints mask real bugs and prevent testing the actual login flow. DEV_MODE can skip sandbox auth (session middleware), but must not fake API responses that drive SPA navigation.

2. **ASSETS.fetch() needs defensive coding.** Always request explicit filenames (`/index.html`) instead of paths that may trigger server-side redirects. Always wrap in try-catch since the binding may not be available (pre-build, misconfiguration).

3. **Silent fall-through is the enemy of debugging.** When a route handler fails silently (no try-catch, error swallowed), the request falls through to the next handler, producing confusing behavior. Explicit error responses are always better than silent fall-through.
