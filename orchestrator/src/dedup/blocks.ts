import { createHash } from 'node:crypto';

// In-request content deduplication. Claude Code frequently resends
// byte-identical content blocks inside a single /v1/messages body — the same
// file re-read, a repeated tool_result, a duplicated system-reminder — and
// every copy is billed as input tokens. dedupBody keeps the first occurrence
// of each large block verbatim and replaces later identical copies with a
// short reference marker pointing back at it, cutting the billed input.
//
// Pure and deterministic: no I/O, input body is never mutated.

// Blocks whose canonical string is shorter than this are left untouched — the
// reference marker itself costs tokens, so deduping tiny blocks can cost more
// than it saves.
const MIN_BLOCK_CHARS = 200;

function marker(index: number): string {
  return `[shuba-dedup: identical to block #${index} above]`;
}

// The comparable string for a block, or null when the block is not a kind we
// dedup. text and tool_result live in separate namespaces (see `key`) so a
// text block never collapses onto a tool_result with the same string.
function canonical(block: any): { type: string; text: string } | null {
  if (!block || typeof block !== 'object') return null;
  if (block.type === 'text') {
    return typeof block.text === 'string' ? { type: 'text', text: block.text } : null;
  }
  if (block.type === 'tool_result') {
    const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
    return { type: 'tool_result', text };
  }
  return null;
}

function key(type: string, text: string): string {
  return type + ':' + createHash('sha256').update(text).digest('hex');
}

export function dedupBody(body: any): { body: any; stats: { dupBlocks: number; savedChars: number } } {
  const stats = { dupBlocks: 0, savedChars: 0 };
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
    return { body, stats };
  }

  // key → the 1-based reference index assigned to the first occurrence.
  const firstIndex = new Map<string, number>();
  let nextIndex = 1;

  const messages = body.messages.map((message: any) => {
    if (!message || !Array.isArray(message.content)) return message;
    const content = message.content.map((block: any) => {
      const canon = canonical(block);
      if (!canon || canon.text.length < MIN_BLOCK_CHARS) return block;
      const k = key(canon.type, canon.text);
      const seen = firstIndex.get(k);
      if (seen === undefined) {
        firstIndex.set(k, nextIndex++);
        return block;
      }
      const replacement = marker(seen);
      stats.dupBlocks += 1;
      stats.savedChars += canon.text.length - replacement.length;
      return { type: 'text', text: replacement };
    });
    return { ...message, content };
  });

  return { body: { ...body, messages }, stats };
}
