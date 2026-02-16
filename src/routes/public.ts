import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { MOLTBOT_PORT } from '../config';

/**
 * Public routes - NO authentication required
 *
 * These routes are mounted BEFORE the session middleware.
 * Includes: SPA shell, static assets, health checks.
 */
const publicRoutes = new Hono<AppEnv>();

// GET / - Serve the PoeClaw SPA (login or chat, handled client-side by App.tsx)
publicRoutes.get('/', async (c) => {
  try {
    // Request /index.html explicitly to avoid auto-trailing-slash redirects
    const url = new URL('/index.html', c.req.url);
    return await c.env.ASSETS.fetch(new Request(url));
  } catch (err) {
    console.error('[PUBLIC] ASSETS.fetch failed:', err);
    return c.text('SPA not available. Run: make build', 500);
  }
});

// GET /assets/* - Serve SPA static assets (JS, CSS bundles from Vite build)
publicRoutes.get('/assets/*', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /sandbox-health - Health check endpoint
publicRoutes.get('/sandbox-health', (c) => {
  return c.json({
    status: 'ok',
    service: 'poeclaw',
    gateway_port: MOLTBOT_PORT,
  });
});

// GET /logo.png - Serve logo from ASSETS binding
publicRoutes.get('/logo.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /logo-small.png - Serve small logo from ASSETS binding
publicRoutes.get('/logo-small.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export { publicRoutes };
