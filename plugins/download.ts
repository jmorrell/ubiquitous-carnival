import type { UrlAcquirer, UrlAcquirerRegistration } from '../src/contract';

/** Example handler selection. Acquisition execution environments are outside this contract. */
export const downloadRegistration: UrlAcquirerRegistration = {
  id: 'url-download', version: '0.1.0', urlOrigins: ['https://example.test'],
};
/** Downloads one response body. It does not crawl links or pretend to capture a full webpage. */
export const downloadAcquirer: UrlAcquirer = {
  async acquire(url, artifacts) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`URL download failed (${response.status})`);
    if (!response.body) throw new Error('URL response has no body');
    const artifact = await artifacts.write({
      mediaType: response.headers.get('content-type') ?? 'application/octet-stream',
      origin: { kind: 'url', url: response.url },
    }, response.body);
    return [artifact];
  },
};
