import type { AcquisitionHost } from './contract';
type Fetcher = { fetch(request: Request): Promise<Response> };
/** Guest protocol adapter; the host binds fetch to the submitted URL and assigns artifact origin. */
export function httpAcquisitionHost(binding: Fetcher): AcquisitionHost {
  async function call(path: string, init?: RequestInit) {
    const response = await binding.fetch(new Request(`https://capability.invalid${path}`, init));
    if (!response.ok) throw new Error(await response.text());
    return response;
  }
  return {
    fetch: () => call('/fetch'),
    write: async (meta, body) => (await call('/write', {
      method: 'PUT', headers: { 'content-type': meta.mediaType }, body, duplex: 'half',
    } as RequestInit)).json(),
  };
}
