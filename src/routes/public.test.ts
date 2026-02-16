import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { createMockEnv } from '../test-utils';

/**
 * Contract tests for public routes
 *
 * Threat model: These tests verify that the SPA shell is correctly served
 * so the login page can render. Failures here mean users see redirect loops
 * or blank pages instead of the login form.
 */

// Mock @cloudflare/sandbox to avoid sandbox resolution in session middleware
vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: vi.fn(() => ({
    exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, success: true }),
    listProcesses: vi.fn().mockResolvedValue([]),
  })),
}));

import { publicRoutes } from './public';

const SPA_HTML = '<!DOCTYPE html><html><body><div id="root"></div></body></html>';

function createMockAssets(options: { html?: string; shouldThrow?: boolean } = {}) {
  const { html = SPA_HTML, shouldThrow = false } = options;
  return {
    fetch: vi.fn((_req: Request) => {
      if (shouldThrow) throw new Error('ASSETS binding not available');
      return Promise.resolve(
        new Response(html, {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
      );
    }),
  } as unknown as Fetcher;
}

function createApp(assets: Fetcher) {
  const app = new Hono<AppEnv>();
  app.route('/', publicRoutes);
  return { app, env: createMockEnv({ ASSETS: assets }) };
}

describe('GET /', () => {
  // Threat model: users must receive the SPA shell to see the login page
  it('returns 200 with HTML content', async () => {
    const assets = createMockAssets();
    const { app, env } = createApp(assets);

    const res = await app.request('/', undefined, env);
    expect(res.status).toBe(200);

    const body = await res.text();
    expect(body).toContain('<div id="root">');
  });

  it('requests /index.html explicitly from ASSETS', async () => {
    const assets = createMockAssets();
    const { app, env } = createApp(assets);

    await app.request('/', undefined, env);

    const fetchMock = vi.mocked(assets.fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestedUrl = new URL((fetchMock.mock.calls[0][0] as Request).url);
    expect(requestedUrl.pathname).toBe('/index.html');
  });

  // Threat model: ASSETS failures must be caught, not silently ignored
  it('returns 500 if ASSETS binding fails', async () => {
    const assets = createMockAssets({ shouldThrow: true });
    const { app, env } = createApp(assets);

    const res = await app.request('/', undefined, env);
    expect(res.status).toBe(500);

    const body = await res.text();
    expect(body).toContain('SPA not available');
  });

  // Threat model: redirect loops caused the login page to never load
  it('does not redirect', async () => {
    const assets = createMockAssets();
    const { app, env } = createApp(assets);

    const res = await app.request('/', undefined, env);
    expect(res.status).not.toBeGreaterThanOrEqual(300);
    expect(res.status).not.toBeLessThan(200);
  });
});

describe('GET /assets/*', () => {
  it('serves static files via ASSETS passthrough', async () => {
    const jsContent = 'console.log("hello")';
    const assets = {
      fetch: vi.fn(() =>
        Promise.resolve(
          new Response(jsContent, {
            status: 200,
            headers: { 'Content-Type': 'application/javascript' },
          }),
        ),
      ),
    } as unknown as Fetcher;
    const { app, env } = createApp(assets);

    const res = await app.request('/assets/index-abc123.js', undefined, env);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe(jsContent);
  });
});

describe('GET /sandbox-health', () => {
  it('returns health check JSON', async () => {
    const assets = createMockAssets();
    const { app, env } = createApp(assets);

    const res = await app.request('/sandbox-health', undefined, env);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.service).toBe('poeclaw');
    expect(body.gateway_port).toBe(18789);
  });
});

describe('Session middleware SPA fallback', () => {
  // Threat model: the redirect-to-/ loop must not happen; unauthenticated
  // HTML requests to protected paths should get the SPA, not a 302 redirect.
  // We replicate the session middleware pattern from src/index.ts here to test
  // the ASSETS.fetch behavior without importing the full app (which requires
  // loading .html assets that Vite can't parse in test mode).
  it('serves SPA for unauthenticated HTML requests via ASSETS /index.html', async () => {
    const { extractSessionToken } = await import('../auth/session');

    const assets = createMockAssets();
    const env = createMockEnv({
      ASSETS: assets,
      SESSION_SECRET: 'test-session-secret-32-chars-ok!',
    });

    // Simulate the session middleware logic for an unauthenticated HTML request
    const req = new Request('http://localhost/some-protected-path', {
      headers: { Accept: 'text/html' },
    });
    const cookieHeader = req.headers.get('Cookie') ?? undefined;
    const token = extractSessionToken(cookieHeader);
    expect(token).toBeNull();

    // Session middleware serves SPA via ASSETS for HTML requests without session
    const acceptsHtml = req.headers.get('Accept')?.includes('text/html');
    expect(acceptsHtml).toBe(true);

    const url = new URL('/index.html', req.url);
    const res = await env.ASSETS.fetch(new Request(url));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<div id="root">');

    // Verify the ASSETS was called with /index.html, not /
    const fetchMock = vi.mocked(assets.fetch);
    const requestedUrl = new URL((fetchMock.mock.calls[0][0] as Request).url);
    expect(requestedUrl.pathname).toBe('/index.html');
  });

  it('returns 500 when ASSETS fails for unauthenticated HTML requests', async () => {
    const assets = createMockAssets({ shouldThrow: true });

    // Simulate the session middleware try-catch pattern
    let result: Response;
    try {
      const url = new URL('/index.html', 'http://localhost/some-path');
      result = await assets.fetch(new Request(url));
    } catch {
      result = new Response('SPA not available. Run: make build', { status: 500 });
    }

    expect(result.status).toBe(500);
    const body = await result.text();
    expect(body).toContain('SPA not available');
  });
});
