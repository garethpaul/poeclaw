import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { createMockEnv } from '../test-utils';
import { createSessionToken } from '../auth/session';

/**
 * Contract tests for auth routes
 *
 * Threat model: These tests verify the API boundary promises:
 * - Login rejects missing/invalid keys and returns proper session on success
 * - Login returns 500 when server secrets are misconfigured
 * - Logout clears the session cookie
 * - /me returns session info for authenticated users, 401 otherwise
 * - Rate limiting prevents brute-force key enumeration
 */

// Mock validatePoeApiKey to avoid real Poe API calls
vi.mock('../auth/poe', () => ({
  validatePoeApiKey: vi.fn(),
}));

// Mock getSandbox since login stores encrypted key in sandbox
vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: vi.fn(() => ({
    exec: vi.fn().mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      success: true,
      command: '',
      duration: 0,
      timestamp: '',
    }),
  })),
}));

import { auth } from './auth';
import { validatePoeApiKey } from '../auth/poe';

const TEST_SESSION_SECRET = 'test-session-secret-32-chars-ok!';
const TEST_ENCRYPTION_SECRET = 'test-encrypt-secret-32-chars-ok!';

const testEnv = createMockEnv({
  SESSION_SECRET: TEST_SESSION_SECRET,
  ENCRYPTION_SECRET: TEST_ENCRYPTION_SECRET,
});

function createApp() {
  const app = new Hono<AppEnv>();
  app.route('/api/auth', auth);
  return app;
}

describe('POST /api/auth/login', () => {
  beforeEach(() => {
    vi.mocked(validatePoeApiKey).mockReset();
  });

  it('returns 400 when apiKey is missing', async () => {
    const app = createApp();
    const res = await app.request(
      '/api/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.1' },
        body: JSON.stringify({}),
      },
      testEnv,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toMatch(/required/i);
  });

  it('returns 401 when apiKey is invalid (Poe API rejects)', async () => {
    vi.mocked(validatePoeApiKey).mockResolvedValue({ valid: false, error: 'Invalid API key' });

    const app = createApp();
    const res = await app.request(
      '/api/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.2' },
        body: JSON.stringify({ apiKey: 'pb-bad-key-12345' }),
      },
      testEnv,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toMatch(/invalid/i);
  });

  it('returns 200 with session data and Set-Cookie on valid key', async () => {
    vi.mocked(validatePoeApiKey).mockResolvedValue({
      valid: true,
      models: [{ id: 'Claude-Sonnet-4.5', name: 'Claude-Sonnet-4.5' }],
    });

    const app = createApp();
    const res = await app.request(
      '/api/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.3' },
        body: JSON.stringify({ apiKey: 'pb-valid-key-12345' }),
      },
      testEnv,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.userHash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.keyLast4).toBe('2345');
    expect(body.models).toHaveLength(1);

    const cookie = res.headers.get('Set-Cookie');
    expect(cookie).toContain('poeclaw_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
  });

  it('returns 500 when SESSION_SECRET is missing', async () => {
    vi.mocked(validatePoeApiKey).mockResolvedValue({ valid: true, models: [] });

    const app = createApp();
    const envNoSession = createMockEnv({ ENCRYPTION_SECRET: TEST_ENCRYPTION_SECRET });
    const res = await app.request(
      '/api/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.4' },
        body: JSON.stringify({ apiKey: 'pb-valid-key-12345' }),
      },
      envNoSession,
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toMatch(/configuration/i);
  });

  it('returns 500 when ENCRYPTION_SECRET is missing', async () => {
    vi.mocked(validatePoeApiKey).mockResolvedValue({ valid: true, models: [] });

    const app = createApp();
    const envNoEncrypt = createMockEnv({ SESSION_SECRET: TEST_SESSION_SECRET });
    const res = await app.request(
      '/api/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.5' },
        body: JSON.stringify({ apiKey: 'pb-valid-key-12345' }),
      },
      envNoEncrypt,
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toMatch(/configuration/i);
  });
});

describe('POST /api/auth/logout', () => {
  it('returns 200 and clears session cookie', async () => {
    const app = createApp();
    const res = await app.request('/api/auth/logout', { method: 'POST' });
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);

    const cookie = res.headers.get('Set-Cookie');
    expect(cookie).toContain('poeclaw_session=');
    expect(cookie).toContain('Max-Age=0');
  });
});

