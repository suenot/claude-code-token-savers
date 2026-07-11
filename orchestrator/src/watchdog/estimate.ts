function flatten(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => {
    if (!b) return '';
    if (b.type === 'text') return b.text || '';
    if (b.type === 'tool_use') return `${b.name || ''}${JSON.stringify(b.input ?? {})}`;
    if (b.type === 'tool_result') return typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
    return '';
  }).join('');
}

export function estimateTokens(body: { system?: any; messages?: any[] }): number {
  let chars = 0;
  if (body && body.system) chars += flatten(body.system).length;
  for (const m of (body && body.messages) || []) chars += flatten(m.content).length;
  return Math.ceil(chars / 4);
}
