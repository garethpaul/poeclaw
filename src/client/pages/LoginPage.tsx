import { useState } from 'react';
import './LoginPage.css';

interface LoginPageProps {
  onLogin: (data: {
    userHash: string;
    keyLast4: string;
    models: Array<{ id: string; name: string }>;
  }) => void;
}

const MODEL_TAGS = [
  { name: 'Claude-Opus', x: 12, y: 18, size: 0.85, opacity: 0.35, delay: 0 },
  { name: 'GPT-5.2', x: 58, y: 10, size: 0.75, opacity: 0.2, delay: -5 },
  { name: 'Gemini-3-Pro', x: 22, y: 62, size: 0.9, opacity: 0.4, delay: -10 },
  { name: 'DALL-E-3', x: 68, y: 52, size: 0.7, opacity: 0.15, delay: -3 },
  { name: 'Llama-3', x: 42, y: 78, size: 0.8, opacity: 0.3, delay: -8 },
  { name: 'Mixtral', x: 8, y: 42, size: 0.95, opacity: 0.45, delay: -12 },
  { name: 'Sora-2-Pro', x: 75, y: 30, size: 0.7, opacity: 0.2, delay: -15 },
  { name: 'DeepSeek-R1', x: 35, y: 35, size: 0.75, opacity: 0.18, delay: -7 },
];

export function LoginPage({ onLogin }: LoginPageProps) {
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      const data = (await res.json()) as {
        error?: string;
        userHash: string;
        keyLast4: string;
        models: Array<{ id: string; name: string }>;
      };

      if (!res.ok) {
        setError(data.error || 'Login failed');
        return;
      }

      onLogin(data);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-showcase" aria-hidden="true">
        {MODEL_TAGS.map((tag) => (
          <span
            key={tag.name}
            className="model-tag"
            style={
              {
                '--x': `${tag.x}%`,
                '--y': `${tag.y}%`,
                '--size': `${tag.size}rem`,
                '--opacity': tag.opacity,
                '--delay': `${tag.delay}s`,
              } as React.CSSProperties
            }
          >
            {tag.name}
          </span>
        ))}
        <div className="login-showcase-brand">
          <h1>PoeClaw</h1>
          <p className="login-tagline">Your AI agent, powered by Poe</p>
        </div>
      </div>

      <main className="login-panel">
        <form className="login-form" onSubmit={handleSubmit} aria-busy={loading}>
          <div className="input-group">
            <label htmlFor="api-key">Poe API Key</label>
            <input
              id="api-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Your Poe API key"
              disabled={loading}
              required
              aria-required="true"
              autoFocus
              autoComplete="off"
            />
            <a
              className="key-link"
              href="https://poe.com/api_key"
              target="_blank"
              rel="noopener noreferrer"
            >
              Get your API key<span className="sr-only"> (opens in new tab)</span>
            </a>
          </div>

          <button type="submit" className="login-submit" disabled={loading || !apiKey.trim()}>
            {loading ? 'Validating...' : 'Connect'}
          </button>

          <div role="alert" aria-live="assertive" className="login-error-container">
            {error && <p className="login-error">{error}</p>}
          </div>
        </form>

        <p className="login-footer">
          Your key is encrypted and stored only in your sandbox container.
        </p>
      </main>
    </div>
  );
}