describe('GET /api/auth/me', () => {
  it('returns 401 when no session is set', async () => {
    const app = createApp();
    const res = await app.request('/api/auth/me', undefined, testEnv);
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.authenticated).toBe(false);
  });

  // Threat model: DEV_MODE must not bypass login — users must enter their Poe API key
  it('returns 401 without session cookie even in DEV_MODE', async () => {
    const devEnv = createMockEnv({
      SESSION_SECRET: TEST_SESSION_SECRET,
      ENCRYPTION_SECRET: TEST_ENCRYPTION_SECRET,
      DEV_MODE: 'true',
    });
    const app = createApp();
    const res = await app.request('/api/auth/me', undefined, devEnv);
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.authenticated).toBe(false);
  });

  it('returns session info when valid session cookie is present', async () => {
    const payload = {
      userHash: 'abc123def456',
      keyLast4: '5678',
      models: [{ id: 'GPT-5.2', name: 'GPT-5.2' }],
      createdAt: Date.now(),
    };
    const token = await createSessionToken(payload, TEST_SESSION_SECRET);

    const app = createApp();
    const res = await app.request(
      '/api/auth/me',
      {
        headers: { Cookie: `poeclaw_session=${token}` },
      },
      testEnv,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.authenticated).toBe(true);
    expect(body.userHash).toBe('abc123def456');
    expect(body.keyLast4).toBe('5678');
    expect(body.models).toHaveLength(1);
  });

  it('returns session info with valid cookie in DEV_MODE', async () => {
    const devEnv = createMockEnv({
      SESSION_SECRET: TEST_SESSION_SECRET,
      ENCRYPTION_SECRET: TEST_ENCRYPTION_SECRET,
      DEV_MODE: 'true',
    });
    const payload = {
      userHash: 'abc123def456',
      keyLast4: '5678',
      models: [{ id: 'GPT-5.2', name: 'GPT-5.2' }],
      createdAt: Date.now(),
    };
    const token = await createSessionToken(payload, TEST_SESSION_SECRET);

    const app = createApp();
    const res = await app.request(
      '/api/auth/me',
      {
        headers: { Cookie: `poeclaw_session=${token}` },
      },
      devEnv,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.authenticated).toBe(true);
    expect(body.userHash).toBe('abc123def456');
    expect(body.keyLast4).toBe('5678');
  });

  // Threat model: expired sessions must not grant access
  it('returns 401 with expired session cookie', async () => {
    const payload = {
      userHash: 'abc123def456',
      keyLast4: '5678',
      models: [],
      createdAt: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago (past 24h expiry)
    };
    const token = await createSessionToken(payload, TEST_SESSION_SECRET);

    const app = createApp();
    const res = await app.request(
      '/api/auth/me',
      {
        headers: { Cookie: `poeclaw_session=${token}` },
      },
      testEnv,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.authenticated).toBe(false);
  });
});

/**
 * Threat model: Full login → /me flow must work end-to-end.
 * Verifies that POST /api/auth/login creates a session that GET /api/auth/me accepts.
 */
describe('Login → /me flow', () => {
  it('POST /api/auth/login creates session that GET /api/auth/me accepts', async () => {
    vi.mocked(validatePoeApiKey).mockResolvedValue({
      valid: true,
      models: [{ id: 'Claude-Sonnet-4.5', name: 'Claude-Sonnet-4.5' }],
    });

    const app = createApp();

    // Step 1: Login
    const loginRes = await app.request(
      '/api/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.100' },
        body: JSON.stringify({ apiKey: 'pb-valid-key-12345' }),
      },
      testEnv,
    );
    expect(loginRes.status).toBe(200);

    // Step 2: Extract session cookie
    const setCookie = loginRes.headers.get('Set-Cookie')!;
    const cookieMatch = setCookie.match(/poeclaw_session=([^;]+)/);
    expect(cookieMatch).not.toBeNull();
    const sessionCookie = `poeclaw_session=${cookieMatch![1]}`;

    // Step 3: Use cookie in GET /me
    const meRes = await app.request(
      '/api/auth/me',
      {
        headers: { Cookie: sessionCookie },
      },
      testEnv,
    );
    expect(meRes.status).toBe(200);

    const body = (await meRes.json()) as Record<string, unknown>;
    expect(body.authenticated).toBe(true);
    expect(body.userHash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.keyLast4).toBe('2345');
    expect(body.models).toHaveLength(1);
  });
});

/**
 * Threat model: Rate limiting prevents brute-force key guessing.
 * Without this, an attacker can enumerate valid Poe API keys at high speed.
 */
describe('Rate limiting', () => {
  it('returns 429 after 10 login attempts from the same IP', async () => {
    const app = createApp();
    const ip = '10.99.99.99';

    // Exhaust 10 attempts (400 responses still consume rate limit)
    for (let i = 0; i < 10; i++) {
      const res = await app.request(
        '/api/auth/login',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
          body: JSON.stringify({}),
        },
        testEnv,
      );
      expect(res.status).not.toBe(429);
    }

    // 11th attempt should be rate limited
    const res = await app.request(
      '/api/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
        body: JSON.stringify({}),
      },
      testEnv,
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toMatch(/too many/i);
  });
});
