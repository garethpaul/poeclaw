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

  if (!apiKey.startsWith('pb-') || apiKey.length < 10 || /\s/.test(apiKey)) {
    return { valid: false, error: 'Invalid key format — Poe keys start with "pb-"' };
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
      name: m.id,
    }));

    return { valid: true, models };
  } catch (err) {
    return {
      valid: false,
      error: `Failed to reach Poe API: ${err instanceof Error ? err.message : 'Unknown error'}`,
    };
  }
}
