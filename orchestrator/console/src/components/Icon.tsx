// Icons from lucide-react (bundled locally into main.js — no CDN/network, which
// matters since the console is served through the control proxy). A small name
// map keeps the call sites (`<Icon name="chain" />`) stable.

import {
  Link2,
  SlidersHorizontal,
  Settings,
  Wrench,
  Activity,
  List,
  MonitorDot,
  Boxes,
  Server,
  Share2,
  Columns2,
  Snowflake,
  type LucideIcon,
} from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  chain: Link2,
  settings: Wrench,
  toggles: SlidersHorizontal,
  config: Settings,
  usage: Activity,
  requests: List,
  monitors: MonitorDot,
  jobs: Boxes,
  harness: Server,
  graph: Share2,
  compare: Columns2,
  logo: Snowflake,
};

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const Cmp = ICONS[name] ?? Activity;
  return <Cmp size={size} strokeWidth={1.8} aria-hidden="true" />;
}
