import type { ProcessingHost } from './contract';
type Fetcher = { fetch(request: Request): Promise<Response> };
/** Thin protocol adapter. Authority is held and checked by the host, not this guest wrapper. */
export function httpHost(binding: Fetcher): ProcessingHost {
  async function call(path: string, init?: RequestInit) {
    const response = await binding.fetch(new Request(`https://capability.invalid${path}`, init));
    if (!response.ok) throw new Error(await response.text()); return response;
  }
  return {
    read: async (artifact, range) => (await call(`/read/${encodeURIComponent(artifact)}${range ? `?start=${range.start}&end=${range.end}` : ''}`)).body!,
    write: async (meta, body) => (await call('/write', { method: 'PUT', headers: { 'x-role': meta.role, 'content-type': meta.mediaType }, body, duplex: 'half' } as RequestInit)).json(),
    transcribe: async original => (await call('/transcribe', { method: 'POST', body: JSON.stringify({ original }) })).json(),
  };
}
