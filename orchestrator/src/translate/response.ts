// OpenAI /chat/completions response (non-stream) → Anthropic /v1/messages
// response. Pure port of Part B of docs/tool-translation-spec.md. Also exports
// the small shared helpers (id normalization, usage, finish-reason, tool-arg
// parsing) that the streaming translator reuses.

import type { TranslateMeta } from './request.ts';

// --- shared helpers ----------------------------------------------------------

// Normalize a tool_use / tool_result id to Anthropic's ^[a-zA-Z0-9_-]+$ (B2):
// strip a Gemini thought-signature suffix, replace invalid chars with _,
// empty -> "tool_use_id". We PASS THROUGH (don't mint new) so the id chain
// survives every hop and request/response correlation is preserved (D1).
const THOUGHT_SIGNATURE_SEPARATOR = '__thought__';

export function normalizeToolUseId(rawId: string): string {
  const base = rawId.includes(THOUGHT_SIGNATURE_SEPARATOR) ? rawId.split(THOUGHT_SIGNATURE_SEPARATOR, 1)[0] : rawId;
  const sanitized = base.replace(/[^a-zA-Z0-9_-]/g, '_');
  return sanitized || 'tool_use_id';
}

// finish_reason -> stop_reason (B3).
export function mapFinishReason(finish: string | null | undefined): string {
  switch (finish) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'stop':
    case 'content_filter':
    default:
      return 'end_turn';
  }
}

// usage -> Anthropic usage delta (B4). cached_tokens -> cache_read;
// input = max(prompt - cache_read - cache_creation, 0). cache_* fields only
// when > 0. `zeroed` produces the message_start seed (C2).
export function translateUsage(usage: any): any {
  const u = usage && typeof usage === 'object' ? usage : {};
  const details = u.prompt_tokens_details && typeof u.prompt_tokens_details === 'object' ? u.prompt_tokens_details : {};
  const posInt = (v: any): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

  const cacheRead = posInt(u.cache_read_input_tokens) || posInt(details.cached_tokens);
  const cacheCreation =
    posInt(u.cache_creation_input_tokens) || posInt(details.cache_creation_tokens) || posInt(details.cache_write_tokens);
  const prompt = posInt(u.prompt_tokens);
  const input = Math.max(prompt - cacheRead - cacheCreation, 0);

  const out: any = { input_tokens: input, output_tokens: posInt(u.completion_tokens) };
  if (cacheCreation > 0) out.cache_creation_input_tokens = cacheCreation;
  if (cacheRead > 0) out.cache_read_input_tokens = cacheRead;
  return out;
}

export function zeroedUsage(): any {
  return { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

// Restore an original tool name from a truncated one via the request-time map (D6).
export function restoreToolName(name: string, meta: TranslateMeta | undefined): string {
  if (!meta) return name;
  return meta.toolNameMap[name] ?? name;
}

// Lightweight repair of truncated JSON (unclosed brackets/braces), mirroring
// litellm's _attempt_json_repair. Returns the parsed value or undefined.
function attemptJsonRepair(s: string): any {
  const stripped = s.replace(/\s+$/, '');
  if (!stripped) return undefined;
  const stack: string[] = [];
  let inString = false;
  let escapeNext = false;
  for (const ch of stripped) {
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.length && stack[stack.length - 1] === ch) stack.pop();
    }
  }
  if (stack.length === 0) return undefined;
  let candidate = stripped.replace(/,+$/, '');
  candidate += stack.reverse().join('');
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

// Parse a tool_call.arguments JSON string into an Anthropic input object (B1).
// empty -> {}; parse error -> bracket-repair; non-object result -> wrap
// {rawInvalidInput} (D7).
export function parseToolArguments(args: string | null | undefined): any {
  if (!args || !args.trim()) return {};
  let parsed: any;
  try {
    parsed = JSON.parse(args);
  } catch {
    const repaired = attemptJsonRepair(args);
    parsed = repaired !== undefined ? repaired : { rawInvalidInput: args };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { rawInvalidInput: parsed };
  }
  return parsed;
}

// --- non-stream response translation (Part B) --------------------------------

export function openaiToAnthropicResponse(json: any, meta?: TranslateMeta): any {
  const choice = json && Array.isArray(json.choices) ? json.choices[0] : undefined;
  const message = choice && choice.message ? choice.message : {};
  const content: any[] = [];

  // Order: thinking -> text -> tool_use (B1).
  if (message.reasoning_content) {
    content.push({ type: 'thinking', thinking: String(message.reasoning_content), signature: null });
  }
  if (message.content !== null && message.content !== undefined && message.content !== '') {
    content.push({ type: 'text', text: String(message.content) });
  }
  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      const fn = tc && tc.function ? tc.function : {};
      content.push({
        type: 'tool_use',
        id: normalizeToolUseId(tc && typeof tc.id === 'string' ? tc.id : ''),
        name: restoreToolName(fn.name ?? '', meta),
        input: parseToolArguments(fn.arguments),
      });
    }
  }

  const stopReason = mapFinishReason(choice ? choice.finish_reason : undefined);
  return {
    id: json && json.id ? json.id : 'msg_' + Math.random().toString(36).slice(2),
    type: 'message',
    role: 'assistant',
    model: (json && json.model) || (meta && meta.model) || 'unknown-model',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: translateUsage(json ? json.usage : undefined),
  };
}
