/**
 * PoeClaw - Multi-tenant OpenClaw platform powered by Poe API keys
 *
 * User flow:
 * 1. Visit landing page -> see login page
 * 2. Paste POE_API_KEY -> validated against Poe API
 * 3. Session cookie set -> per-user sandbox resolves via getSandbox(env.Sandbox, userHash)
 * 4. Chat via Poe-style UI using HTTP API + SSE
 *
 * Required secrets (set via `wrangler secret put`):
 * - SESSION_SECRET: HMAC-SHA256 key for session cookies
 * - ENCRYPTION_SECRET: AES-GCM key for encrypting stored API keys
 */

import { Hono } from 'hono';
import { getSandbox, Sandbox } from '@cloudflare/sandbox';

import type { AppEnv } from './types';
import { MOLTBOT_PORT, buildSandboxOptions } from './config';
import { verifySessionToken, extractSessionToken, decryptApiKey } from './auth/session';
import { ensureMoltbotGateway, findExistingMoltbotProcess } from './gateway';
import { publicRoutes, api, auth, debug, cdp } from './routes';
import { redactSensitiveParams } from './utils/logging';
import loadingPageHtml from './assets/loading.html';

/**
 * Transform error messages from the gateway to be more user-friendly.
 */
function transformErrorMessage(message: string, host: string): string {
  if (message.includes('gateway token missing') || message.includes('gateway token mismatch')) {
    return `Invalid or missing token. Visit https://${host}?token={REPLACE_WITH_YOUR_TOKEN}`;
  }

  if (message.includes('pairing required')) {
    return `Pairing required. Visit https://${host}/_admin/`;
  }

  return message;
}

/** RFC 6455 §7.4: codes 1005 and 1006 are reserved and must not be sent in a Close frame */
function safeCloseCode(code: number): number {
  if (code === 1005 || code === 1006) return 1011;
  return code;
}

export { Sandbox };

// Main app
const app = new Hono<AppEnv>();

// =============================================================================
// MIDDLEWARE: Applied to ALL routes
// =============================================================================

// Middleware: Log every request
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  const redactedSearch = redactSensitiveParams(url);
  console.log(`[REQ] ${c.req.method} ${url.pathname}${redactedSearch}`);
  await next();
});

// Middleware: Security headers
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  );
});

// =============================================================================
// PUBLIC ROUTES: No authentication required
// =============================================================================

// Health checks, logos, static assets
app.route('/', publicRoutes);

// CDP routes (shared secret auth via query param)
app.route('/cdp', cdp);

// Auth routes (login/logout/me) — mounted before session middleware
// Login creates a session (doesn't need one); logout/me handle their own checks
app.route('/api/auth', auth);

// =============================================================================
// SESSION MIDDLEWARE: Verify session cookie, resolve per-user sandbox
// =============================================================================

