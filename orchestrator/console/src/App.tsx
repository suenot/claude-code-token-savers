import { useState } from "react";

const TABS = ["Overview", "Sessions", "Events", "Config"] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const [activeTab, setActiveTab] = useState<Tab>(TABS[0]);

  return (
    <div>
      <h1>shuba console</h1>
      <nav>
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            disabled={tab === activeTab}
          >
            {tab}
          </button>
        ))}
      </nav>
      <p>Active tab: {activeTab}</p>
    </div>
  );
}
