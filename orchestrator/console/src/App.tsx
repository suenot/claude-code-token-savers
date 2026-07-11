import { useState } from 'react';
import { ChainView } from './views/ChainView.tsx';
import { HarnessView } from './views/HarnessView.tsx';

const TABS = ['Chain', 'Harnesses'] as const;
type Tab = (typeof TABS)[number];

function renderTab(tab: Tab) {
  switch (tab) {
    case 'Chain':
      return <ChainView />;
    case 'Harnesses':
      return <HarnessView />;
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