app.use('*', async (c, next) => {
  // Dev mode: skip session auth, use a single sandbox
  if (c.env.DEV_MODE === 'true') {
    const options = buildSandboxOptions(c.env);
    const sandbox = getSandbox(c.env.Sandbox, 'dev-user', options);
    c.set('sandbox', sandbox);
    return next();
  }

  const sessionSecret = c.env.SESSION_SECRET;
  if (!sessionSecret) {
    return c.json({ error: 'Server not configured (missing SESSION_SECRET)' }, 500);
  }

  // Extract session token from cookie
  const cookieHeader = c.req.header('Cookie');
  const token = extractSessionToken(cookieHeader);

  if (!token) {
    // No session — serve SPA login page for HTML requests, 401 for API
    const acceptsHtml = c.req.header('Accept')?.includes('text/html');
    if (acceptsHtml) {
      try {
        const url = new URL('/index.html', c.req.url);
        return await c.env.ASSETS.fetch(new Request(url));
      } catch (err) {
        console.error('[SESSION] ASSETS.fetch failed:', err);
        return c.text('SPA not available. Run: make build', 500);
      }
    }
    return c.json({ error: 'Authentication required', hint: 'POST /api/auth/login' }, 401);
  }

  // Verify session token
  const poeUser = await verifySessionToken(token, sessionSecret);
  if (!poeUser) {
    const acceptsHtml = c.req.header('Accept')?.includes('text/html');
    if (acceptsHtml) {
      try {
        const url = new URL('/index.html', c.req.url);
        return await c.env.ASSETS.fetch(new Request(url));
      } catch (err) {
        console.error('[SESSION] ASSETS.fetch failed:', err);
        return c.text('SPA not available. Run: make build', 500);
      }
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

// Mount API routes
app.route('/api', api);

// Mount debug routes (session + DEBUG_ROUTES flag)
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

  // Build per-user env overrides for the container process
  const poeUser = c.get('poeUser');
  const envOverrides: Record<string, string> = {};
  if (poeUser?.userHash) {
    envOverrides.R2_USER_PREFIX = poeUser.userHash;
    envOverrides.OPENCLAW_DEV_MODE = 'true'; // Skip device pairing in PoeClaw mode

    // Decrypt per-user Poe API key from sandbox storage
    if (c.env.ENCRYPTION_SECRET) {
      try {
        const readResult = await sandbox.exec(
          'cat /tmp/poeclaw/encrypted-key 2>/dev/null || echo ""',
        );
        const encryptedKey = readResult.stdout?.trim();
        if (encryptedKey) {
          envOverrides.POE_API_KEY = await decryptApiKey(encryptedKey, c.env.ENCRYPTION_SECRET);
        }
      } catch (err) {
        console.error('[PROXY] Failed to decrypt POE_API_KEY:', err);
      }
    }
  }

  // Check if gateway is already running
  const existingProcess = await findExistingMoltbotProcess(sandbox);
  const isGatewayReady = existingProcess !== null && existingProcess.status === 'running';

  // For browser requests (non-WebSocket, non-API), show loading page if gateway isn't ready
  const isWebSocketRequest = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
  const acceptsHtml = request.headers.get('Accept')?.includes('text/html');

  if (!isGatewayReady && !isWebSocketRequest && acceptsHtml) {
    console.log('[PROXY] Gateway not ready, serving loading page');

    // Start the gateway in the background (don't await)
    c.executionCtx.waitUntil(
      ensureMoltbotGateway(sandbox, c.env, envOverrides).catch((err: Error) => {
        console.error('[PROXY] Background gateway start failed:', err);
      }),
    );

    // Return the loading page immediately
    return c.html(loadingPageHtml);
  }

  // Ensure gateway is running (this will wait for startup)
  try {
    await ensureMoltbotGateway(sandbox, c.env, envOverrides);
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

  // Proxy to gateway with WebSocket message interception
  if (isWebSocketRequest) {
    const debugLogs = c.env.DEBUG_ROUTES === 'true';
    const redactedSearch = redactSensitiveParams(url);

    console.log('[WS] Proxying WebSocket connection');
    if (debugLogs) {
      console.log('[WS] URL:', url.pathname + redactedSearch);
    }

    // Inject gateway token into WebSocket request if not already present.
    // Session auth replaces CF Access, so we inject the token server-side.
    let wsRequest = request;
    if (c.env.MOLTBOT_GATEWAY_TOKEN && !url.searchParams.has('token')) {
      const tokenUrl = new URL(url.toString());
      tokenUrl.searchParams.set('token', c.env.MOLTBOT_GATEWAY_TOKEN);
      wsRequest = new Request(tokenUrl.toString(), request);
    }

    // Get WebSocket connection to the container
    const containerResponse = await sandbox.wsConnect(wsRequest, MOLTBOT_PORT);
    console.log('[WS] wsConnect response status:', containerResponse.status);

    // Get the container-side WebSocket
    const containerWs = containerResponse.webSocket;
    if (!containerWs) {
      console.error('[WS] No WebSocket in container response - falling back to direct proxy');
      return containerResponse;
    }

    if (debugLogs) {
      console.log('[WS] Got container WebSocket, setting up interception');
    }

    // Create a WebSocket pair for the client
    const [clientWs, serverWs] = Object.values(new WebSocketPair());

    // Accept both WebSockets
    serverWs.accept();
    containerWs.accept();

    if (debugLogs) {
      console.log('[WS] Both WebSockets accepted');
      console.log('[WS] containerWs.readyState:', containerWs.readyState);
      console.log('[WS] serverWs.readyState:', serverWs.readyState);
    }

    // Relay messages from client to container
    serverWs.addEventListener('message', (event) => {
      if (debugLogs) {
        console.log(
          '[WS] Client -> Container:',
          typeof event.data,
          typeof event.data === 'string' ? event.data.slice(0, 200) : '(binary)',
        );
      }
      if (containerWs.readyState === WebSocket.OPEN) {
        containerWs.send(event.data);
      } else if (debugLogs) {
        console.log('[WS] Container not open, readyState:', containerWs.readyState);
      }
    });

    // Relay messages from container to client, with error transformation
    containerWs.addEventListener('message', (event) => {
      if (debugLogs) {
        console.log(
          '[WS] Container -> Client:',
          typeof event.data,
          typeof event.data === 'string' ? event.data.slice(0, 500) : '(binary)',
        );
      }
      let data = event.data;

      // Try to intercept and transform error messages
      if (typeof data === 'string') {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error?.message) {
            parsed.error.message = transformErrorMessage(parsed.error.message, url.host);
            data = JSON.stringify(parsed);
          }
        } catch {
          // Not JSON, pass through
        }
      }

      if (serverWs.readyState === WebSocket.OPEN) {
        serverWs.send(data);
      } else if (debugLogs) {
        console.log('[WS] Server not open, readyState:', serverWs.readyState);
      }
    });

    // Handle close events
    serverWs.addEventListener('close', (event) => {
      if (debugLogs) {
        console.log('[WS] Client closed:', event.code, event.reason);
      }
      containerWs.close(safeCloseCode(event.code), event.reason);
    });

    containerWs.addEventListener('close', (event) => {
      if (debugLogs) {
        console.log('[WS] Container closed:', event.code, event.reason);
      }
      // Transform the close reason (truncate to 123 bytes max for WebSocket spec)
      let reason = transformErrorMessage(event.reason, url.host);
      if (reason.length > 123) {
        reason = reason.slice(0, 120) + '...';
      }
      if (debugLogs) {
        console.log('[WS] Transformed close reason:', reason);
      }
      serverWs.close(safeCloseCode(event.code), reason);
    });

    // Handle errors
    serverWs.addEventListener('error', (event) => {
      console.error('[WS] Client error:', event);
      containerWs.close(1011, 'Client error');
    });

    containerWs.addEventListener('error', (event) => {
      console.error('[WS] Container error:', event);
      serverWs.close(1011, 'Container error');
    });

    if (debugLogs) {
      console.log('[WS] Returning intercepted WebSocket response');
    }
    return new Response(null, {
      status: 101,
      webSocket: clientWs,
    });
  }

  // Inject gateway token into HTTP request if not already present.
  // Session auth replaces CF Access, so we inject the token server-side.
  let httpRequest = request;
  if (c.env.MOLTBOT_GATEWAY_TOKEN && !url.searchParams.has('token')) {
    const tokenUrl = new URL(url.toString());
    tokenUrl.searchParams.set('token', c.env.MOLTBOT_GATEWAY_TOKEN);
    httpRequest = new Request(tokenUrl.toString(), request);
  }

  console.log('[HTTP] Proxying:', url.pathname + url.search);
  const httpResponse = await sandbox.containerFetch(httpRequest, MOLTBOT_PORT);

  return new Response(httpResponse.body, {
    status: httpResponse.status,
    statusText: httpResponse.statusText,
    headers: httpResponse.headers,
  });
});

export default {
  fetch: app.fetch,
};
