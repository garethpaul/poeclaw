import { useState, useCallback, useRef } from 'react';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * SSE streaming chat hook.
 * Sends messages to /v1/chat/completions and streams the response.
 */
export function useChat(model: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(
    async (userMessage: string) => {
      const userMsg: ChatMessage = { role: 'user', content: userMessage };
      const updatedMessages = [...messages, userMsg];
      setMessages([...updatedMessages, { role: 'assistant', content: '' }]);
      setIsStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch('/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: updatedMessages.map((m) => ({ role: m.role, content: m.content })),
            stream: true,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errData = (await response.json().catch(() => ({}))) as {
            error?: { message?: string };
          };
          throw new Error(errData.error?.message || `HTTP ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response body');

        const decoder = new TextDecoder();
        let assistantContent = '';
        let buffer = '';

        // eslint-disable-next-line no-await-in-loop -- sequential SSE stream reads
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                assistantContent += delta;
                setMessages([...updatedMessages, { role: 'assistant', content: assistantContent }]);
              }
            } catch {
              // Skip unparseable SSE lines
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setMessages([
          ...updatedMessages,
          { role: 'assistant', content: `Error: ${(err as Error).message}` },
        ]);
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [messages, model],
  );

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  return { messages, sendMessage, isStreaming, stopStreaming, clearMessages };
}
