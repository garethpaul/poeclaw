import { describe, it, expect } from 'vitest';
import {
  createSessionToken,
  verifySessionToken,
  hashApiKey,
  encryptApiKey,
  decryptApiKey,
  buildSessionCookie,
  clearSessionCookie,
  extractSessionToken,
} from './session';

/**
 * Threat model: Session management is security-critical.
 * - Token tampering must be detected (HMAC verification)
 * - Expired sessions must be rejected
 * - API key encryption must be reversible only with correct secret
 * - Cookie format must be HttpOnly + Secure
 */

const TEST_SESSION_SECRET = 'test-session-secret-32-chars-ok!';
const TEST_ENCRYPTION_SECRET = 'test-encrypt-secret-32-chars-ok!';

describe('hashApiKey', () => {
  it('produces a consistent hex hash', async () => {
    const hash1 = await hashApiKey('pb-test-key-12345');
    const hash2 = await hashApiKey('pb-test-key-12345');
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{63}$/); // SHA-256 hex truncated to 63 chars (sandbox ID limit)
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
    await expect(decryptApiKey(encrypted, 'wrong-secret-wrong-secret-12345')).rejects.toThrow(
      /operation/i,
    );
  });
});

describe('cookie helpers', () => {
  it('buildSessionCookie sets HttpOnly, Secure, SameSite', () => {
    const cookie = buildSessionCookie('my-token');
    expect(cookie).toContain('poeclaw_session=my-token');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=86400');
    expect(cookie).toContain('Path=/');
  });

  it('clearSessionCookie sets Max-Age=0', () => {
    const cookie = clearSessionCookie();
    expect(cookie).toContain('poeclaw_session=');
    expect(cookie).toContain('Max-Age=0');
  });

  it('extractSessionToken parses cookie header', () => {
    const token = extractSessionToken('other=foo; poeclaw_session=abc123; bar=baz');
    expect(token).toBe('abc123');
  });

  it('extractSessionToken returns null when missing', () => {
    expect(extractSessionToken('other=foo')).toBeNull();
    expect(extractSessionToken(undefined)).toBeNull();
  });
});
