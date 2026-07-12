// Minimal inline stroke icons (16px, currentColor) for the console nav + rail.
// Kept as raw path data so the bundle stays dependency-free.

const PATHS: Record<string, string> = {
  chain: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  toggles: 'M4 8h10M17 8h3M8 8a2 2 0 1 0 0 .01M4 16h3M10 16h10M8 16a2 2 0 1 0 .01 0',
  config: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M12 3v2M12 19v2M5 5l1.5 1.5M17.5 17.5 19 19M3 12h2M19 12h2M5 19l1.5-1.5M17.5 6.5 19 5',
  usage: 'M3 12h4l2 6 4-14 2 8h6',
  requests: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  monitors: 'M3 12h3l2-7 4 14 2-9 2 2h5',
  jobs: 'M4 7l8-4 8 4-8 4-8-4ZM4 7v10l8 4 8-4V7',
  harness: 'M4 5h16v5H4zM4 14h16v5H4zM8 7.5h.01M8 16.5h.01',
  graph: 'M6 9a2 2 0 1 0 0-.01M18 6a2 2 0 1 0 0-.01M18 18a2 2 0 1 0 0-.01M8 8l8-2M8 10l8 6',
  compare: 'M4 4h7v16H4zM13 4h7v16h-7z',
  logo: 'M12 3l2.5 4.5L19 8l-3 3 1 5-5-2.5L7 16l1-5-3-3 4.5-.5z',
};

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const d = PATHS[name] ?? PATHS.usage;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}
