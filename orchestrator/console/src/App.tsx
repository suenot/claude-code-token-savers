import { useState } from 'react';
import { ChainView } from './views/ChainView.tsx';
import { HarnessView } from './views/HarnessView.tsx';
import { JobsView } from './views/JobsView.tsx';
import { GraphView } from './views/GraphView.tsx';
import { ConfigView } from './views/ConfigView.tsx';
import { SavingsView } from './views/SavingsView.tsx';

const TABS = ['Chain', 'Harnesses', 'Jobs', 'Graph', 'Config', 'Savings'] as const;
type Tab = (typeof TABS)[number];

function renderTab(tab: Tab) {
  switch (tab) {
    case 'Chain':
      return <ChainView />;
    case 'Harnesses':
      return <HarnessView />;
    case 'Jobs':
      return <JobsView />;
    case 'Graph':
      return <GraphView />;
    case 'Config':
      return <ConfigView />;
    case 'Savings':
      return <SavingsView />;
    default:
      return null;
  }
}

export function App() {
  const [activeTab, setActiveTab] = useState<Tab>(TABS[0]);

  return (
    <div>
      <h1>shuba console</h1>
      <nav style={{ marginBottom: '16px' }}>
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            disabled={tab === activeTab}
            style={{ marginRight: '8px' }}
          >
            {tab}
          </button>
        ))}
      </nav>
      {renderTab(activeTab)}
    </div>
  );
}
