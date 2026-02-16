import type { SandboxOptions } from '@cloudflare/sandbox';
import type { MoltbotEnv } from './types';

/**
 * Configuration constants for Moltbot Sandbox
 */

/** Port that the Moltbot gateway listens on inside the container */
export const MOLTBOT_PORT = 18789;

/** Maximum time to wait for Moltbot to start (3 minutes) */
export const STARTUP_TIMEOUT_MS = 180_000;

/**
 * R2 bucket name for persistent storage.
 * Can be overridden via R2_BUCKET_NAME env var for test isolation.
 */
export function getR2BucketName(env?: { R2_BUCKET_NAME?: string }): string {
  return env?.R2_BUCKET_NAME || 'moltbot-data';
}

/**
 * Build sandbox options for multi-tenant PoeClaw.
 * Default is sleepAfter '1h' to bound per-user container memory.
 * Use 'never' (keepAlive) only for single-tenant dev mode.
 */
export function buildSandboxOptions(env: MoltbotEnv): SandboxOptions {
  const sleepAfter = env.SANDBOX_SLEEP_AFTER?.toLowerCase() || '1h';

  if (sleepAfter === 'never') {
    return { keepAlive: true };
  }

  return { sleepAfter };
}
