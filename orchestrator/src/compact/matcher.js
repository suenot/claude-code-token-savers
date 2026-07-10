const FINGERPRINT = 'create a detailed summary of the conversation so far';

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b && b.text) || '').join('');
  return '';
}

export function isCompactRequest(body) {
  const messages = body && Array.isArray(body.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'user') {
      return textOf(messages[i].content).toLowerCase().includes(FINGERPRINT);
    }
  }
  return false;
}
