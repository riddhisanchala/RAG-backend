// Tiny fetch wrapper with timeouts and readable provider errors (never echoes API keys).
export class ProviderError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
    this.isProviderError = true;
  }
}

export async function httpJson(url, { method = 'POST', headers = {}, body, timeoutMs = 90_000 } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const reason = e.name === 'TimeoutError' ? 'request timed out' : e.cause?.code || e.message;
    throw new ProviderError(`Could not reach the provider (${reason}).`);
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || data?.message || data?.detail || data?.raw || res.statusText;
    const m = typeof msg === 'string' ? msg : JSON.stringify(msg);
    throw new ProviderError(`Provider returned ${res.status}: ${m.slice(0, 400)}`, res.status === 401 || res.status === 403 ? 401 : 502);
  }
  return data;
}

export function l2normalize(v) {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map((x) => x / n);
}
