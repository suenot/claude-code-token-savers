import { createHash } from 'node:crypto';

export function summaryKey(older: any[]): string {
  return createHash('sha256').update(JSON.stringify(older)).digest('hex');
}

export function buildRewrittenBody(body: any, tail: any[], summaryText: string): any {
  const messages = [
    { role: 'user', content: 'Summary of the earlier conversation so far:\n\n' + summaryText },
    { role: 'assistant', content: 'Understood. Continuing from that summary.' },
    ...tail,
  ];
  return { ...body, messages };
}
