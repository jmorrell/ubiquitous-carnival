import type { UrlAcquirer, UrlAcquirerRegistration } from '../src/contract';

/** An example registration; the host must separately supply a trusted fetch adapter. */
export const downloadRegistration: UrlAcquirerRegistration = {
  id: 'url-download', version: '0.1.0', urlOrigins: ['https://example.test'], grants: ['fetch'],
};
/** Downloads one response body. It does not crawl links or pretend to capture a full webpage. */
export const downloadAcquirer: UrlAcquirer = {
  async acquire(_url, host) {
    const response = await host.fetch();
    if (!response.body) throw new Error('URL response has no body');
    const artifact = await host.write({ mediaType: response.headers.get('content-type') ?? 'application/octet-stream' }, response.body);
    return [artifact.id];
  },
};
