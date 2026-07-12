import { useState, type ReactNode } from 'react';
import { Icon } from './components/Icon.tsx';
import { ChainView } from './views/ChainView.tsx';
import { HarnessView } from './views/HarnessView.tsx';
import { JobsView } from './views/JobsView.tsx';
import { GraphView } from './views/GraphView.tsx';
import { ConfigView } from './views/ConfigView.tsx';
import { SavingsView } from './views/SavingsView.tsx';
import { RequestFeedView } from './views/RequestFeedView.tsx';
import { MonitorsView } from './views/MonitorsView.tsx';
import { TogglesView } from './views/TogglesView.tsx';
import { CompareView } from './views/CompareView.tsx';

type Tab = {
  id: string;
  label: string;
  icon: string;
  title: string;
  sub: string;
  render: () => ReactNode;
};

type Group = { label: string; icon: string; tabs: Tab[] };

const GROUPS: Group[] = [
  {
    label: 'Pipeline',
    icon: 'chain',
    tabs: [
      { id: 'chain', label: 'Chain', icon: 'chain', title: 'Chain', sub: 'The proxy stages currently wired behind ANTHROPIC_BASE_URL.', render: () => <ChainView /> },
      { id: 'toggles', label: 'Toggles', icon: 'toggles', title: 'Toggles', sub: 'Flip stages on or off at runtime — no restart for live stages.', render: () => <TogglesView /> },
      { id: 'config', label: 'Config', icon: 'config', title: 'Config', sub: 'The resolved shuba configuration (secrets redacted).', render: () => <ConfigView /> },
    ],
  },
  {
    label: 'Telemetry',
    icon: 'usage',
    tabs: [
      { id: 'usage', label: 'Usage', icon: 'usage', title: 'Usage', sub: 'A cross-stage ledger of tokens saved, per model and per stage.', render: () => <SavingsView /> },
      { id: 'requests', label: 'Requests', icon: 'requests', title: 'Requests', sub: 'What actually left for the API, hop by hop.', render: () => <RequestFeedView /> },
      { id: 'monitors', label: 'Monitors', icon: 'monitors', title: 'Monitors', sub: 'Live stage health.', render: () => <MonitorsView /> },
    ],
  },
  {
    label: 'Delegation',
    icon: 'jobs',
    tabs: [
      { id: 'jobs', label: 'Jobs', icon: 'jobs', title: 'Jobs', sub: 'Tasks delegated to coding harnesses and their results.', render: () => <JobsView /> },
      { id: 'harnesses', label: 'Harnesses', icon: 'harness', title: 'Harnesses', sub: 'Installed coding harnesses shuba can delegate to.', render: () => <HarnessView /> },
      { id: 'graph', label: 'Graph', icon: 'graph', title: 'Graph', sub: 'Query the repo knowledge graph instead of reading files.', render: () => <GraphView /> },
    ],
  },
  {
    label: 'Info',
    icon: 'compare',
    tabs: [
      { id: 'compare', label: 'Compare', icon: 'compare', title: 'Compare', sub: 'shuba vs adjacent Claude Code token/runtime tools.', render: () => <CompareView /> },
    ],
  },
];

const ALL_TABS = GROUPS.flatMap((g) => g.tabs);

export function App() {
  const [activeId, setActiveId] = useState<string>(ALL_TABS[0].id);
  const active = ALL_TABS.find((t) => t.id === activeId) ?? ALL_TABS[0];
  const activeGroup = GROUPS.find((g) => g.tabs.some((t) => t.id === activeId)) ?? GROUPS[0];

  return (
    <div className="shell">
      <nav className="rail" aria-label="Sections">
        <div className="rail-logo" title="shuba">
          <Icon name="logo" size={19} />
        </div>
        {GROUPS.map((g) => (
          <button
            key={g.label}
            type="button"
            className={`rail-icon${g === activeGroup ? ' active' : ''}`}
            title={g.label}
            onClick={() => setActiveId(g.tabs[0].id)}
          >
            <Icon name={g.icon} size={18} />
          </button>
        ))}
      </nav>

      <aside className="sidebar">
        <div className="sidebar-title">Console</div>
        {GROUPS.map((g) => (
          <div key={g.label} className="nav-group">
            <div className="nav-label">{g.label}</div>
            {g.tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`nav-item${t.id === activeId ? ' active' : ''}`}
                onClick={() => setActiveId(t.id)}
              >
                <Icon name={t.icon} />
                {t.label}
              </button>
            ))}
          </div>
        ))}
      </aside>

      <main className="content">
        <header className="page-header">
          <h1 className="page-title">{active.title}</h1>
          <p className="page-sub">{active.sub}</p>
        </header>
        <div className="content-body">{active.render()}</div>
      </main>
    </div>
  );
}
