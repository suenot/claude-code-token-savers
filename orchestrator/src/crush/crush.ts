// Tool-output crusher. Claude Code's tool_result blocks are frequently huge —
// a 5000-line build log, an ANSI-coloured test run, a file dump with hundreds
// of identical blank lines — and every character rides along as billed input on
// this turn and every turn after (the block stays in the transcript). crushText
// shrinks an over-threshold tool_result body in three ordered passes: strip ANSI
// escapes, collapse long runs of identical lines, and — if still over budget —
// keep a head/tail window with a marker for the removed middle.
//
// PREFIX-STABILITY INVARIANT (prompt-cache safety). The transform is DETERMINISTIC
// and IDEMPOTENT: the same input text always produces byte-identical output, and
// crushing already-crushed text is a no-op. This matters because a tool_result
// crushed on turn N must serialize identically on turn N+1 — otherwise the
// conversation prefix changes and Anthropic's prompt cache stops hitting, which
// would cost far more than the crusher saves. Every pass is written to recognize
// its own output and leave it untouched:
//   - ANSI strip is naturally idempotent (nothing left to strip).
//   - Run-collapse turns a run into `first line` + one marker line, which is no
//     longer a run, so a second pass finds nothing to collapse.
//   - Head/tail refuses to cut any text that already contains its own
//     `… [crushed N chars] …` marker line.
// The idempotence + determinism guarantees are covered by tests
// (double-crush === single-crush, two calls byte-identical). Do not add any
// nondeterminism (timestamps, hashes of mutable state, Math.random) here.

const DEFAULT_THRESHOLD = 2000;
const DEFAULT_BUDGET = 2000;

// strip-ansi's escape-sequence matcher (CSI/OSC and friends). Global so replace
// removes every occurrence; stripping already-clean text yields the same text.
const ANSI_RE = new RegExp(
  [
    '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))',
  ].join('|'),
  'g',
);

// A head/tail marker line, e.g. `… [crushed 1234 chars] …`. Matched anchored to a
// whole line (multiline) so head/tail can detect its own prior output and skip.
const CRUSH_MARKER_RE = /^… \[crushed \d+ chars\] …$/m;

function collapseMarker(more: number): string {
  return `… [${more} more identical lines]`;
}

function crushMarker(removed: number): string {
  return `… [crushed ${removed} chars] …`;
}

// (a) Remove ANSI escape sequences. Idempotent.
function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

// (b) Collapse runs of 3+ identical consecutive lines to the first line plus a
// `… [N more identical lines]` marker. A collapsed run is `line` + `marker`,
// which is not itself a run, so re-running collapses nothing further.
function collapseRuns(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const runLen = j - i;
    if (runLen >= 3) {
      out.push(lines[i]!, collapseMarker(runLen - 1));
    } else {
      // Short run (1 or 2): keep every line verbatim.
      for (let k = i; k < j; k++) out.push(lines[k]!);
    }
    i = j;
  }
  return out.join('\n');
}

// (c) If still over budget, keep the first 60% and last 25% of the budget
// (measured in chars, whole lines only) with a `… [crushed M chars] …` marker
// between. Refuses to touch text that already carries a crush marker, so its own
// output survives a second pass unchanged.
function headTail(text: string, budget: number): string {
  if (CRUSH_MARKER_RE.test(text)) return text;
  if (text.length <= budget) return text;

  const headBudget = Math.floor(budget * 0.6);
  const tailBudget = Math.floor(budget * 0.25);
  const lines = text.split('\n');

  // Head: whole lines from the start while under headBudget (always keep >= 1).
  let headEnd = 0;
  let headLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const add = (headLen === 0 ? 0 : 1) + lines[i]!.length; // +1 for the joining newline
    if (headLen + add > headBudget && headEnd > 0) break;
    headLen += add;
    headEnd = i + 1;
  }

  // Tail: whole lines from the end (not overlapping the head) while under tailBudget.
  let tailStart = lines.length;
  let tailLen = 0;
  for (let i = lines.length - 1; i >= headEnd; i--) {
    const add = (tailLen === 0 ? 0 : 1) + lines[i]!.length;
    if (tailLen + add > tailBudget && tailStart < lines.length) break;
    tailLen += add;
    tailStart = i;
  }

  // No gap between head and tail (budget covers the whole thing): leave untouched.
  if (tailStart <= headEnd) return text;

  const headStr = lines.slice(0, headEnd).join('\n');
  const tailStr = lines.slice(tailStart).join('\n');
  const removed = text.length - headStr.length - tailStr.length;
  if (removed <= 0) return text;
  return headStr + '\n' + crushMarker(removed) + '\n' + tailStr;
}

// Crush a single tool_result text string. Pure, deterministic, idempotent (see
// the file-level invariant). Callers gate on threshold before invoking, but the
// transform is a no-op on already-crushed / small text regardless.
export function crushText(text: string, budget: number = DEFAULT_BUDGET): string {
  const stripped = stripAnsi(text);
  const collapsed = collapseRuns(stripped);
  if (collapsed.length <= budget) return collapsed;
  return headTail(collapsed, budget);
}

export type CrushOptions = { threshold?: number; budget?: number };
export type CrushStats = { crushedBlocks: number; savedChars: number };

// Crush every over-threshold tool_result in a request body: string-form content
// directly, and text blocks inside array-form content. Nothing else is touched
// (non-tool_result blocks, images inside tool_result, system, tools, thinking).
// Structurally shared no-op: when nothing crosses the threshold and actually
// shrinks, the original body object is returned by reference (cheap, and keeps
// the serialization byte-identical).
export function crushBody(
  body: any,
  opts?: CrushOptions,
): { body: any; stats: CrushStats } {
  const threshold = opts?.threshold ?? DEFAULT_THRESHOLD;
  const budget = opts?.budget ?? DEFAULT_BUDGET;
  const stats: CrushStats = { crushedBlocks: 0, savedChars: 0 };
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
    return { body, stats };
  }

  let anyChanged = false;
  const messages = body.messages.map((message: any) => {
    if (!message || !Array.isArray(message.content)) return message;
    let msgChanged = false;
    const content = message.content.map((block: any) => {
      if (!block || block.type !== 'tool_result') return block;

      // String-form tool_result content.
      if (typeof block.content === 'string') {
        if (block.content.length <= threshold) return block;
        const crushed = crushText(block.content, budget);
        if (crushed === block.content) return block;
        stats.crushedBlocks += 1;
        stats.savedChars += block.content.length - crushed.length;
        msgChanged = true;
        return { ...block, content: crushed };
      }

      // Array-form tool_result content: crush the text blocks inside it.
      if (Array.isArray(block.content)) {
        let innerChanged = false;
        const inner = block.content.map((sub: any) => {
          if (!sub || sub.type !== 'text' || typeof sub.text !== 'string') return sub;
          if (sub.text.length <= threshold) return sub;
          const crushed = crushText(sub.text, budget);
          if (crushed === sub.text) return sub;
          stats.crushedBlocks += 1;
          stats.savedChars += sub.text.length - crushed.length;
          innerChanged = true;
          return { ...sub, text: crushed };
        });
        if (!innerChanged) return block;
        msgChanged = true;
        return { ...block, content: inner };
      }

      return block;
    });
    if (!msgChanged) return message;
    anyChanged = true;
    return { ...message, content };
  });

  if (!anyChanged) return { body, stats };
  return { body: { ...body, messages }, stats };
}
