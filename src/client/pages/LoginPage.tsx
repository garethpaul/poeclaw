import { useState } from 'react';
import './LoginPage.css';

interface LoginPageProps {
  onLogin: (data: { userHash: string; keyLast4: string; models: Array<{ id: string; name: string }> }) => void;
}

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
      const data = await res.json() as { error?: string; userHash: string; keyLast4: string; models: Array<{ id: string; name: string }> };

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
    <div className="login-container">
      <div className="login-card">
        <div className="login-brand">
          <h1>PoeClaw</h1>
          <p className="login-tagline">Your AI agent, powered by Poe</p>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
          <div className="input-group">
            <label htmlFor="api-key">Poe API Key</label>
            <input
              id="api-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="pb-..."
              disabled={loading}
              autoFocus
              autoComplete="off"
            />
            <a
              className="key-link"
              href="https://poe.com/api_key"
              target="_blank"
              rel="noopener noreferrer"
            >
              Get your API key
            </a>
          </div>

          <button type="submit" className="login-submit" disabled={loading || !apiKey.trim()}>
            {loading ? 'Validating...' : 'Connect'}
          </button>

          {error && <p className="login-error">{error}</p>}
        </form>

        <p className="login-footer">
          Your key is encrypted and stored only in your sandbox container.
        </p>
      </div>
    </div>
  );
}
