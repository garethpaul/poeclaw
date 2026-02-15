# PoeClaw Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Transform the single-tenant moltworker/OpenClaw sandbox into a multi-tenant platform where users authenticate with their Poe API key and get their own sandboxed AI agent instance.

**Architecture:** Each user pastes their POE_API_KEY, which is validated against `api.poe.com/v1/models`. A session cookie (HMAC-SHA256 signed) is issued. The Worker resolves a per-user Durable Object sandbox via `getSandbox(env.Sandbox, userHash)`. The container boots with the user's Poe key mapped as a custom OpenAI-compatible provider. Chat happens via HTTP API + SSE (not WebSocket).

**Tech Stack:** Cloudflare Workers (Hono), Durable Objects + Sandbox containers, React 19, Vite, Vitest, Poe OpenAI-compatible API

**Design doc:** `docs/plans/2026-02-15-poeclaw-design.md`

---

## Phase 1: Auth & Multi-Tenant Core

### Task 1: Rename project to PoeClaw

**Files:**
- Modify: `package.json:2` (name field)
- Modify: `wrangler.jsonc:3` (name field)

**Step 1: Update package.json name**

In `package.json`, change:
```json
"name": "moltbot-sandbox",
```
to:
```json
"name": "poeclaw",
```

**Step 2: Update wrangler.jsonc name**

In `wrangler.jsonc`, change:
```jsonc
"name": "moltbot-sandbox",
```
to:
```jsonc
"name": "poeclaw",
```

**Step 3: Commit**

```bash
git add package.json wrangler.jsonc
git commit -m "chore: rename project from moltbot-sandbox to poeclaw"
```

---

### Task 2: Update wrangler.jsonc for multi-tenancy

**Files:**
- Modify: `wrangler.jsonc:36-43` (containers block)

**Step 1: Change container config**

In `wrangler.jsonc`, replace the containers block:
```jsonc
  "containers": [
    {
      "class_name": "Sandbox",
      "image": "./Dockerfile",
      "instance_type": "standard-1",
      "max_instances": 1,
    },
  ],
```
with:
```jsonc
  "containers": [
    {
      "class_name": "Sandbox",
      "image": "./Dockerfile",
      "instance_type": "basic",
      "max_instances": 50,
    },
  ],
```

**Step 2: Verify config is valid JSON**

Run: `node -e "const fs = require('fs'); JSON.parse(fs.readFileSync('wrangler.jsonc','utf8').replace(/\/\/.*/g,'').replace(/,(\s*[}\]])/g,'$1'));" && echo "valid"`

Expected: `valid` (or use `npx wrangler deploy --dry-run` if available)

**Step 3: Commit**

```bash
git add wrangler.jsonc
git commit -m "feat: configure multi-tenant containers (basic, max 50 instances)"
```

---

### Task 3: Add PoeClaw types

**Files:**
- Modify: `src/types.ts`

**Step 1: Add new types**

In `src/types.ts`, add `POE_API_KEY` to `MoltbotEnv`, add session types, and add `SESSION_SECRET` and `ENCRYPTION_SECRET`:

Replace the entire `MoltbotEnv` interface — add these new fields alongside the existing ones:

After line 44 (`WORKER_URL?: string;`), add:
```typescript
  // PoeClaw session auth
  SESSION_SECRET?: string; // HMAC-SHA256 key for session cookies
  ENCRYPTION_SECRET?: string; // AES-GCM key for encrypting stored API keys
```

Add after the `AccessUser` interface (after line 53):

```typescript
/**
 * Poe session user (from session cookie)
 */
export interface PoeSessionUser {
  userHash: string; // SHA-256 hash used as DO ID
  keyLast4: string; // Last 4 chars of API key for display
  models: PoeModel[]; // Available models from /v1/models
  createdAt: number; // Session creation timestamp (epoch ms)
}

/**
 * Poe model from /v1/models response
 */
export interface PoeModel {
  id: string; // e.g., "Claude-Sonnet-4.5"
  name: string; // Display name
}
```

Update `AppEnv.Variables` to add `poeUser`:
```typescript
export type AppEnv = {
  Bindings: MoltbotEnv;
  Variables: {
    sandbox: Sandbox;
    accessUser?: AccessUser;
    poeUser?: PoeSessionUser;
  };
};
```

**Step 2: Verify types compile**

Run: `cd /Volumes/dev/poeclaw && npx tsc --noEmit`
Expected: No errors (or only pre-existing errors)

**Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add PoeClaw session and Poe model types"
```

---

### Task 4: Create Poe API key validation module

**Files:**
- Create: `src/auth/poe.ts`
- Create: `src/auth/poe.test.ts`

**Step 1: Write the failing test**

Create `src/auth/poe.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validatePoeApiKey } from './poe';

describe('validatePoeApiKey', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects empty key', async () => {
    const result = await validatePoeApiKey('');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/empty/i);
  });

  it('rejects key without proper prefix', async () => {
    const result = await validatePoeApiKey('not-a-poe-key');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/format/i);
  });

  it('returns models on successful validation', async () => {
    const mockResponse = {
      object: 'list',
      data: [
        { id: 'Claude-Sonnet-4.5', object: 'model' },
        { id: 'GPT-5.2', object: 'model' },
      ],
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      }),
    );

    const result = await validatePoeApiKey('pb-test-key-12345');
    expect(result.valid).toBe(true);
    expect(result.models).toHaveLength(2);
    expect(result.models![0].id).toBe('Claude-Sonnet-4.5');
  });

  it('returns invalid on 401 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      }),
    );

    const result = await validatePoeApiKey('pb-invalid-key-999');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/invalid|unauthorized/i);
  });

  it('handles network errors gracefully', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Network error')),
    );

    const result = await validatePoeApiKey('pb-test-key-12345');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/network|failed/i);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /Volumes/dev/poeclaw && npx vitest run src/auth/poe.test.ts`
Expected: FAIL — `validatePoeApiKey` not found

**Step 3: Implement the module**

Create `src/auth/poe.ts`:
```typescript
import type { PoeModel } from '../types';

export interface PoeValidationResult {
  valid: boolean;
  models?: PoeModel[];
  error?: string;
}

const POE_MODELS_URL = 'https://api.poe.com/v1/models';

/**
 * Validate a Poe API key by calling /v1/models.
 * Returns the list of available models on success.
 */
