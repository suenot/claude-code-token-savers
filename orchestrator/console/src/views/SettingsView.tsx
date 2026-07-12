import { useEffect, useState } from 'react';
import { getSettings, saveSettings, type Settings } from '../api.ts';
import { Card } from '../components/Card.tsx';
import { TogglesView } from './TogglesView.tsx';

const sectionHeading: React.CSSProperties = {
  margin: '20px 0 12px',
  fontSize: '13px',
  color: 'var(--muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
};

// ---- generic path get/set on a nested settings object ----
function getPath(obj: any, path: string[]): unknown {
  return path.reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}
function setPath(obj: any, path: string[], value: unknown): any {
  const [head, ...rest] = path;
  const next = { ...(obj ?? {}) };
  if (rest.length === 0) {
    if (value === '' || value === undefined || (typeof value === 'number' && Number.isNaN(value))) {
      delete next[head];
    } else {
      next[head] = value;
    }
  } else {
    next[head] = setPath(next[head] ?? {}, rest, value);
    if (Object.keys(next[head]).length === 0) delete next[head];
  }
  return next;
}

type FieldSpec =
  | { path: string; label: string; type: 'text' | 'number'; placeholder?: string; hint?: string }
  | { path: string; label: string; type: 'bool' }
  | { path: string; label: string; type: 'select'; options: string[] };

type SectionSpec = { title: string; note?: string; fields: FieldSpec[] };

// One target input per task category, format harness?/provider/[subprovider/]model.
const routeFields = (cat: string, extra: FieldSpec[] = []): FieldSpec[] => [
  { path: `modelRouter.routes.${cat}.model`, label: 'target', type: 'text', placeholder: 'a8e/a8e-1.0-pro', hint: 'provider/[subprovider/]model' },
  ...extra,
];

const SECTIONS: SectionSpec[] = [
  {
    title: 'context-watchdog — proactive auto-compact',
    note: 'Summarizes the tail before Claude Code autocompacts. thresholdTokens is the trigger (e.g. 300000 for 300k). Enable the stage below in Stage toggles too.',
    fields: [
      { path: 'contextWatchdog.thresholdTokens', label: 'thresholdTokens', type: 'number', placeholder: '300000', hint: 'auto-compact at this many tokens' },
      { path: 'contextWatchdog.tailTurns', label: 'tailTurns', type: 'number', placeholder: '6' },
      { path: 'contextWatchdog.model', label: 'target', type: 'text', placeholder: 'a8e/a8e-1.0-pro', hint: 'provider/[subprovider/]model' },
    ],
  },
  {
    title: 'compact-router — /compact to a cheap model',
    fields: [
      { path: 'compactRouter.model', label: 'target', type: 'text', placeholder: 'a8e/a8e-1.0-pro', hint: 'provider/[subprovider/]model' },
    ],
  },
  {
    title: 'image-shrink — downscale request images',
    fields: [
      { path: 'imageShrink.scale', label: 'scale', type: 'text', placeholder: '1/2', hint: '1x · 1/2 · 1/2.5 · 1/3 · 1/4 or a number' },
      { path: 'imageShrink.minBytes', label: 'minBytes', type: 'number', placeholder: '4096' },
    ],
  },
  {
    title: 'rate-limiter',
    fields: [
      { path: 'rateLimiter.rps', label: 'rps', type: 'number', placeholder: '2' },
      { path: 'rateLimiter.burst', label: 'burst', type: 'number', placeholder: '5' },
      { path: 'rateLimiter.cooldownMs', label: 'cooldownMs', type: 'number', placeholder: '5000' },
    ],
  },
  {
    title: 'delegate — task offload defaults',
    note: 'One target string: harness/provider/[subprovider/]model — e.g. opencode/a8e/a8e-1.0-pro. Provider resolves its endpoint automatically (a8e, openrouter, anthropic, deepseek, openai).',
    fields: [
      { path: 'delegate.default', label: 'default target', type: 'text', placeholder: 'opencode/a8e/a8e-1.0-pro', hint: 'harness/provider/[subprovider/]model' },
      { path: 'delegate.classifierModel', label: 'classifier target', type: 'text', placeholder: 'a8e/a8e-1.0-pro', hint: 'provider/[subprovider/]model' },
      { path: 'delegate.concurrency', label: 'concurrency', type: 'number' },
      { path: 'delegate.isolation', label: 'isolation', type: 'select', options: ['', 'none', 'worktree'] },
    ],
  },
  {
    title: 'graph',
    fields: [
      { path: 'graph.model', label: 'model', type: 'text' },
      { path: 'graph.autobuild', label: 'autobuild', type: 'bool' },
      { path: 'graph.noMedia', label: 'noMedia', type: 'bool' },
      { path: 'graph.enabled', label: 'enabled', type: 'bool' },
    ],
  },
];

