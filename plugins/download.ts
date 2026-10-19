import type { Acquire, AcquisitionRegistration } from '../src/contract';

/** Example handler selection. Acquisition execution environments are outside this contract. */
export const downloadRegistration: AcquisitionRegistration = {
  id: 'url-download', version: '0.1.0', urlOrigins: ['https://example.test'],
};
/** Downloads one response body. It does not crawl links or pretend to capture a full webpage. */
export const acquireUrl: Acquire = async (url, write) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`URL download failed (${response.status})`);
  if (!response.body) throw new Error('URL response has no body');
  const artifact = await write({
    mediaType: response.headers.get('content-type') ?? 'application/octet-stream',
    origin: { kind: 'url', url: response.url },
  }, response.body);
  return [artifact];
};
