import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validatePoeApiKey } from './poe';

describe('validatePoeApiKey', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects empty key', async () => {
    // Threat model: format checks must reject before any network call
    const fetchMock = vi.fn().mockRejectedValue(new Error('should not call fetch'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await validatePoeApiKey('');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/empty/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects key without proper prefix', async () => {
    // Threat model: format checks must reject before any network call
    const fetchMock = vi.fn().mockRejectedValue(new Error('should not call fetch'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await validatePoeApiKey('not-a-poe-key');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/format/i);
    expect(fetchMock).not.toHaveBeenCalled();
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
