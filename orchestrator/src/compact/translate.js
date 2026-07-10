function flatten(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => {
    if (!b) return '';
    if (b.type === 'text') return b.text || '';
    if (b.type === 'tool_use') return `\n[tool_call ${b.name} ${JSON.stringify(b.input ?? {})}]`;
    if (b.type === 'tool_result') {
      const c = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
      return `\n[tool_result ${c}]`;
    }
    if (b.type === 'image') return '\n[image omitted]';
    return '';
  }).join('');
}

export function anthropicToOpenAI(body, model) {
  const messages = [];
  if (body.system) messages.push({ role: 'system', content: flatten(body.system) });
  for (const m of body.messages || []) {
    messages.push({ role: m.role, content: flatten(m.content) });
  }
  return {
    model,
    messages,
    max_tokens: Math.min(body.max_tokens ?? 8192, 32000),
    temperature: 0,
    stream: !!body.stream,
  };
}

export function mapStopReason(finishReason) {
  return finishReason === 'length' ? 'max_tokens' : 'end_turn';
}

export function openAIMessageToAnthropic(text, { model, inputTokens = 0, outputTokens = 0, stopReason = 'end_turn' }) {
  return {
    id: 'msg_compact',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

function frame(type, obj) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`;
}

export function anthropicSSEChunks(text, { model, inputTokens = 0, outputTokens = 0, stopReason = 'end_turn' }) {
  return [
    frame('message_start', { message: { id: 'msg_compact', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } } }),
    frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
    frame('content_block_stop', { index: 0 }),
    frame('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } }),
    frame('message_stop', {}),
  ];
}
