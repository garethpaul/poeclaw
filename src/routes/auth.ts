import { Hono } from 'hono';
import { getSandbox } from '@cloudflare/sandbox';
import type { AppEnv } from '../types';
import { buildSandboxOptions } from '../config';
import { validatePoeApiKey } from '../auth/poe';
import {
  hashApiKey,
  createSessionToken,
  verifySessionToken,
  extractSessionToken,
  encryptApiKey,
  buildSessionCookie,
  clearSessionCookie,
} from '../auth/session';

/**
 * Auth routes for PoeClaw session management
 *
 * POST /api/auth/login  — Validate Poe API key, create session, encrypt key, set cookie
 * POST /api/auth/logout — Clear session cookie
 * GET  /api/auth/me     — Return session info if valid, 401 otherwise
 */

// In-memory rate limiter: 10 attempts per IP per minute
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

const auth = new Hono<AppEnv>();

// POST /api/auth/login - Validate Poe API key and create session
auth.post('/login', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown';
  if (!checkRateLimit(ip)) {
    return c.json({ error: 'Too many login attempts. Try again in a minute.' }, 429);
  }

  const body = await c.req.json<{ apiKey?: string }>().catch(() => ({ apiKey: undefined }));
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

  // Resolve per-user sandbox and store encrypted key
  // Auth routes are mounted before session middleware, so we resolve the sandbox directly
  const options = buildSandboxOptions(c.env);
  const sandbox = getSandbox(c.env.Sandbox, userHash, options);
  c.set('sandbox', sandbox);
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
  return c.json({ ok: true }, 200, {
    'Set-Cookie': clearSessionCookie(),
  });
});

// GET /api/auth/me - Return current session info (if valid)
// Auth routes are before session middleware, so we verify the token directly
// NOTE: No DEV_MODE bypass — users must always enter their Poe API key
auth.get('/me', async (c) => {
  const sessionSecret = c.env?.SESSION_SECRET;
  if (!sessionSecret) {
    return c.json({ authenticated: false }, 401);
  }

  const cookieHeader = c.req.header('Cookie');
  const token = extractSessionToken(cookieHeader);
  if (!token) {
    return c.json({ authenticated: false }, 401);
  }

  const poeUser = await verifySessionToken(token, sessionSecret);
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