export async function validatePoeApiKey(apiKey: string): Promise<PoeValidationResult> {
  if (!apiKey || apiKey.trim() === '') {
    return { valid: false, error: 'API key is empty' };
  }

  // Poe keys typically start with "pb-" but we'll be lenient
  // and just check it's a reasonable string
  if (apiKey.length < 10 || /\s/.test(apiKey)) {
    return { valid: false, error: 'Invalid key format' };
  }

  try {
    const response = await fetch(POE_MODELS_URL, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return { valid: false, error: 'Invalid or unauthorized API key' };
      }
      return { valid: false, error: `Poe API returned ${response.status} ${response.statusText}` };
    }

    const data = (await response.json()) as { data?: Array<{ id: string; object?: string }> };
    const models: PoeModel[] = (data.data || []).map((m) => ({
      id: m.id,
      name: m.id, // Poe uses the ID as the display name
    }));

    return { valid: true, models };
  } catch (err) {
    return {
      valid: false,
      error: `Failed to reach Poe API: ${err instanceof Error ? err.message : 'Unknown error'}`,
    };
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /Volumes/dev/poeclaw && npx vitest run src/auth/poe.test.ts`
Expected: All 5 tests PASS

**Step 5: Commit**

```bash
git add src/auth/poe.ts src/auth/poe.test.ts
git commit -m "feat: add Poe API key validation module"
```

---

### Task 5: Create session management module

**Files:**
- Create: `src/auth/session.ts`
- Create: `src/auth/session.test.ts`

**Step 1: Write the failing tests**

Create `src/auth/session.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import {
  createSessionToken,
  verifySessionToken,
  hashApiKey,
  encryptApiKey,
  decryptApiKey,
} from './session';

const TEST_SESSION_SECRET = 'test-session-secret-32-chars-ok!';
const TEST_ENCRYPTION_SECRET = 'test-encrypt-secret-32-chars-ok!';

describe('hashApiKey', () => {
  it('produces a consistent hex hash', async () => {
    const hash1 = await hashApiKey('pb-test-key-12345');
    const hash2 = await hashApiKey('pb-test-key-12345');
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
  });

  it('produces different hashes for different keys', async () => {
    const hash1 = await hashApiKey('pb-key-aaa');
    const hash2 = await hashApiKey('pb-key-bbb');
    expect(hash1).not.toBe(hash2);
  });
});

describe('createSessionToken / verifySessionToken', () => {
  it('creates and verifies a valid session token', async () => {
    const payload = { userHash: 'abc123', keyLast4: '5678', models: [], createdAt: Date.now() };
    const token = await createSessionToken(payload, TEST_SESSION_SECRET);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);

    const verified = await verifySessionToken(token, TEST_SESSION_SECRET);
    expect(verified).not.toBeNull();
    expect(verified!.userHash).toBe('abc123');
    expect(verified!.keyLast4).toBe('5678');
  });

  it('rejects a tampered token', async () => {
    const payload = { userHash: 'abc123', keyLast4: '5678', models: [], createdAt: Date.now() };
    const token = await createSessionToken(payload, TEST_SESSION_SECRET);
    const tampered = token.slice(0, -4) + 'xxxx';

    const verified = await verifySessionToken(tampered, TEST_SESSION_SECRET);
    expect(verified).toBeNull();
  });

  it('rejects token signed with wrong secret', async () => {
    const payload = { userHash: 'abc123', keyLast4: '5678', models: [], createdAt: Date.now() };
    const token = await createSessionToken(payload, TEST_SESSION_SECRET);

    const verified = await verifySessionToken(token, 'wrong-secret-wrong-secret-12345');
    expect(verified).toBeNull();
  });

  it('rejects expired token (older than 24h)', async () => {
    const payload = {
      userHash: 'abc123',
      keyLast4: '5678',
      models: [],
      createdAt: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
    };
    const token = await createSessionToken(payload, TEST_SESSION_SECRET);

    const verified = await verifySessionToken(token, TEST_SESSION_SECRET);
    expect(verified).toBeNull();
  });
});

