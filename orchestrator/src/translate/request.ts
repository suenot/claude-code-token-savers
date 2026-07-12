// Anthropic /v1/messages request → OpenAI /chat/completions request.
//
// Pure, zero-I/O port of Part A of docs/tool-translation-spec.md (mined from
// litellm's experimental_pass_through adapter). The router's forward() path
// uses this to make Claude Code's Anthropic-shaped requests intelligible to an
// OpenAI-compatible endpoint (a8e, OpenRouter, …) WITH tool calling intact.
//
// The returned `meta` carries state the response/stream translators need to
// reverse the request faithfully — chiefly the >64-char tool-name truncation
// map (D6): OpenAI caps tool names at 64 chars, Anthropic does not, so names are
// truncated on the way out and restored on the way back.

export type TranslateMeta = {
  // Truncated tool name -> original name, for restoring names on the response.
  toolNameMap: Record<string, string>;
  // Target model name (the OpenAI body model). Used as the response `model`
  // fallback and to decide whether thinking stays native or maps to
  // reasoning_effort.
  model: string;
  // Whether the caller asked for a streamed response.
  stream: boolean;
};

export type TranslateRequestResult = { body: any; meta: TranslateMeta };

// OpenAI caps function/tool names at 64 chars; Anthropic does not. Truncate to
// {55-char prefix}_{8-char hash} so distinct long names don't collide (D6).
const OPENAI_MAX_TOOL_NAME_LENGTH = 64;
const TOOL_NAME_HASH_LENGTH = 8;
const TOOL_NAME_PREFIX_LENGTH = OPENAI_MAX_TOOL_NAME_LENGTH - TOOL_NAME_HASH_LENGTH - 1; // 55

// Reasoning-effort buckets for thinking.budget_tokens (litellm constants). Only
// used when the target is a non-Claude model, which the router path always is.
const LOW_BUDGET = 1024;
const MEDIUM_BUDGET = 2048;
const HIGH_BUDGET = 4096;

function sha256hex(input: string): string {
  // Bun/Node expose global crypto with subtle; but a sync digest is simplest via
  // node:crypto. Kept local so this module stays a pure function with no other
  // I/O surface.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require('node:crypto');
  return createHash('sha256').update(input).digest('hex');
}

export function truncateToolName(name: string): string {
  if (name.length <= OPENAI_MAX_TOOL_NAME_LENGTH) return name;
  const hash = sha256hex(name).slice(0, TOOL_NAME_HASH_LENGTH);
  return `${name.slice(0, TOOL_NAME_PREFIX_LENGTH)}_${hash}`;
}

function reasoningEffortFromBudget(budget: number): string {
  if (budget >= HIGH_BUDGET) return 'high';
  if (budget >= MEDIUM_BUDGET) return 'medium';
  if (budget >= LOW_BUDGET) return 'low';
  return 'minimal';
}

// Non-Claude targets can't take Anthropic's `thinking` param; they take
// `reasoning_effort` instead. The router only ever routes to non-Claude
// endpoints, but we still gate on the model so an a8e-hosted Claude keeps
// native thinking.
function isClaudeModel(model: string): boolean {
  const m = (model || '').toLowerCase();
  return m.includes('anthropic') || m.includes('claude');
}

// Anthropic image/document source -> OpenAI image_url string (A7).
function imageSourceToUrl(source: any): string | undefined {
  if (!source || typeof source !== 'object') return undefined;
  if (source.type === 'base64' && source.data) {
    const mt = source.media_type || 'image/jpeg';
    return `data:${mt};base64,${source.data}`;
  }
  if (source.type === 'url' && source.url) return String(source.url);
  return undefined;
}

// A single tool_result block -> one OpenAI role:"tool" message. content shapes
// per A5/D11: absent->""; string->string; single text block->flatten; single
// image->data/URL string; multiple blocks->ONE tool msg with array content.
// is_error has no OpenAI flag, so fold a marker into the text (reverse path
// re-derives it).
function toolResultToMessage(block: any): any {
  const toolCallId = block.tool_use_id ?? '';
  const isError = block.is_error === true;
  const raw = block.content;

  const foldError = (text: string): string => (isError ? `[tool_error] ${text}` : text);

  if (raw === undefined || raw === null) {
    return { role: 'tool', tool_call_id: toolCallId, content: isError ? '[tool_error] ' : '' };
  }
  if (typeof raw === 'string') {
    return { role: 'tool', tool_call_id: toolCallId, content: foldError(raw) };
  }
  if (Array.isArray(raw)) {
    // Single item keeps the flat string/url form; multiple items become an
    // array of parts under ONE id (never split one result across ids).
    if (raw.length === 1) {
      const c = raw[0];
      if (typeof c === 'string') return { role: 'tool', tool_call_id: toolCallId, content: foldError(c) };
      if (c && c.type === 'text') return { role: 'tool', tool_call_id: toolCallId, content: foldError(c.text ?? '') };
      if (c && c.type === 'image') {
        const url = imageSourceToUrl(c.source) ?? '';
        return { role: 'tool', tool_call_id: toolCallId, content: url };
      }
      return { role: 'tool', tool_call_id: toolCallId, content: '' };
    }
    const parts: any[] = [];
    for (const c of raw) {
      if (typeof c === 'string') parts.push({ type: 'text', text: c });
      else if (c && c.type === 'text') parts.push({ type: 'text', text: c.text ?? '' });
      else if (c && c.type === 'image') {
        const url = imageSourceToUrl(c.source);
        if (url) parts.push({ type: 'image_url', image_url: { url } });
      }
    }
    return { role: 'tool', tool_call_id: toolCallId, content: parts };
  }
  return { role: 'tool', tool_call_id: toolCallId, content: '' };
}

