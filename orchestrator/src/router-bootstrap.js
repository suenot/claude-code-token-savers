export async function mintToken(routerRootUrl, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${routerRootUrl}/api/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`router token mint failed: ${body}`);
  }
  const data = await res.json();
  return data.token;
}
