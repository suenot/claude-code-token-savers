import { useCallback, useEffect, useRef, useState } from 'react';
import { openLogStream } from '../api.ts';

type UseLogStream = {
  lines: string[];
  start: (id: string) => void;
  stop: () => void;
};

// useLogStream wraps openLogStream (a raw WebSocket over /api/stream/logs/:id)
// in React state: start(id) opens a stream and accumulates chunks into
// `lines`, stop() closes it. Any previously open stream is closed before a
// new one starts, and the stream is closed automatically on unmount.
export function useLogStream(): UseLogStream {
  const [lines, setLines] = useState<string[]>([]);
  const closeRef = useRef<(() => void) | null>(null);

  const stop = useCallback(() => {
    if (closeRef.current) {
      closeRef.current();
      closeRef.current = null;
    }
  }, []);

  const start = useCallback(
    (id: string) => {
      stop();
      setLines([]);
      closeRef.current = openLogStream(id, (chunk) => {
        setLines((prev) => [...prev, chunk]);
      });
    },
    [stop],
  );

  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  return { lines, start, stop };
}