// Translate one Anthropic message turn into 0+ OpenAI messages.
function translateMessage(m: any): any[] {
  const out: any[] = [];
  if (!m || typeof m !== 'object') return out;

  if (m.role === 'user') {
    const content = m.content;
    if (typeof content === 'string') {
      out.push({ role: 'user', content });
      return out;
    }
    if (!Array.isArray(content)) return out;

    const toolMsgs: any[] = [];
    const userParts: any[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text') userParts.push({ type: 'text', text: block.text ?? '' });
      else if (block.type === 'image' || block.type === 'document') {
        const url = imageSourceToUrl(block.source);
        if (url) userParts.push({ type: 'image_url', image_url: { url } });
      } else if (block.type === 'tool_result') {
        // Each tool_result is its own role:tool message (one per id, D11).
        toolMsgs.push(toolResultToMessage(block));
      }
    }
    // Tool results come BEFORE the residual user text/image (A5).
    out.push(...toolMsgs);
    if (userParts.length === 1 && userParts[0].type === 'text') {
      out.push({ role: 'user', content: userParts[0].text });
    } else if (userParts.length > 0) {
      out.push({ role: 'user', content: userParts });
    }
    return out;
  }

  if (m.role === 'assistant') {
    const content = m.content;
    if (typeof content === 'string') {
      out.push({ role: 'assistant', content });
      return out;
    }
    if (!Array.isArray(content)) return out;

    const texts: string[] = [];
    const toolCalls: any[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text') texts.push(block.text ?? '');
      else if (block.type === 'tool_use') {
        // arguments MUST be a JSON string (D3); reconstruct assistant.tool_calls
        // from tool_use blocks or the paired tool messages orphan (D2).
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: truncateToolName(block.name ?? ''), arguments: JSON.stringify(block.input ?? {}) },
        });
      }
      // thinking / redacted_thinking blocks are dropped for non-Claude targets (A7/D13).
    }
    const msg: any = { role: 'assistant' };
    // content may be null only when tool_calls are present (A4).
    msg.content = texts.length > 0 ? texts.join('') : toolCalls.length > 0 ? null : '';
    if (toolCalls.length > 0) msg.tool_calls = toolCalls;
    out.push(msg);
    return out;
  }

  return out;
}

// tool_choice (A3). Returns { tool_choice?, parallel_tool_calls? }.
function translateToolChoice(tc: any): { tool_choice?: any; parallel_tool_calls?: boolean } {
  if (!tc || typeof tc !== 'object') return {};
  const res: { tool_choice?: any; parallel_tool_calls?: boolean } = {};
  // disable_parallel_tool_use lives inside the Anthropic tool_choice; it maps to
  // the OpenAI top-level parallel_tool_calls flag.
  if (tc.disable_parallel_tool_use === true) res.parallel_tool_calls = false;
  switch (tc.type) {
    case 'any':
      res.tool_choice = 'required';
      break;
    case 'auto':
      res.tool_choice = 'auto';
      break;
    case 'none':
      res.tool_choice = 'none';
      break;
    case 'tool':
      res.tool_choice = { type: 'function', function: { name: truncateToolName(tc.name ?? '') } };
      break;
  }
  return res;
}

// tools (A2) + name-truncation map (D6). Web-search / Anthropic-hosted tools are
// dropped here (they have no OpenAI function equivalent); the classifier routes
// web-search requests elsewhere, so the router path won't carry them.
function translateTools(tools: any[]): { tools?: any[]; toolNameMap: Record<string, string> } {
  const toolNameMap: Record<string, string> = {};
  const out: any[] = [];
  tools.forEach((tool, idx) => {
    if (!tool || typeof tool !== 'object') return;
    const type = typeof tool.type === 'string' ? tool.type : '';
    if (type.startsWith('web_search') || tool.name === 'web_search') return; // hosted, skip

    const rawName = tool.name;
    const original = typeof rawName === 'string' && rawName.trim() ? rawName : `unnamed_tool_${idx}`;
    const truncated = truncateToolName(original);
    if (truncated !== original) toolNameMap[truncated] = original;

    const fn: any = { name: truncated };
    // DO NOT merge the Anthropic tool `type` into parameters — it would clobber
    // parameters.type:"object" and the provider rejects it (D5). input_schema
    // absent -> omit parameters; description absent -> omit key.
    if (tool.input_schema !== undefined) fn.parameters = tool.input_schema;
    if (tool.description !== undefined) fn.description = tool.description;
    if (tool.strict !== undefined) fn.strict = tool.strict;
    out.push({ type: 'function', function: fn });
  });
  // Empty tools array -> undefined, not [] (D9).
  return { tools: out.length > 0 ? out : undefined, toolNameMap };
}

