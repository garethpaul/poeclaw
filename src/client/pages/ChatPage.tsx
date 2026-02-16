import { useState, useRef, useEffect } from 'react';
import { useChat } from '../hooks/useChat';
import { useGatewayStatus } from '../hooks/useGatewayStatus';
import './ChatPage.css';

interface ChatPageProps {
  models: Array<{ id: string; name: string }>;
  keyLast4: string;
  onLogout: () => void;
}

export function ChatPage({ models, keyLast4, onLogout }: ChatPageProps) {
  const [selectedModel, setSelectedModel] = useState(models[0]?.id || '');
  const { status, isReady } = useGatewayStatus(true);
  const { messages, sendMessage, isStreaming, stopStreaming, clearMessages } =
    useChat(selectedModel);
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isStreaming || !isReady) return;
    sendMessage(input.trim());
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    onLogout();
  };

  return (
    <div className="chat-layout">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <h2>PoeClaw</h2>
        </div>

        <div className="model-selector">
          <label>Model</label>
          <select
            value={selectedModel}
            onChange={(e) => {
              setSelectedModel(e.target.value);
              clearMessages();
            }}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>

        <button className="new-chat-btn" onClick={clearMessages}>
          New Chat
        </button>

        <div className="sidebar-footer">
          <span className="user-badge">***...{keyLast4}</span>
          <button className="logout-btn" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </aside>

      {/* Main chat area */}
      <main className="chat-main">
        {!isReady ? (
          <div className="boot-status">
            <div className="spinner" />
            <p>
              {status === 'booting'
                ? 'Starting your sandbox... This may take a minute.'
                : status === 'error'
                  ? 'Error connecting. Retrying...'
                  : 'Checking status...'}
            </p>
          </div>
        ) : (
          <>
            <div className="messages">
              {messages.length === 0 && (
                <div className="empty-state">
                  <h3>Start a conversation</h3>
                  <p>Send a message to begin chatting with {selectedModel}</p>
                </div>
              )}
              {/* eslint-disable-next-line react/no-array-index-key -- chat messages have no stable ID */}
              {messages.map((msg, i) => (
                <div key={i} className={`message message-${msg.role}`}>
                  <div className="message-role">{msg.role === 'user' ? 'You' : selectedModel}</div>
                  <div className="message-content">{msg.content || '...'}</div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            <form className="input-bar" onSubmit={handleSubmit}>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={`Message ${selectedModel}...`}
                rows={1}
                disabled={isStreaming}
              />
              {isStreaming ? (
                <button type="button" className="stop-btn" onClick={stopStreaming}>
                  Stop
                </button>
              ) : (
                <button type="submit" disabled={!input.trim()}>
                  Send
                </button>
              )}
            </form>
          </>
        )}
      </main>
    </div>
  );
}
