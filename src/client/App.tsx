import { useState, useEffect } from 'react';
import { LoginPage } from './pages/LoginPage';
import { ChatPage } from './pages/ChatPage';
import './App.css';

interface SessionInfo {
  userHash: string;
  keyLast4: string;
  models: Array<{ id: string; name: string }>;
}

export default function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((res) => res.json() as Promise<SessionInfo & { authenticated: boolean }>)
      .then((data) => {
        if (data.authenticated) {
          setSession({
            userHash: data.userHash,
            keyLast4: data.keyLast4,
            models: data.models,
          });
        }
      })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);

  if (checking) {
    return (
      <div className="app-loading">
        <div className="spinner" />
      </div>
    );
  }

  if (!session) {
    return <LoginPage onLogin={setSession} />;
  }

  return (
    <ChatPage
      models={session.models}
      keyLast4={session.keyLast4}
      onLogout={() => setSession(null)}
    />
  );
}