// output_format {json_schema,schema} -> response_format (A2). Recursively force
// additionalProperties:false + required=all-keys per object level (OpenAI strict).
function addStrictProps(schema: any): void {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type === 'object' && schema.properties && typeof schema.properties === 'object') {
    schema.additionalProperties = false;
    schema.required = Object.keys(schema.properties);
    for (const p of Object.values(schema.properties)) addStrictProps(p);
  }
  if (schema.items) addStrictProps(schema.items);
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(schema[key])) for (const s of schema[key]) addStrictProps(s);
  }
  for (const key of ['$defs', 'definitions']) {
    if (schema[key] && typeof schema[key] === 'object') for (const s of Object.values(schema[key])) addStrictProps(s);
  }
}

function translateOutputFormat(output: any): any | undefined {
  if (!output || typeof output !== 'object' || output.type !== 'json_schema' || !output.schema) return undefined;
  const schema = JSON.parse(JSON.stringify(output.schema));
  addStrictProps(schema);
  return { type: 'json_schema', json_schema: { name: 'structured_output', schema, strict: true } };
}

// system (A6): string -> one system msg; array of {type:text,text} -> system msg
// with array content; inserted at index 0.
function systemMessage(system: any): any | undefined {
  if (!system) return undefined;
  if (typeof system === 'string') return { role: 'system', content: system };
  if (Array.isArray(system)) {
    const parts = system
      .filter((b: any) => b && b.type === 'text')
      .map((b: any) => ({ type: 'text', text: b.text ?? '' }));
    if (parts.length > 0) return { role: 'system', content: parts };
  }
  return undefined;
}

// Keys we translate or handle explicitly; everything else is copied through
// (A1). cache_control never appears at top level, so nothing to strip there.
const HANDLED_KEYS = new Set([
  'messages',
  'system',
  'tools',
  'tool_choice',
  'thinking',
  'metadata',
  'output_format',
  'output_config',
  'stop_sequences',
  'model',
  'anthropic_version',
  'anthropic_beta',
]);

export function anthropicToOpenAIRequest(body: any): TranslateRequestResult {
  if (!body || typeof body !== 'object') {
    return { body: {}, meta: { toolNameMap: {}, model: '', stream: false } };
  }
  const model = typeof body.model === 'string' ? body.model : '';
  const messages: any[] = [];
  const sys = systemMessage(body.system);
  if (sys) messages.push(sys);
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    messages.push(...translateMessage(m));
  }

  const out: any = { model, messages };

  // Copy-through: every key not explicitly translated goes straight through.
  for (const [k, v] of Object.entries(body)) {
    if (!HANDLED_KEYS.has(k)) out[k] = v;
  }

  // metadata.user_id -> user; stop_sequences -> stop.
  if (body.metadata && typeof body.metadata === 'object' && body.metadata.user_id) {
    out.user = body.metadata.user_id;
  }
  if (body.stop_sequences !== undefined) out.stop = body.stop_sequences;

  // tools + tool_choice.
  let toolNameMap: Record<string, string> = {};
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const t = translateTools(body.tools);
    if (t.tools) out.tools = t.tools;
    toolNameMap = t.toolNameMap;
  }
  if (body.tool_choice) {
    const tc = translateToolChoice(body.tool_choice);
    if (tc.tool_choice !== undefined) out.tool_choice = tc.tool_choice;
    if (tc.parallel_tool_calls !== undefined) out.parallel_tool_calls = tc.parallel_tool_calls;
  }

  // thinking -> reasoning_effort for non-Claude targets; disabled -> drop.
  if (body.thinking && typeof body.thinking === 'object') {
    if (isClaudeModel(model)) {
      out.thinking = body.thinking;
    } else if (body.thinking.type === 'enabled') {
      out.reasoning_effort = reasoningEffortFromBudget(body.thinking.budget_tokens ?? 0);
    }
    // type === 'disabled' -> drop entirely.
  }

  // output_format / output_config.format -> response_format.
  const outputFormat =
    body.output_format ?? (body.output_config && typeof body.output_config === 'object' ? body.output_config.format : undefined);
  const rf = translateOutputFormat(outputFormat);
  if (rf) out.response_format = rf;

  return { body: out, meta: { toolNameMap, model, stream: body.stream === true } };
}