describe('encryptApiKey / decryptApiKey', () => {
  it('encrypts and decrypts a key round-trip', async () => {
    const original = 'pb-test-key-12345-secret';
    const encrypted = await encryptApiKey(original, TEST_ENCRYPTION_SECRET);
    expect(encrypted).not.toBe(original);

    const decrypted = await decryptApiKey(encrypted, TEST_ENCRYPTION_SECRET);
    expect(decrypted).toBe(original);
  });

  it('produces different ciphertext each time (random IV)', async () => {
    const original = 'pb-test-key-12345-secret';
    const encrypted1 = await encryptApiKey(original, TEST_ENCRYPTION_SECRET);
    const encrypted2 = await encryptApiKey(original, TEST_ENCRYPTION_SECRET);
    expect(encrypted1).not.toBe(encrypted2);
  });

  it('fails to decrypt with wrong secret', async () => {
    const encrypted = await encryptApiKey('pb-test-key', TEST_ENCRYPTION_SECRET);
    await expect(decryptApiKey(encrypted, 'wrong-secret-wrong-secret-12345')).rejects.toThrow();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /Volumes/dev/poeclaw && npx vitest run src/auth/session.test.ts`
Expected: FAIL — modules not found

**Step 3: Implement session module**

Create `src/auth/session.ts`:
```typescript
import type { PoeSessionUser } from '../types';

const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * SHA-256 hash of an API key, used as stable user/DO identifier.
 */
export async function hashApiKey(apiKey: string): Promise<string> {
  const data = new TextEncoder().encode(apiKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Derive a CryptoKey from a string secret for HMAC-SHA256.
 */
async function deriveHmacKey(secret: string): Promise<CryptoKey> {
  const keyData = new TextEncoder().encode(secret);
  return crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

/**
 * Create a signed session token (base64url of payload + HMAC signature).
 */
export async function createSessionToken(
  payload: PoeSessionUser,
  secret: string,
): Promise<string> {
  const payloadStr = JSON.stringify(payload);
  const payloadB64 = btoa(payloadStr);
  const key = await deriveHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return `${payloadB64}.${sigB64}`;
}

/**
 * Verify and decode a session token. Returns null if invalid or expired.
 */
export async function verifySessionToken(
  token: string,
  secret: string,
): Promise<PoeSessionUser | null> {
  try {
    const [payloadB64, sigB64] = token.split('.');
    if (!payloadB64 || !sigB64) return null;

    const key = await deriveHmacKey(secret);
    const sig = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0));
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      sig,
      new TextEncoder().encode(payloadB64),
    );
    if (!valid) return null;

    const payload: PoeSessionUser = JSON.parse(atob(payloadB64));

    // Check expiry
    if (Date.now() - payload.createdAt > SESSION_MAX_AGE_MS) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Encrypt an API key with AES-GCM for storage in DO.
 * Returns base64 string of IV (12 bytes) + ciphertext.
 */
export async function encryptApiKey(apiKey: string, secret: string): Promise<string> {
  const keyData = new TextEncoder().encode(secret.padEnd(32, '0').slice(0, 32));
  const cryptoKey = await crypto.subtle.importKey('raw', keyData, 'AES-GCM', false, ['encrypt']);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    new TextEncoder().encode(apiKey),
  );

  // Concatenate IV + ciphertext
  const combined = new Uint8Array(iv.length + new Uint8Array(ciphertext).length);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt an API key from AES-GCM encrypted base64 string.
 */
export async function decryptApiKey(encrypted: string, secret: string): Promise<string> {
  const keyData = new TextEncoder().encode(secret.padEnd(32, '0').slice(0, 32));
  const cryptoKey = await crypto.subtle.importKey('raw', keyData, 'AES-GCM', false, ['decrypt']);

  const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ciphertext);
  return new TextDecoder().decode(plaintext);
}

/**
 * Build the Set-Cookie header value for a session cookie.
 */
export function buildSessionCookie(token: string): string {
  return `poeclaw_session=${token}; HttpOnly; Secure; SameSite=Lax; Max-Age=86400; Path=/`;
}

/**
 * Build a Set-Cookie header that clears the session cookie.
 */
export function clearSessionCookie(): string {
  return 'poeclaw_session=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/';
}

/**
 * Extract the session token from a Cookie header.
 */
export function extractSessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/poeclaw_session=([^;]+)/);
  return match ? match[1] : null;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /Volumes/dev/poeclaw && npx vitest run src/auth/session.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/auth/session.ts src/auth/session.test.ts
git commit -m "feat: add HMAC session tokens and AES-GCM key encryption"
```

---

### Task 6: Create auth routes (login/logout)

**Files:**
- Create: `src/routes/auth.ts`
- Modify: `src/routes/index.ts` (add export)

**Step 1: Create auth routes**

Create `src/routes/auth.ts`:
```typescript
import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { validatePoeApiKey } from '../auth/poe';
import {
  hashApiKey,
  createSessionToken,
  encryptApiKey,
  buildSessionCookie,
  clearSessionCookie,
} from '../auth/session';

const auth = new Hono<AppEnv>();

// POST /api/auth/login - Validate Poe API key and create session
auth.post('/login', async (c) => {
  const body = await c.req.json<{ apiKey?: string }>().catch(() => ({}));
  const apiKey = body.apiKey?.trim();

  if (!apiKey) {
    return c.json({ error: 'API key is required' }, 400);
  }

  // Validate key against Poe API
  const validation = await validatePoeApiKey(apiKey);
  if (!validation.valid) {
    return c.json({ error: validation.error || 'Invalid API key' }, 401);
  }

  const sessionSecret = c.env.SESSION_SECRET;
  const encryptionSecret = c.env.ENCRYPTION_SECRET;
  if (!sessionSecret || !encryptionSecret) {
    console.error('[AUTH] Missing SESSION_SECRET or ENCRYPTION_SECRET');
    return c.json({ error: 'Server configuration error' }, 500);
  }

  // Create user identity
  const userHash = await hashApiKey(apiKey);
  const keyLast4 = apiKey.slice(-4);

  // Create session token
  const sessionPayload = {
    userHash,
    keyLast4,
    models: validation.models || [],
    createdAt: Date.now(),
  };
  const token = await createSessionToken(sessionPayload, sessionSecret);

  // Encrypt API key for DO storage
  const encryptedKey = await encryptApiKey(apiKey, encryptionSecret);

  // Store encrypted key in the user's sandbox DO storage
  const sandbox = c.get('sandbox');
  await sandbox.exec(
    `mkdir -p /tmp/poeclaw && echo '${encryptedKey}' > /tmp/poeclaw/encrypted-key`,
  );

  // Set session cookie
  return c.json(
    {
      ok: true,
      userHash,
      keyLast4,
      models: validation.models,
    },
    200,
    {
      'Set-Cookie': buildSessionCookie(token),
    },
  );
});

// POST /api/auth/logout - Clear session
auth.post('/logout', (c) => {
  return c.json(
    { ok: true },
    200,
    {
      'Set-Cookie': clearSessionCookie(),
    },
  );
});

// GET /api/auth/me - Return current session info (if valid)
auth.get('/me', (c) => {
  const poeUser = c.get('poeUser');
  if (!poeUser) {
    return c.json({ authenticated: false }, 401);
  }
  return c.json({
    authenticated: true,
    userHash: poeUser.userHash,
    keyLast4: poeUser.keyLast4,
    models: poeUser.models,
  });
});

export { auth };
```

**Step 2: Add auth export to routes/index.ts**

In `src/routes/index.ts`, add:
```typescript
export { auth } from './auth';
```

**Step 3: Verify types compile**

Run: `cd /Volumes/dev/poeclaw && npx tsc --noEmit`
Expected: No new errors

**Step 4: Commit**

```bash
git add src/routes/auth.ts src/routes/index.ts
git commit -m "feat: add login/logout/me auth routes"
```

---

### Task 7: Update auth/index.ts exports

**Files:**
- Modify: `src/auth/index.ts`

**Step 1: Add new exports**

Replace `src/auth/index.ts` with:
```typescript
export { verifyAccessJWT } from './jwt';
export { createAccessMiddleware, isDevMode, extractJWT } from './middleware';
export { validatePoeApiKey } from './poe';
export {
  hashApiKey,
  createSessionToken,
  verifySessionToken,
  encryptApiKey,
  decryptApiKey,
  buildSessionCookie,
  clearSessionCookie,
  extractSessionToken,
} from './session';
```

**Step 2: Commit**

```bash
git add src/auth/index.ts
git commit -m "feat: export poe and session modules from auth index"
```

---

### Task 8: Rewrite src/index.ts for per-user sandbox resolution

**Files:**
- Modify: `src/index.ts`

This is the largest single change. The key modifications:
1. Replace single-tenant `getSandbox(env.Sandbox, 'moltbot', options)` with per-user resolution
2. Replace CF Access middleware with session middleware
3. Remove `validateRequiredEnv` checks for CF Access and AI provider keys
4. Add auth routes
5. Login route resolves sandbox *after* auth (needs userHash)
6. Keep the catch-all proxy logic largely intact

**Step 1: Rewrite index.ts**

Replace `src/index.ts` entirely. The key changes are annotated inline:

```typescript
/**
 * PoeClaw - Multi-tenant OpenClaw platform powered by Poe API keys
 *
 * User flow:
 * 1. Visit landing page
 * 2. Paste POE_API_KEY
 * 3. Key validated against Poe API
 * 4. Per-user sandbox resolves via getSandbox(env.Sandbox, userHash)
 * 5. Chat via Poe-style UI using HTTP API + SSE
 */

import { Hono } from 'hono';
import { getSandbox, Sandbox, type SandboxOptions } from '@cloudflare/sandbox';

import type { AppEnv, MoltbotEnv, PoeSessionUser } from './types';
import { MOLTBOT_PORT } from './config';
import { verifySessionToken, extractSessionToken, decryptApiKey, hashApiKey } from './auth/session';
import { ensureMoltbotGateway, findExistingMoltbotProcess } from './gateway';
import { publicRoutes, api, debug, cdp, auth } from './routes';
import { redactSensitiveParams } from './utils/logging';
import loadingPageHtml from './assets/loading.html';

export { Sandbox };

/**
 * Build sandbox options for multi-tenant PoeClaw.
 * Always uses sleepAfter (never keepAlive) to bound memory usage.
 */
function buildSandboxOptions(env: MoltbotEnv): SandboxOptions {
  const sleepAfter = env.SANDBOX_SLEEP_AFTER?.toLowerCase() || '1h';
  if (sleepAfter === 'never') {
    return { keepAlive: true };
  }
  return { sleepAfter };
}

// Main app
const app = new Hono<AppEnv>();

// =============================================================================
// MIDDLEWARE: Logging
// =============================================================================

app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  const redactedSearch = redactSensitiveParams(url);
  console.log(`[REQ] ${c.req.method} ${url.pathname}${redactedSearch}`);
  await next();
});

// =============================================================================
// PUBLIC ROUTES: No auth required
// =============================================================================

// Health checks, logos, status
app.route('/', publicRoutes);

// CDP routes (shared secret auth)
app.route('/cdp', cdp);

// Auth routes (login/logout/me) — mounted before session middleware
// Login doesn't need a session (it creates one)
// Logout/me are handled inside the route
app.route('/api/auth', auth);

// Serve the SPA for unauthenticated users (login page)
// The SPA handles client-side routing between login and chat
app.get('/', async (c) => {
  const url = new URL(c.req.url);
  return c.env.ASSETS.fetch(new Request(new URL('/index.html', url.origin).toString()));
});

// =============================================================================
// SESSION MIDDLEWARE: Verify session cookie, resolve per-user sandbox
// =============================================================================

app.use('*', async (c, next) => {
  const sessionSecret = c.env.SESSION_SECRET;
  if (!sessionSecret) {
    // Dev mode: skip session auth
    if (c.env.DEV_MODE === 'true') {
      // In dev mode, use a single sandbox
      const options = buildSandboxOptions(c.env);
      const sandbox = getSandbox(c.env.Sandbox, 'dev-user', options);
      c.set('sandbox', sandbox);
      return next();
    }
    return c.json({ error: 'Server not configured (missing SESSION_SECRET)' }, 500);
  }

  // Extract session token from cookie
  const cookieHeader = c.req.header('Cookie');
  const token = extractSessionToken(cookieHeader);

  if (!token) {
    // No session — redirect to login for HTML requests, 401 for API
    const acceptsHtml = c.req.header('Accept')?.includes('text/html');
    if (acceptsHtml) {
      return c.redirect('/');
    }
    return c.json({ error: 'Authentication required', hint: 'POST /api/auth/login' }, 401);
  }

  // Verify session token
  const poeUser = await verifySessionToken(token, sessionSecret);
  if (!poeUser) {
    const acceptsHtml = c.req.header('Accept')?.includes('text/html');
    if (acceptsHtml) {
      return c.redirect('/');
    }
    return c.json({ error: 'Session expired or invalid' }, 401);
  }

  // Resolve per-user sandbox
  const options = buildSandboxOptions(c.env);
  const sandbox = getSandbox(c.env.Sandbox, poeUser.userHash, options);
  c.set('sandbox', sandbox);
  c.set('poeUser', poeUser);

  await next();
});

// =============================================================================
// PROTECTED ROUTES: Session required
// =============================================================================

// Mount API routes (admin, storage, etc.)
app.route('/api', api);

// Debug routes (protected + DEBUG_ROUTES flag)
app.use('/debug/*', async (c, next) => {
  if (c.env.DEBUG_ROUTES !== 'true') {
    return c.json({ error: 'Debug routes are disabled' }, 404);
  }
  return next();
});
app.route('/debug', debug);

// =============================================================================
// CATCH-ALL: Proxy to user's OpenClaw gateway
// =============================================================================

app.all('*', async (c) => {
  const sandbox = c.get('sandbox');
  const request = c.req.raw;
  const url = new URL(request.url);

  console.log('[PROXY] Handling request:', url.pathname);

  // Check if gateway is already running
  const existingProcess = await findExistingMoltbotProcess(sandbox);
  const isGatewayReady = existingProcess !== null && existingProcess.status === 'running';

  const isWebSocketRequest = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
  const acceptsHtml = request.headers.get('Accept')?.includes('text/html');

  if (!isGatewayReady && !isWebSocketRequest && acceptsHtml) {
    console.log('[PROXY] Gateway not ready, serving loading page');
    c.executionCtx.waitUntil(
      ensureMoltbotGateway(sandbox, c.env).catch((err: Error) => {
        console.error('[PROXY] Background gateway start failed:', err);
      }),
    );
    return c.html(loadingPageHtml);
  }

  try {
    await ensureMoltbotGateway(sandbox, c.env);
  } catch (error) {
    console.error('[PROXY] Failed to start gateway:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json(
      {
        error: 'Gateway failed to start',
        details: errorMessage,
        hint: 'Your container may need a moment to boot. Try again.',
      },
      503,
    );
  }

  // Proxy WebSocket connections
  if (isWebSocketRequest) {
    console.log('[WS] Proxying WebSocket connection');
    // Inject gateway token if configured
    let wsRequest = request;
    if (c.env.MOLTBOT_GATEWAY_TOKEN && !url.searchParams.has('token')) {
      const tokenUrl = new URL(url.toString());
      tokenUrl.searchParams.set('token', c.env.MOLTBOT_GATEWAY_TOKEN);
      wsRequest = new Request(tokenUrl.toString(), request);
    }
    return sandbox.wsConnect(wsRequest, MOLTBOT_PORT);
  }

  // Proxy HTTP requests
  console.log('[HTTP] Proxying:', url.pathname + url.search);
  const httpResponse = await sandbox.containerFetch(request, MOLTBOT_PORT);
  return new Response(httpResponse.body, {
    status: httpResponse.status,
    statusText: httpResponse.statusText,
    headers: httpResponse.headers,
  });
});

export default {
  fetch: app.fetch,
};
```

**Note:** This simplified version removes the complex WebSocket interception for now. The full interception can be re-added in Phase 5 if needed.

**Step 2: Verify types compile**

Run: `cd /Volumes/dev/poeclaw && npx tsc --noEmit`

Fix any import errors. The `adminUi` route is removed — if `src/routes/index.ts` still exports it, remove that export.

**Step 3: Run existing tests**

Run: `cd /Volumes/dev/poeclaw && npx vitest run`
Expected: Existing tests should still pass (they test internal modules, not the full app)

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: rewrite index.ts for per-user sandbox resolution with session auth"
```

---

### Task 9: Update vite.config.ts for root-mounted SPA

**Files:**
- Modify: `vite.config.ts`

The old admin UI was mounted at `/_admin/`. The new chat UI is the main app at `/`.

**Step 1: Change base path**

In `vite.config.ts`, change:
```typescript
base: "/_admin/",
```
to:
```typescript
base: "/",
```

**Step 2: Commit**

```bash
git add vite.config.ts
git commit -m "feat: mount SPA at root instead of /_admin/"
```

---

### Task 10: Create minimal login page (functional, unstyled)

**Files:**
- Modify: `src/client/App.tsx`
- Modify: `src/client/App.css`

**Step 1: Replace App.tsx with login/chat router**

Replace `src/client/App.tsx`:
```tsx
import { useState, useEffect } from 'react';
import './App.css';

interface SessionInfo {
  authenticated: boolean;
  userHash?: string;
  keyLast4?: string;
  models?: Array<{ id: string; name: string }>;
}

function LoginPage({ onLogin }: { onLogin: (session: SessionInfo) => void }) {
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Login failed');
        return;
      }

      onLogin({
        authenticated: true,
        userHash: data.userHash,
        keyLast4: data.keyLast4,
        models: data.models,
      });
    } catch (err) {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <h1>PoeClaw</h1>
      <p>Paste your Poe API key to get started.</p>
      <p>
        <a href="https://poe.com/api_key" target="_blank" rel="noopener noreferrer">
          Get your API key from poe.com
        </a>
      </p>
      <form onSubmit={handleSubmit}>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="pb-..."
          disabled={loading}
          autoFocus
        />
        <button type="submit" disabled={loading || !apiKey.trim()}>
          {loading ? 'Validating...' : 'Connect'}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function ChatPage({ session }: { session: SessionInfo }) {
  return (
    <div className="chat-page">
      <p>Logged in as ***...{session.keyLast4}</p>
      <p>Models: {session.models?.map((m) => m.id).join(', ') || 'none'}</p>
      <p>Container is booting... (full chat UI coming in Phase 4)</p>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    // Check if already logged in
    fetch('/api/auth/me')
      .then((res) => res.json())
      .then((data) => {
        if (data.authenticated) {
          setSession(data);
        }
      })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);

  if (checking) {
    return <div className="loading">Loading...</div>;
  }

  if (!session) {
    return <LoginPage onLogin={setSession} />;
  }

  return <ChatPage session={session} />;
}
```

**Step 2: Update App.css with minimal dark theme**

Replace `src/client/App.css`:
```css
:root {
  --bg: #1a1a2e;
  --surface: #16213e;
  --text: #e0e0e0;
  --text-muted: #8888aa;
  --accent: #7c5cfc;
  --error: #ff6b6b;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}

.login-page {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 2rem;
}

.login-page h1 { font-size: 2.5rem; margin-bottom: 0.5rem; }
.login-page p { color: var(--text-muted); margin-bottom: 0.5rem; }
.login-page a { color: var(--accent); }

.login-page form {
  display: flex;
  gap: 0.5rem;
  margin-top: 1.5rem;
  width: 100%;
  max-width: 500px;
}

.login-page input {
  flex: 1;
  padding: 0.75rem 1rem;
  border: 1px solid #333;
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font-size: 1rem;
}

.login-page button {
  padding: 0.75rem 1.5rem;
  border: none;
  border-radius: 8px;
  background: var(--accent);
  color: white;
  font-size: 1rem;
  cursor: pointer;
}

.login-page button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.error { color: var(--error); margin-top: 1rem; }

.chat-page {
  padding: 2rem;
  text-align: center;
}

.loading {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  color: var(--text-muted);
}
```

**Step 3: Build to verify no errors**

Run: `cd /Volumes/dev/poeclaw && npm run build`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add src/client/App.tsx src/client/App.css
git commit -m "feat: add minimal login page with dark theme"
```

---

### Task 11: Remove old admin UI (AdminPage) and update route exports

**Files:**
- Delete/modify: `src/client/pages/AdminPage.tsx` (if it exists, remove it)
- Modify: `src/routes/index.ts` (remove adminUi export)
- Modify: `src/routes/admin-ui.ts` (remove or keep for backward compat)

**Step 1: Update routes/index.ts**

Replace `src/routes/index.ts`:
```typescript
export { publicRoutes } from './public';
export { api } from './api';
export { debug } from './debug';
export { cdp } from './cdp';
export { auth } from './auth';
```

**Step 2: Run tests**

Run: `cd /Volumes/dev/poeclaw && npx vitest run`
Expected: All tests pass

**Step 3: Commit**

```bash
git add src/routes/index.ts
git commit -m "feat: remove adminUi route, add auth route export"
```

---

## Phase 2: Poe Provider Integration

### Task 12: Pass POE_API_KEY to container env vars

**Files:**
- Modify: `src/gateway/env.ts`
- Modify: `src/gateway/env.test.ts`

**Step 1: Write failing test**

Add to `src/gateway/env.test.ts`:
```typescript
it('passes POE_API_KEY to container', () => {
  const env = createMockEnv({ POE_API_KEY: 'pb-test-key-12345' } as any);
  const result = buildEnvVars(env);
  expect(result.POE_API_KEY).toBe('pb-test-key-12345');
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Volumes/dev/poeclaw && npx vitest run src/gateway/env.test.ts`
Expected: FAIL — `POE_API_KEY` not in result

**Step 3: Add POE_API_KEY to buildEnvVars**

In `src/gateway/env.ts`, after line 25 (`if (env.OPENAI_API_KEY) envVars.OPENAI_API_KEY = env.OPENAI_API_KEY;`), add:

```typescript
  // Poe provider (PoeClaw multi-tenant)
  if ((env as any).POE_API_KEY) envVars.POE_API_KEY = (env as any).POE_API_KEY;
```

**Note:** We cast to `any` because `POE_API_KEY` isn't on `MoltbotEnv` — it's injected per-user at runtime. A cleaner approach is to accept an `overrides` parameter. Let's do that instead.

Actually, the better approach: modify `ensureMoltbotGateway` in `process.ts` to accept env overrides. The per-user POE_API_KEY isn't a Worker-level env var — it comes from the session's decrypted key.

**Alternative Step 3: Add overrides parameter to buildEnvVars**

In `src/gateway/env.ts`, change the function signature:

```typescript
export function buildEnvVars(
  env: MoltbotEnv,
  overrides?: Record<string, string>,
): Record<string, string> {
  const envVars: Record<string, string> = {};
  // ... existing code ...

  // Apply per-user overrides (e.g., POE_API_KEY for PoeClaw)
  if (overrides) {
    Object.assign(envVars, overrides);
  }

  return envVars;
}
```

Update the test to use overrides:
```typescript
it('applies per-user env overrides', () => {
  const env = createMockEnv();
  const result = buildEnvVars(env, { POE_API_KEY: 'pb-test-key-12345' });
  expect(result.POE_API_KEY).toBe('pb-test-key-12345');
});

it('overrides take precedence over env vars', () => {
  const env = createMockEnv({ ANTHROPIC_API_KEY: 'sk-original' });
  const result = buildEnvVars(env, { ANTHROPIC_API_KEY: 'sk-override' });
  expect(result.ANTHROPIC_API_KEY).toBe('sk-override');
});
```

**Step 4: Run tests**

Run: `cd /Volumes/dev/poeclaw && npx vitest run src/gateway/env.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/gateway/env.ts src/gateway/env.test.ts
git commit -m "feat: add env overrides parameter to buildEnvVars for per-user keys"
```

---

### Task 13: Update process.ts to accept env overrides

**Files:**
- Modify: `src/gateway/process.ts`

**Step 1: Update ensureMoltbotGateway signature**

In `src/gateway/process.ts`, change `ensureMoltbotGateway`:

```typescript
export async function ensureMoltbotGateway(
  sandbox: Sandbox,
  env: MoltbotEnv,
  envOverrides?: Record<string, string>,
): Promise<Process> {
```

And change line 93:
```typescript
  const envVars = buildEnvVars(env);
```
to:
```typescript
  const envVars = buildEnvVars(env, envOverrides);
```

**Step 2: Verify types compile**

Run: `cd /Volumes/dev/poeclaw && npx tsc --noEmit`

**Step 3: Run existing tests**

Run: `cd /Volumes/dev/poeclaw && npx vitest run src/gateway/process.test.ts`
Expected: All tests PASS (new param is optional)

**Step 4: Commit**

```bash
git add src/gateway/process.ts
git commit -m "feat: accept env overrides in ensureMoltbotGateway for per-user config"
```

---

### Task 14: Update start-openclaw.sh for Poe provider

**Files:**
- Modify: `start-openclaw.sh`

**Step 1: Add POE_API_KEY onboard path**

In `start-openclaw.sh`, after the existing `elif [ -n "$OPENAI_API_KEY" ]; then` block (around line 116), add a Poe path:

```bash
    elif [ -n "$POE_API_KEY" ]; then
        # Poe uses OpenAI-compatible API — onboard with a dummy key,
        # then patch the config with the real Poe provider below
        AUTH_ARGS="--auth-choice openai-api-key --openai-api-key dummy-for-poe"
```

**Step 2: Add Poe provider config patching**

In the Node.js config patch section (after the Slack configuration block, around line 261), add:

```javascript
// Poe provider configuration (PoeClaw multi-tenant)
if (process.env.POE_API_KEY) {
    config.models = config.models || {};
    config.models.providers = config.models.providers || {};
    config.models.providers.poe = {
        baseUrl: 'https://api.poe.com/v1',
        apiKey: process.env.POE_API_KEY,
        api: 'openai-completions',
        models: [
            { id: 'Claude-Sonnet-4.5', name: 'Claude Sonnet 4.5', contextWindow: 200000, maxTokens: 8192 },
            { id: 'GPT-5.2', name: 'GPT 5.2', contextWindow: 128000, maxTokens: 8192 },
            { id: 'Gemini-3-Pro', name: 'Gemini 3 Pro', contextWindow: 128000, maxTokens: 8192 },
        ],
    };

    // Set Poe as the default model provider
    config.agents = config.agents || {};
    config.agents.defaults = config.agents.defaults || {};
    config.agents.defaults.model = { primary: 'poe/Claude-Sonnet-4.5' };
    console.log('Poe provider configured with API key');

    // Enable HTTP chat completions endpoint for PoeClaw's HTTP API
    config.gateway.http = config.gateway.http || {};
    config.gateway.http.endpoints = config.gateway.http.endpoints || {};
    config.gateway.http.endpoints.chatCompletions = { enabled: true };
    console.log('HTTP chat completions endpoint enabled');

    // Skip device pairing in PoeClaw mode (Worker handles auth)
    config.gateway.controlUi = config.gateway.controlUi || {};
    config.gateway.controlUi.allowInsecureAuth = true;
}
```

**Step 3: Test the script syntax**

Run: `bash -n /Volumes/dev/poeclaw/start-openclaw.sh`
Expected: No syntax errors

**Step 4: Commit**

```bash
git add start-openclaw.sh
git commit -m "feat: add Poe provider config patching to start-openclaw.sh"
```

---

### Task 15: Wire per-user POE_API_KEY into sandbox startup from index.ts

**Files:**
- Modify: `src/index.ts` (the catch-all proxy section)

The login route stores the encrypted key. When the catch-all proxy boots the container, it needs to decrypt the key and pass it as `POE_API_KEY` to `ensureMoltbotGateway`.

**Step 1: Update the catch-all in index.ts**

In the catch-all handler, before `ensureMoltbotGateway`, add key decryption:

```typescript
app.all('*', async (c) => {
  const sandbox = c.get('sandbox');
  const poeUser = c.get('poeUser');
  const request = c.req.raw;
  const url = new URL(request.url);

  // Build per-user env overrides
  let envOverrides: Record<string, string> | undefined;
  if (poeUser && c.env.ENCRYPTION_SECRET) {
    try {
      // Read encrypted key from container (stored at login)
      const readResult = await sandbox.exec('cat /tmp/poeclaw/encrypted-key 2>/dev/null || echo ""');
      const encryptedKey = readResult.stdout?.trim();
      if (encryptedKey) {
        const poeApiKey = await decryptApiKey(encryptedKey, c.env.ENCRYPTION_SECRET);
        envOverrides = {
          POE_API_KEY: poeApiKey,
          OPENCLAW_DEV_MODE: 'true', // Skip device pairing
        };
      }
    } catch (err) {
      console.error('[PROXY] Failed to decrypt POE_API_KEY:', err);
    }
  }

  // ... rest of the catch-all handler, passing envOverrides to ensureMoltbotGateway
```

Update calls to `ensureMoltbotGateway(sandbox, c.env)` to `ensureMoltbotGateway(sandbox, c.env, envOverrides)`.

**Step 2: Verify types compile**

Run: `cd /Volumes/dev/poeclaw && npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: decrypt and pass per-user POE_API_KEY to container on boot"
```

---

## Phase 3: Per-User R2 Persistence

### Task 16: Add user prefix to R2 paths in sync.ts

**Files:**
- Modify: `src/gateway/sync.ts`
- Modify: `src/gateway/sync.test.ts`

**Step 1: Add userPrefix parameter to syncToR2**

In `src/gateway/sync.ts`, update the `rcloneRemote` helper and `syncToR2` function:

```typescript
function rcloneRemote(env: MoltbotEnv, prefix: string, userPrefix?: string): string {
  const base = `r2:${getR2BucketName(env)}/`;
  return userPrefix ? `${base}users/${userPrefix}/${prefix}` : `${base}${prefix}`;
}

export async function syncToR2(
  sandbox: Sandbox,
  env: MoltbotEnv,
  userPrefix?: string,
): Promise<SyncResult> {
```

And update all `remote()` calls to pass `userPrefix`:
```typescript
  const remote = (prefix: string) => rcloneRemote(env, prefix, userPrefix);
```

**Step 2: Write a test for the user prefix**

Add to `src/gateway/sync.test.ts`:
```typescript
it('uses user prefix in R2 paths when provided', async () => {
  // ... setup mock sandbox that captures exec commands
  await syncToR2(sandbox, env, 'abc123');
  // Verify the rclone command includes 'users/abc123/'
  const execCalls = execMock.mock.calls.map((c: any[]) => c[0]);
  expect(execCalls.some((cmd: string) => cmd.includes('users/abc123/openclaw/'))).toBe(true);
});
```

**Step 3: Run tests**

Run: `cd /Volumes/dev/poeclaw && npx vitest run src/gateway/sync.test.ts`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add src/gateway/sync.ts src/gateway/sync.test.ts
git commit -m "feat: add per-user R2 path namespacing for data isolation"
```

---

### Task 17: Add user prefix to R2 paths in start-openclaw.sh

**Files:**
- Modify: `start-openclaw.sh`

**Step 1: Add R2_USER_PREFIX support**

At the top of `start-openclaw.sh` (around line 36), add:
```bash
R2_USER_PREFIX="${R2_USER_PREFIX:-}"
```

Then update all R2 paths. For the restore section, change paths like:
```bash
r2:${R2_BUCKET}/openclaw/
```
to:
```bash
r2:${R2_BUCKET}/${R2_USER_PREFIX:+users/${R2_USER_PREFIX}/}openclaw/
```

This uses bash parameter expansion: if `R2_USER_PREFIX` is set, prepend `users/{prefix}/`, otherwise use the root path (backward compatible).

Apply the same pattern to `workspace/` and `skills/` paths, and the background sync loop paths.

**Step 2: Test syntax**

Run: `bash -n /Volumes/dev/poeclaw/start-openclaw.sh`
Expected: No syntax errors

**Step 3: Commit**

```bash
git add start-openclaw.sh
git commit -m "feat: add R2_USER_PREFIX support for per-user data isolation in shell"
```

---

### Task 18: Pass R2_USER_PREFIX in env overrides

**Files:**
- Modify: `src/index.ts` (the envOverrides section from Task 15)

**Step 1: Add R2_USER_PREFIX to envOverrides**

In the catch-all handler where we build `envOverrides`, add:
```typescript
envOverrides = {
  POE_API_KEY: poeApiKey,
  OPENCLAW_DEV_MODE: 'true',
  R2_USER_PREFIX: poeUser.userHash, // Per-user R2 path prefix
};
```

**Step 2: Pass userPrefix to syncToR2 calls**

In `src/routes/api.ts`, the `POST /api/admin/storage/sync` route calls `syncToR2(sandbox, c.env)`. Update it to pass the user prefix:
```typescript
const poeUser = c.get('poeUser');
const result = await syncToR2(sandbox, c.env, poeUser?.userHash);
```

**Step 3: Commit**

```bash
git add src/index.ts src/routes/api.ts
git commit -m "feat: pass per-user R2 prefix to container and sync operations"
```

---

## Phase 4: Poe-Style Chat Frontend

### Task 19: Create useGatewayStatus hook

**Files:**
- Create: `src/client/hooks/useGatewayStatus.ts`

**Step 1: Create the hook**

Create `src/client/hooks/useGatewayStatus.ts`:
```typescript
import { useState, useEffect, useRef } from 'react';

export type GatewayStatus = 'unknown' | 'booting' | 'running' | 'error';

/**
 * Poll /api/status to track container boot progress.
 * Returns current status and a flag for when it's ready.
 */
export function useGatewayStatus(enabled: boolean) {
  const [status, setStatus] = useState<GatewayStatus>('unknown');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const check = async () => {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        if (data.ok && data.status === 'running') {
          setStatus('running');
          if (intervalRef.current) clearInterval(intervalRef.current);
        } else {
          setStatus('booting');
        }
      } catch {
        setStatus('error');
      }
    };

    check(); // Immediate check
    intervalRef.current = setInterval(check, 3000); // Poll every 3s

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [enabled]);

  return { status, isReady: status === 'running' };
}
```

**Step 2: Commit**

```bash
git add src/client/hooks/useGatewayStatus.ts
git commit -m "feat: add useGatewayStatus hook for cold start polling"
```

---

### Task 20: Create useChat SSE streaming hook

**Files:**
- Create: `src/client/hooks/useChat.ts`

**Step 1: Create the hook**

Create `src/client/hooks/useChat.ts`:
```typescript
import { useState, useCallback, useRef } from 'react';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * SSE streaming chat hook.
 * Sends messages to /v1/chat/completions and streams the response.
 */
export function useChat(model: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(
    async (userMessage: string) => {
      const userMsg: ChatMessage = { role: 'user', content: userMessage };
      const updatedMessages = [...messages, userMsg];
      setMessages([...updatedMessages, { role: 'assistant', content: '' }]);
      setIsStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch('/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: updatedMessages.map((m) => ({ role: m.role, content: m.content })),
            stream: true,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.error?.message || `HTTP ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response body');

        const decoder = new TextDecoder();
        let assistantContent = '';
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                assistantContent += delta;
                setMessages([
                  ...updatedMessages,
                  { role: 'assistant', content: assistantContent },
                ]);
              }
            } catch {
              // Skip unparseable SSE lines
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setMessages([
          ...updatedMessages,
          { role: 'assistant', content: `Error: ${(err as Error).message}` },
        ]);
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [messages, model],
  );

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  return { messages, sendMessage, isStreaming, stopStreaming, clearMessages };
}
```

**Step 2: Commit**

```bash
git add src/client/hooks/useChat.ts
git commit -m "feat: add useChat SSE streaming hook"
```

---

### Task 21: Create Poe-style ChatPage

**Files:**
- Create: `src/client/pages/ChatPage.tsx`
- Create: `src/client/pages/ChatPage.css`

**Step 1: Create ChatPage component**

Create `src/client/pages/ChatPage.tsx`:
```tsx
import { useState, useRef, useEffect } from 'react';
import { useChat } from '../hooks/useChat';
import { useGatewayStatus } from '../hooks/useGatewayStatus';
import './ChatPage.css';

interface ChatPageProps {
  models: Array<{ id: string; name: string }>;
  keyLast4: string;
  onLogout: () => void;
}

export function ChatPage({ models, keyLast4, onLogout }: ChatPageProps) {
  const [selectedModel, setSelectedModel] = useState(models[0]?.id || '');
  const { status, isReady } = useGatewayStatus(true);
  const { messages, sendMessage, isStreaming, stopStreaming, clearMessages } =
    useChat(selectedModel);
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isStreaming || !isReady) return;
    sendMessage(input.trim());
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    onLogout();
  };

  return (
    <div className="chat-layout">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <h2>PoeClaw</h2>
        </div>

        <div className="model-selector">
          <label>Model</label>
          <select
            value={selectedModel}
            onChange={(e) => {
              setSelectedModel(e.target.value);
              clearMessages();
            }}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>

        <button className="new-chat-btn" onClick={clearMessages}>
          New Chat
        </button>

        <div className="sidebar-footer">
          <span className="user-badge">***...{keyLast4}</span>
          <button className="logout-btn" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </aside>

      {/* Main chat area */}
      <main className="chat-main">
        {!isReady ? (
          <div className="boot-status">
            <div className="spinner" />
            <p>
              {status === 'booting'
                ? 'Starting your sandbox... This may take a minute.'
                : status === 'error'
                  ? 'Error connecting. Retrying...'
                  : 'Checking status...'}
            </p>
          </div>
        ) : (
          <>
            <div className="messages">
              {messages.length === 0 && (
                <div className="empty-state">
                  <h3>Start a conversation</h3>
                  <p>Send a message to begin chatting with {selectedModel}</p>
                </div>
              )}
              {messages.map((msg, i) => (
                <div key={i} className={`message message-${msg.role}`}>
                  <div className="message-role">{msg.role === 'user' ? 'You' : selectedModel}</div>
                  <div className="message-content">{msg.content || '...'}</div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            <form className="input-bar" onSubmit={handleSubmit}>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={`Message ${selectedModel}...`}
                rows={1}
                disabled={isStreaming}
              />
              {isStreaming ? (
                <button type="button" className="stop-btn" onClick={stopStreaming}>
                  Stop
                </button>
              ) : (
                <button type="submit" disabled={!input.trim()}>
                  Send
                </button>
              )}
            </form>
          </>
        )}
      </main>
    </div>
  );
}
```

**Step 2: Create ChatPage.css**

Create `src/client/pages/ChatPage.css`:
```css
.chat-layout {
  display: flex;
  height: 100vh;
  background: var(--bg);
}

/* Sidebar */
.sidebar {
  width: 260px;
  background: var(--surface);
  border-right: 1px solid #2a2a4a;
  display: flex;
  flex-direction: column;
  padding: 1rem;
}

.sidebar-header h2 {
  font-size: 1.25rem;
  margin-bottom: 1rem;
}

.model-selector {
  margin-bottom: 1rem;
}

.model-selector label {
  display: block;
  font-size: 0.75rem;
  color: var(--text-muted);
  margin-bottom: 0.25rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.model-selector select {
  width: 100%;
  padding: 0.5rem;
  background: var(--bg);
  color: var(--text);
  border: 1px solid #333;
  border-radius: 6px;
  font-size: 0.875rem;
}

.new-chat-btn {
  padding: 0.5rem;
  background: transparent;
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.875rem;
  margin-bottom: 1rem;
}

.new-chat-btn:hover {
  background: rgba(124, 92, 252, 0.1);
}

.sidebar-footer {
  margin-top: auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.user-badge {
  font-size: 0.75rem;
  color: var(--text-muted);
}

.logout-btn {
  background: transparent;
  color: var(--text-muted);
  border: none;
  cursor: pointer;
  font-size: 0.75rem;
}

.logout-btn:hover {
  color: var(--error);
}

/* Main chat area */
.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.boot-status {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  gap: 1rem;
}

.spinner {
  width: 40px;
  height: 40px;
  border: 3px solid #333;
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Messages */
.messages {
  flex: 1;
  overflow-y: auto;
  padding: 2rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
}

.empty-state h3 {
  font-size: 1.25rem;
  margin-bottom: 0.5rem;
  color: var(--text);
}

.message {
  max-width: 800px;
  width: 100%;
  margin: 0 auto;
}

.message-role {
  font-size: 0.75rem;
  font-weight: 600;
  margin-bottom: 0.25rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.message-user .message-role { color: var(--accent); }
.message-assistant .message-role { color: #4ade80; }

.message-content {
  font-size: 0.9375rem;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

/* Input bar */
.input-bar {
  padding: 1rem 2rem;
  border-top: 1px solid #2a2a4a;
  display: flex;
  gap: 0.5rem;
  max-width: 800px;
  width: 100%;
  margin: 0 auto;
}

.input-bar textarea {
  flex: 1;
  padding: 0.75rem 1rem;
  background: var(--surface);
  color: var(--text);
  border: 1px solid #333;
  border-radius: 8px;
  font-size: 0.9375rem;
  font-family: inherit;
  resize: none;
  min-height: 44px;
  max-height: 200px;
}

.input-bar textarea:focus {
  outline: none;
  border-color: var(--accent);
}

.input-bar button {
  padding: 0.75rem 1.25rem;
  border: none;
  border-radius: 8px;
  background: var(--accent);
  color: white;
  font-size: 0.875rem;
  cursor: pointer;
  align-self: flex-end;
}

.input-bar button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.stop-btn {
  background: var(--error) !important;
}

/* Responsive */
@media (max-width: 768px) {
  .sidebar { display: none; }
  .messages { padding: 1rem; }
  .input-bar { padding: 0.75rem 1rem; }
}
```

**Step 3: Commit**

```bash
git add src/client/pages/ChatPage.tsx src/client/pages/ChatPage.css
git commit -m "feat: add Poe-style chat page with sidebar, model selector, and SSE streaming"
```

---

### Task 22: Create styled LoginPage

**Files:**
- Create: `src/client/pages/LoginPage.tsx`
- Create: `src/client/pages/LoginPage.css`

**Step 1: Create LoginPage component**

Create `src/client/pages/LoginPage.tsx`:
```tsx
import { useState } from 'react';
import './LoginPage.css';

interface LoginPageProps {
  onLogin: (data: { userHash: string; keyLast4: string; models: Array<{ id: string; name: string }> }) => void;
}

export function LoginPage({ onLogin }: LoginPageProps) {
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Login failed');
        return;
      }

      onLogin(data);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-brand">
          <h1>PoeClaw</h1>
          <p className="login-tagline">Your AI agent, powered by Poe</p>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
          <div className="input-group">
            <label htmlFor="api-key">Poe API Key</label>
            <input
              id="api-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="pb-..."
              disabled={loading}
              autoFocus
              autoComplete="off"
            />
            <a
              className="key-link"
              href="https://poe.com/api_key"
              target="_blank"
              rel="noopener noreferrer"
            >
              Get your API key
            </a>
          </div>

          <button type="submit" className="login-submit" disabled={loading || !apiKey.trim()}>
            {loading ? 'Validating...' : 'Connect'}
          </button>

          {error && <p className="login-error">{error}</p>}
        </form>

        <p className="login-footer">
          Your key is encrypted and stored only in your sandbox container.
        </p>
      </div>
    </div>
  );
}
```

**Step 2: Create LoginPage.css**

Create `src/client/pages/LoginPage.css`:
```css
.login-container {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 2rem;
  background: var(--bg);
}

.login-card {
  width: 100%;
  max-width: 420px;
  background: var(--surface);
  border-radius: 16px;
  padding: 2.5rem;
  border: 1px solid #2a2a4a;
}

.login-brand {
  text-align: center;
  margin-bottom: 2rem;
}

.login-brand h1 {
  font-size: 2rem;
  font-weight: 700;
  background: linear-gradient(135deg, var(--accent), #a78bfa);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.login-tagline {
  color: var(--text-muted);
  font-size: 0.875rem;
  margin-top: 0.25rem;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.input-group {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.input-group label {
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--text);
}

.input-group input {
  padding: 0.75rem 1rem;
  background: var(--bg);
  color: var(--text);
  border: 1px solid #333;
  border-radius: 8px;
  font-size: 1rem;
  transition: border-color 0.15s;
}

.input-group input:focus {
  outline: none;
  border-color: var(--accent);
}

.key-link {
  font-size: 0.75rem;
  color: var(--accent);
  text-decoration: none;
}

.key-link:hover {
  text-decoration: underline;
}

.login-submit {
  padding: 0.75rem;
  background: var(--accent);
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 1rem;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.15s;
}

.login-submit:hover:not(:disabled) {
  opacity: 0.9;
}

.login-submit:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.login-error {
  color: var(--error);
  font-size: 0.875rem;
  text-align: center;
}

.login-footer {
  text-align: center;
  font-size: 0.75rem;
  color: var(--text-muted);
  margin-top: 1.5rem;
}
```

**Step 3: Commit**

```bash
git add src/client/pages/LoginPage.tsx src/client/pages/LoginPage.css
git commit -m "feat: add styled dark-theme login page"
```

---

### Task 23: Update App.tsx to use new pages

**Files:**
- Modify: `src/client/App.tsx`
- Modify: `src/client/App.css`

**Step 1: Update App.tsx**

Replace `src/client/App.tsx`:
```tsx
import { useState, useEffect } from 'react';
import { LoginPage } from './pages/LoginPage';
import { ChatPage } from './pages/ChatPage';
import './App.css';

interface SessionInfo {
  userHash: string;
  keyLast4: string;
  models: Array<{ id: string; name: string }>;
}

export default function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((res) => res.json())
      .then((data) => {
        if (data.authenticated) {
          setSession({
            userHash: data.userHash,
            keyLast4: data.keyLast4,
            models: data.models,
          });
        }
      })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);

  if (checking) {
    return (
      <div className="app-loading">
        <div className="spinner" />
      </div>
    );
  }

  if (!session) {
    return <LoginPage onLogin={setSession} />;
  }

  return (
    <ChatPage
      models={session.models}
      keyLast4={session.keyLast4}
      onLogout={() => setSession(null)}
    />
  );
}
```

**Step 2: Simplify App.css**

Replace `src/client/App.css`:
```css
:root {
  --bg: #1a1a2e;
  --surface: #16213e;
  --text: #e0e0e0;
  --text-muted: #8888aa;
  --accent: #7c5cfc;
  --error: #ff6b6b;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  -webkit-font-smoothing: antialiased;
}

.app-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
}

.spinner {
  width: 40px;
  height: 40px;
  border: 3px solid #333;
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
```

**Step 3: Build**

Run: `cd /Volumes/dev/poeclaw && npm run build`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add src/client/App.tsx src/client/App.css
git commit -m "feat: wire up login → chat page routing with session management"
```

---

### Task 24: Remove old AdminPage

**Files:**
- Delete: `src/client/pages/AdminPage.tsx` (and `AdminPage.css` if it exists)

**Step 1: Check what exists**

Run: `ls /Volumes/dev/poeclaw/src/client/pages/`

**Step 2: Delete old admin files**

```bash
rm -f /Volumes/dev/poeclaw/src/client/pages/AdminPage.tsx
rm -f /Volumes/dev/poeclaw/src/client/pages/AdminPage.css
```

**Step 3: Run build to verify nothing references them**

Run: `cd /Volumes/dev/poeclaw && npm run build`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove old AdminPage (replaced by ChatPage)"
```

---

## Phase 5: Polish & Harden

### Task 25: Update public routes for PoeClaw

**Files:**
- Modify: `src/routes/public.ts`

**Step 1: Update health check and add SPA serving**

In `src/routes/public.ts`, update the health check response and add the root SPA route:

Change `service: 'moltbot-sandbox'` to `service: 'poeclaw'`.

Add a route to serve the SPA index for the root path:
```typescript
// Serve SPA for the root path (login page for unauthenticated users)
publicRoutes.get('/', async (c) => {
  const url = new URL(c.req.url);
  return c.env.ASSETS.fetch(new Request(new URL('/index.html', url.origin).toString()));
});
```

**Step 2: Commit**

```bash
git add src/routes/public.ts
git commit -m "feat: update public routes for PoeClaw (health check, SPA serving)"
```

---

### Task 26: Add CSP headers

**Files:**
- Modify: `src/index.ts`

**Step 1: Add security headers middleware**

After the logging middleware, add:
```typescript
// Security headers
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'",
  );
});
```

**Step 2: Run build**

Run: `cd /Volumes/dev/poeclaw && npm run build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add CSP and security headers"
```

---

### Task 27: Add rate limiting to login endpoint

**Files:**
- Modify: `src/routes/auth.ts`

**Step 1: Add simple in-memory rate limiter**

Add at the top of `src/routes/auth.ts`:
```typescript
// Simple rate limiter: 10 attempts per IP per minute
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 60_000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (entry.count >= MAX_ATTEMPTS) return false;
  entry.count++;
  return true;
}
```

Then at the start of the login handler:
```typescript
auth.post('/login', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown';
  if (!checkRateLimit(ip)) {
    return c.json({ error: 'Too many login attempts. Try again in a minute.' }, 429);
  }
  // ... rest of handler
```

**Step 2: Commit**

```bash
git add src/routes/auth.ts
git commit -m "feat: add rate limiting to login endpoint (10 req/min/IP)"
```

---

### Task 28: Run full test suite and fix issues

**Files:** Various

**Step 1: Run all tests**

Run: `cd /Volumes/dev/poeclaw && npx vitest run`

**Step 2: Fix any failing tests**

The old `src/auth/middleware.test.ts` and `src/auth/jwt.test.ts` may still reference old patterns. If they fail because the old middleware is no longer used from `index.ts`, that's expected — the tests themselves should still pass since the modules still exist.

Fix any import errors or type mismatches.

**Step 3: Run linter**

Run: `cd /Volumes/dev/poeclaw && npm run lint`

**Step 4: Run typecheck**

Run: `cd /Volumes/dev/poeclaw && npx tsc --noEmit`

**Step 5: Fix all issues and commit**

```bash
git add -A
git commit -m "fix: resolve test failures and lint issues from PoeClaw migration"
```

---

### Task 29: Run full build and verify

**Step 1: Clean build**

Run: `cd /Volumes/dev/poeclaw && rm -rf dist && npm run build`
Expected: Build succeeds, `dist/client` has the SPA assets

**Step 2: Verify wrangler can parse the config**

Run: `cd /Volumes/dev/poeclaw && npx wrangler deploy --dry-run 2>&1 | head -20`
Expected: No config parse errors

**Step 3: Commit any final fixes**

```bash
git add -A
git commit -m "chore: verify clean build and wrangler config"
```

---

### Task 30: Update loading page for PoeClaw branding

**Files:**
- Modify: `src/assets/loading.html`

**Step 1: Update branding**

Replace "Moltbot" references with "PoeClaw" in the loading HTML. Keep the same loading animation but update text and colors to match the dark theme.

**Step 2: Commit**

```bash
git add src/assets/loading.html
git commit -m "feat: update loading page with PoeClaw branding"
```

---

## Summary

| Phase | Tasks | Description |
|-------|-------|-------------|
| 1 | 1-11 | Auth & multi-tenant core (rename, types, session, poe validation, login, index.ts rewrite, vite, minimal UI) |
| 2 | 12-15 | Poe provider integration (env vars, process overrides, start-openclaw.sh, key passthrough) |
| 3 | 16-18 | Per-user R2 persistence (sync paths, shell paths, prefix wiring) |
| 4 | 19-24 | Poe-style chat frontend (status hook, SSE hook, ChatPage, LoginPage, App routing, cleanup) |
| 5 | 25-30 | Polish & harden (public routes, CSP, rate limiting, tests, build verification, branding) |

**Total: 30 tasks across 5 phases.**

Each phase is independently testable:
- **After Phase 1:** Login works, session cookie set, per-user DO resolved
- **After Phase 2:** Container boots with Poe provider, chat works via OpenClaw's built-in UI
- **After Phase 3:** User data persists across container restarts, isolated per user
- **After Phase 4:** Full Poe-style chat UI with model switching and SSE streaming
- **After Phase 5:** Production-ready with security headers, rate limiting, clean tests
