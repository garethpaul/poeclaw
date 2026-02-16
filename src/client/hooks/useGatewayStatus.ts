import { useState, useEffect, useRef } from 'react';

export type GatewayStatus = 'unknown' | 'booting' | 'running' | 'error';

/**
 * Poll /api/status to track container boot progress.
 * Returns current status and a flag for when it's ready.
 */
export function useGatewayStatus(enabled: boolean) {
  const [status, setStatus] = useState<GatewayStatus>('unknown');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const check = async () => {
      try {
        const res = await fetch('/api/status');
        const data: { ok?: boolean; status?: string } = await res.json();
        if (data.ok && data.status === 'running') {
          setStatus('running');
          if (intervalRef.current) clearInterval(intervalRef.current);
        } else {
          setStatus('booting');
        }
      } catch {
        setStatus('error');
      }
    };

    check(); // Immediate check
    intervalRef.current = setInterval(check, 3000); // Poll every 3s

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [enabled]);

  return { status, isReady: status === 'running' };
}
