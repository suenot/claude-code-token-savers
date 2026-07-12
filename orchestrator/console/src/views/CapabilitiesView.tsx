import { useCallback, useEffect, useState } from 'react';
import {
  getCapabilities,
  scanCapabilities,
  importCapabilities,
  ejectCapability,
  toggleCapability,
  type Capability,
  type CapabilityLeftover,
  type CapabilityType,
  type CapabilitiesResponse,
} from '../api.ts';
import { Card } from '../components/Card.tsx';
import { useInterval } from '../hooks/useInterval.ts';

const POLL_MS = 5000;

// Fixed display order + labels for the four capability kinds, so the grouped
// table is stable regardless of the order the backend returns items in.
const TYPE_ORDER: CapabilityType[] = ['skill', 'agent', 'mcp', 'plugin'];
const TYPE_LABEL: Record<CapabilityType, string> = {
  skill: 'Skills',
  agent: 'Agents',
  mcp: 'MCP servers',
  plugin: 'Plugins',
};

const cellStyle = { padding: '8px 10px', verticalAlign: 'top' as const };
const headStyle = { padding: '6px 10px', borderBottom: '1px solid var(--border-soft)', fontSize: '12px' };

function truncate(text: string, max = 120): string {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// A small pill used for the capability type and enabled/disabled state.
function Pill({ text, tone }: { text: string; tone: 'ok' | 'muted' | 'accent' }) {
  const color = tone === 'ok' ? 'var(--ok)' : tone === 'accent' ? 'var(--accent)' : 'var(--muted)';
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '1px 8px',
        borderRadius: '10px',
        fontSize: '11.5px',
        color,
        border: `1px solid ${color}`,
        opacity: 0.9,
      }}
    >
      {text}
    </span>
  );
}