const ROUTE_SECTIONS: SectionSpec[] = [
  { title: 'route: default', fields: routeFields('default') },
  { title: 'route: background (small/cheap bg calls)', fields: routeFields('background') },
  { title: 'route: think (plan/reasoning)', fields: routeFields('think') },
  {
    title: 'route: longContext',
    fields: routeFields('longContext', [
      { path: 'modelRouter.routes.longContext.threshold', label: 'threshold', type: 'number', placeholder: '60000' },
    ]),
  },
  { title: 'route: webSearch', fields: routeFields('webSearch') },
  {
    title: 'route: image / vision',
    note: 'target defaults to a8e/a8e-1.0-flash (MiniMax via a8e). mode: auto = if the text says "ocr" extract text locally (free), else send to the vision model (target above); ocr = always local tesseract; vision-route = always the vision model; off = passthrough.',
    fields: routeFields('image', [
      { path: 'modelRouter.routes.image.mode', label: 'mode', type: 'select', options: ['auto', 'ocr', 'vision-route', 'off'] },
      { path: 'modelRouter.routes.image.dropImage', label: 'dropImage (after OCR)', type: 'bool' },
      { path: 'modelRouter.routes.image.ocrCommand', label: 'ocrCommand', type: 'text', placeholder: 'tesseract' },
      { path: 'modelRouter.routes.image.ocrLang', label: 'ocrLang', type: 'text', placeholder: 'eng' },
    ]),
  },
];

function Field({ spec, settings, onChange }: { spec: FieldSpec; settings: Settings; onChange: (path: string[], v: unknown) => void }) {
  const path = spec.path.split('.');
  const value = getPath(settings, path);
  if (spec.type === 'bool') {
    return (
      <div className="field">
        <label>{spec.label}</label>
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(path, e.target.checked ? true : '')} />
      </div>
    );
  }
  if (spec.type === 'select') {
    return (
      <div className="field">
        <label>{spec.label}</label>
        <select value={(value as string) ?? ''} onChange={(e) => onChange(path, e.target.value)}>
          {spec.options.map((o) => (
            <option key={o} value={o}>
              {o || '—'}
            </option>
          ))}
        </select>
      </div>
    );
  }
  return (
    <div className="field">
      <label>{spec.label}</label>
      <input
        type={spec.type}
        value={value === undefined || value === null ? '' : String(value)}
        placeholder={spec.placeholder}
        onChange={(e) =>
          onChange(path, spec.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)
        }
      />
      {'hint' in spec && spec.hint && <span className="hint">{spec.hint}</span>}
    </div>
  );
}

export function SettingsView() {
  const [settings, setSettings] = useState<Settings>({});
  const [chain, setChain] = useState<Record<string, unknown> | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getSettings()
      .then((r) => {
        setSettings(r.settings ?? {});
        setChain(r.chain ?? null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const onChange = (path: string[], v: unknown) => {
    setSettings((s) => setPath(s, path, v));
    setStatus(null);
  };

  const save = () => {
    setSaving(true);
    setError(null);
    saveSettings(settings)
      .then((r) => {
        setSettings(r.settings ?? {});
        setChain(r.chain ?? null);
        setStatus('Saved to chain.json — restart shuba (`shuba run`) for it to take effect.');
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSaving(false));
  };

  const renderSection = (sec: SectionSpec) => (
    <Card key={sec.title} title={sec.title}>
      {sec.note && <p style={{ color: 'var(--muted)', fontSize: '12.5px', marginTop: 0 }}>{sec.note}</p>}
      {sec.fields.map((f) => (
        <Field key={f.path} spec={f} settings={settings} onChange={onChange} />
      ))}
    </Card>
  );

  return (
    <>
      <div className="banner">
        Settings are written to <code>~/.shuba/chain.json</code>. They persist but take effect on the next{' '}
        <code>shuba run</code> (stages read their config at launch). Blank a field to unset it.
      </div>
      {error && <div className="panel" style={{ color: 'var(--bad)' }}>Error: {error}</div>}
      {status && <div className="banner" style={{ borderColor: 'var(--ok)' }}>{status}</div>}

      <div style={{ margin: '0 0 18px' }}>
        <button type="button" className="btn" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </div>

      <h3 style={sectionHeading}>Stage toggles (live — no restart)</h3>
      <TogglesView />

      <h3 style={sectionHeading}>Stages</h3>
      {SECTIONS.map(renderSection)}

      <h3 style={sectionHeading}>Task-type model routes (model-router)</h3>
      {ROUTE_SECTIONS.map(renderSection)}

      <div style={{ margin: '18px 0 24px' }}>
        <button type="button" className="btn" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </div>

      <h3 style={sectionHeading}>Raw chain.json (read-only)</h3>
      <Card title="~/.shuba/chain.json">
        <p style={{ color: 'var(--muted)', fontSize: '12.5px', marginTop: 0 }}>
          The exact persisted file the form reads and writes. Updates on Save.
        </p>
        <pre
          style={{
            whiteSpace: 'pre-wrap',
            background: 'var(--panel-2)',
            border: '1px solid var(--border)',
            padding: '10px',
            borderRadius: '6px',
            fontSize: '12.5px',
            margin: 0,
          }}
        >
          {chain ? JSON.stringify(chain, null, 2) : 'loading…'}
        </pre>
      </Card>
    </>
  );
}
