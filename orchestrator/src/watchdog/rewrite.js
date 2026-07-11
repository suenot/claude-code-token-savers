import { createHash } from 'node:crypto';

export function summaryKey(older) {
  return createHash('sha256').update(JSON.stringify(older)).digest('hex');
}

export function buildRewrittenBody(body, tail, summaryText) {
  const messages = [
    { role: 'user', content: 'Summary of the earlier conversation so far:\n\n' + summaryText },
    { role: 'assistant', content: 'Understood. Continuing from that summary.' },
    ...tail,
  ];
  return { ...body, messages };
}
