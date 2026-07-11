function startsWithToolResult(m: any): boolean {
  return Array.isArray(m.content) && m.content[0] && m.content[0].type === 'tool_result';
}

export function planCut(messages: any[], tailTurns: number): { older: any[]; tail: any[] } | null {
  if (!(tailTurns > 0)) return null;
  const msgs = Array.isArray(messages) ? messages : [];
  let cut = Math.max(0, msgs.length - tailTurns);
  while (cut > 0 && (msgs[cut].role !== 'user' || startsWithToolResult(msgs[cut]))) {
    cut--;
  }
  if (cut <= 0) return null;
  return { older: msgs.slice(0, cut), tail: msgs.slice(cut) };
}
