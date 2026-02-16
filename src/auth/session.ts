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
 * Create a signed session token (base64 of payload + HMAC signature).
 */
export async function createSessionToken(payload: PoeSessionUser, secret: string): Promise<string> {
  const payloadStr = JSON.stringify(payload);
  const payloadB64 = btoa(payloadStr);
  const key = await deriveHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return `${payloadB64}.${sigB64}`;
}

/**
 * Verify and decode a session token. Returns null if invalid or expired.
 * Uses crypto.subtle.verify for timing-safe comparison.
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
 * Encrypt an API key with AES-GCM for storage.
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
