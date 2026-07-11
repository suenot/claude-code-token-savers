import { useEffect, useRef } from 'react';

// Standard React useInterval hook (Dan Abramov pattern): keeps the latest
// callback in a ref so the interval itself doesn't need to be torn down and
// recreated every time the callback identity changes.
export function useInterval(callback: () => void, delayMs: number | null): void {
  const savedCallback = useRef(callback);

  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    if (delayMs === null) {
      return;
    }
    const id = setInterval(() => {
      savedCallback.current();
    }, delayMs);
    return () => clearInterval(id);
  }, [delayMs]);
}
