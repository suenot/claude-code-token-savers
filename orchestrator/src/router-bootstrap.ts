export interface MintTokenResponse {
  ok: boolean;
  text(): Promise<string>;
  json(): Promise<{ token: string }>;
}

export type MintTokenFetch = (url: string, init: RequestInit) => Promise<MintTokenResponse>;

export interface MintTokenOpts {
  fetchImpl?: MintTokenFetch;
}

export async function mintToken(routerRootUrl: string, { fetchImpl = fetch as unknown as MintTokenFetch }: MintTokenOpts = {}): Promise<string> {
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