export function CapabilitiesView() {
  const [data, setData] = useState<CapabilitiesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Row-level in-flight guard (id being toggled/ejected), plus a global busy
  // flag for scan / take-over-all so their buttons disable while running.
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // When set, the take-over confirmation is showing the list about to move.
  const [confirmTakeover, setConfirmTakeover] = useState(false);
  // id awaiting eject confirmation.
  const [confirmEjectId, setConfirmEjectId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    getCapabilities()
      .then((res) => {
        setData(res);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);
  useInterval(refresh, POLL_MS);

  const apply = (res: CapabilitiesResponse, msg: string) => {
    setData(res);
    setError(null);
    setMessage(msg);
  };
  const fail = (err: unknown) => setError(err instanceof Error ? err.message : String(err));

  const handleScan = useCallback(() => {
    setBusy(true);
    setMessage(null);
    scanCapabilities()
      .then((res) => {
        setMessage(
          res.leftovers.length === 0
            ? 'Scan complete — nothing left in Claude Code.'
            : `Scan found ${res.leftovers.length} capabilit${res.leftovers.length === 1 ? 'y' : 'ies'} still in Claude Code.`,
        );
        refresh();
      })
      .catch(fail)
      .finally(() => setBusy(false));
  }, [refresh]);

  const handleTakeoverAll = useCallback(() => {
    setBusy(true);
    setConfirmTakeover(false);
    setMessage(null);
    importCapabilities()
      .then((res) => apply(res, 'Took over all capabilities from Claude Code.'))
      .catch(fail)
      .finally(() => setBusy(false));
  }, []);

  const handleToggle = useCallback((cap: Capability) => {
    const next = !cap.enabled;
    setPendingId(cap.id);
    setMessage(null);
    toggleCapability(cap.id, next)
      .then((res) => apply(res, `${cap.name} → ${next ? 'enabled' : 'disabled'}`))
      .catch(fail)
      .finally(() => setPendingId(null));
  }, []);

  const handleEject = useCallback((cap: Capability) => {
    setPendingId(cap.id);
    setConfirmEjectId(null);
    setMessage(null);
    ejectCapability(cap.id)
      .then((res) => apply(res, `${cap.name} restored to Claude Code.`))
      .catch(fail)
      .finally(() => setPendingId(null));
  }, []);

  const manifest = data?.manifest ?? [];
  // Optional-chain through verify too: an unexpected response shape must
  // degrade to an empty view, not crash the whole console tab.
  const leftovers = data?.verify?.leftovers ?? [];
  const clean = data?.verify?.clean ?? true;

  const byType = (type: CapabilityType): Capability[] => manifest.filter((c) => c.type === type);

  return (
    <>
      {/* ---- status banner ---- */}
      {data && (
        <div
          className="banner"
          style={{
            borderColor: clean ? 'var(--ok)' : 'var(--warn)',
            background: clean ? 'rgba(74,222,128,0.10)' : 'rgba(224,161,58,0.12)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '14px',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ color: clean ? 'var(--ok)' : 'var(--warn)', fontWeight: 600 }}>
            {clean
              ? '✓ Claude Code clean — every capability lives in shuba.'
              : `⚠ ${leftovers.length} capabilit${leftovers.length === 1 ? 'y' : 'ies'} still in Claude Code.`}
          </span>
          {!clean && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                setConfirmTakeover(true);
                setMessage(null);
              }}
            >
              Take over all
            </button>
          )}
        </div>
      )}

      {/* ---- take-over confirmation ---- */}
      {confirmTakeover && (
        <Card title="Take over all capabilities?">
          <p style={{ fontSize: '13px', color: 'var(--muted)', margin: '0 0 10px' }}>
            The following will be moved out of Claude Code and into shuba:
          </p>
          <ul style={{ margin: '0 0 14px', paddingLeft: '18px', fontSize: '13px' }}>
            {leftovers.map((l: CapabilityLeftover) => (
              <li key={`${l.type}:${l.sourcePath}`} style={{ padding: '2px 0' }}>
                <Pill text={l.type} tone="accent" /> <strong>{l.name}</strong>{' '}
                <span style={{ color: 'var(--faint)', fontSize: '12px' }}>{l.sourcePath}</span>
              </li>
            ))}
          </ul>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button type="button" className="btn" disabled={busy} onClick={handleTakeoverAll}>
              Move {leftovers.length} into shuba
            </button>
            <button type="button" onClick={() => setConfirmTakeover(false)}>
              Cancel
            </button>
          </div>
        </Card>
      )}

      {error && (
        <div className="panel" style={{ color: 'var(--bad)' }}>
          Error: {error}
        </div>
      )}
      {message && !error && (
        <div className="panel" style={{ color: 'var(--ok)', fontSize: '13px' }}>
          {message}
        </div>
      )}

      {/* ---- grouped manifest ---- */}
      <Card title="Capabilities in shuba">
        <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
          <button type="button" onClick={handleScan} disabled={busy}>
            {busy ? 'Working…' : 'Scan / refresh'}
          </button>
        </div>

        {data === null && !error && <p style={{ color: 'var(--muted)' }}>Loading…</p>}
        {data !== null && manifest.length === 0 && (
          <p style={{ color: 'var(--muted)' }}>
            No capabilities imported yet. Run a scan, then use “Take over all” to move Claude Code’s skills, agents,
            MCP servers and plugins into shuba.
          </p>
        )}

        {TYPE_ORDER.map((type) => {
          const rows = byType(type);
          if (rows.length === 0) return null;
          return (
            <div key={type} style={{ marginBottom: '18px' }}>
              <h3 style={{ fontSize: '12.5px', color: 'var(--muted)', margin: '0 0 6px', fontWeight: 600 }}>
                {TYPE_LABEL[type]} <span style={{ color: 'var(--faint)' }}>({rows.length})</span>
              </h3>
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th style={headStyle}>Name</th>
                      <th style={headStyle}>Description</th>
                      <th style={{ ...headStyle, width: '90px' }}>Enabled</th>
                      <th style={{ ...headStyle, width: '90px' }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((cap) => (
                      <tr key={cap.id} style={{ borderTop: '1px solid var(--border-soft)' }}>
                        <td style={cellStyle}>
                          <div style={{ fontSize: '13.5px', fontWeight: 500 }}>{cap.name}</div>
                          <div style={{ color: 'var(--faint)', fontSize: '11.5px', marginTop: '2px' }}>
                            {cap.sourcePath}
                          </div>
                        </td>
                        <td style={{ ...cellStyle, color: 'var(--muted)', fontSize: '12.5px', maxWidth: '360px' }}>
                          {truncate(cap.description)}
                        </td>
                        <td style={cellStyle}>
                          <label style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer', gap: '6px' }}>
                            <input
                              type="checkbox"
                              checked={cap.enabled}
                              disabled={pendingId === cap.id || busy}
                              onChange={() => handleToggle(cap)}
                            />
                            <Pill text={cap.enabled ? 'on' : 'off'} tone={cap.enabled ? 'ok' : 'muted'} />
                          </label>
                        </td>
                        <td style={cellStyle}>
                          {confirmEjectId === cap.id ? (
                            <span style={{ display: 'inline-flex', gap: '4px', alignItems: 'center' }}>
                              <button
                                type="button"
                                disabled={pendingId === cap.id}
                                onClick={() => handleEject(cap)}
                                title="Restores this capability back to Claude Code"
                                style={{ color: 'var(--bad)' }}
                              >
                                Confirm
                              </button>
                              <button type="button" onClick={() => setConfirmEjectId(null)}>
                                ✕
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              disabled={pendingId === cap.id || busy}
                              onClick={() => setConfirmEjectId(cap.id)}
                              title="Restores this capability back to Claude Code"
                            >
                              Eject
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
      </Card>

      <p style={{ fontSize: '11.5px', color: 'var(--faint)', maxWidth: 720 }}>
        “Eject” restores a capability to Claude Code’s own config; “Take over all” is the reverse, pulling everything
        the last scan found into shuba. The banner turns green once nothing is left behind. Polls every {POLL_MS / 1000}s.
      </p>
    </>
  );
}
