import { expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Input, Publication, UrlAcquirer } from '../src/contract';
import { FileStore } from '../src/store';
import { createRunner, runAcquisitionInProcess } from '../src/runner';
import { createDynamicRuntime } from '../runtime/dynamic-runtime';
import { downloadRegistration } from '../plugins/download';

async function pageServer() {
  const resources = new Map([
    ['/page.html', { mediaType: 'text/html', bytes: Buffer.from('<!doctype html><title>Two colors</title><img src="/blue.svg"><img src="/green.svg">') }],
    ['/blue.svg', { mediaType: 'image/svg+xml', bytes: await readFile(new URL('../fixtures/gallery/blue.svg', import.meta.url)) }],
    ['/green.svg', { mediaType: 'image/svg+xml', bytes: await readFile(new URL('../fixtures/gallery/day-2/green.svg', import.meta.url)) }],
  ]);
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url!);
    if (request.url === '/redirect') { response.writeHead(302, { location: '/blue.svg' }).end(); return; }
    const resource = resources.get(request.url!);
    if (!resource) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': resource.mediaType });
    response.end(resource.bytes);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin, resources, requests,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

// This parser only knows the fixture's img syntax. A production acquirer can use a browser,
// an API, or another retrieval strategy without changing how it creates artifacts.
const fixturePageAcquirer: UrlAcquirer = {
  async acquire(url, artifacts) {
    const page = await fetch(url);
    if (!page.ok) throw new Error(`Page fetch failed (${page.status})`);
    const html = await page.text();
    const result = [await artifacts.write({ mediaType: 'text/html', origin: { kind: 'url', url: page.url } }, new Blob([html]).stream())];
    for (const match of html.matchAll(/<img src="([^"]+)">/g)) {
      const image = await fetch(new URL(match[1], page.url));
      if (!image.ok || !image.body) throw new Error('Image fetch failed');
      result.push(await artifacts.write({ mediaType: image.headers.get('content-type')!, origin: { kind: 'url', url: image.url } }, image.body));
    }
    return result;
  },
};

const bundleProcessorSource = `
  import { WorkerEntrypoint } from 'cloudflare:workers';
  export default class extends WorkerEntrypoint {
    async process(input) {
      const lines = [];
      for (const artifact of input.originals) {
        const response = await this.env.HOST.fetch(new Request('https://capability.invalid/read/' + artifact.id));
        if (!response.ok) throw new Error('Original unavailable');
        const bytes = await response.arrayBuffer();
        lines.push(artifact.mediaType + ': ' + bytes.byteLength + ' bytes');
      }
      const response = await this.env.HOST.fetch(new Request('https://capability.invalid/write', {
        method: 'PUT', headers: { 'x-role': 'bundle-summary', 'content-type': 'text/plain' }, body: lines.join('\\n'),
      }));
      if (!response.ok) throw new Error('Summary write failed');
      const fallback = await response.json();
      return [{
        title: 'Captured webpage', description: 'HTML and its images in one item.',
        artifacts: [...input.originals.map(artifact => artifact.id), fallback.id],
        search: input.originals.map(artifact => ({ text: artifact.origin.url, artifact: artifact.id })),
        presentation: { fallback: fallback.id },
      }];
    }
  }
`;

it('acquires HTML and images as an artifact array, processes the bundle in a real worker, and supports direct capture', async () => {
  const fixture = await pageServer();
  const directory = await mkdtemp(join(tmpdir(), 'acquisition-flow-'));
  const store = await FileStore.open(directory);
  await store.installAcquirer({ id: 'fixture-page', version: '0.1.0', urlOrigins: [fixture.origin] });
  await store.install({ id: 'fixture-bundle', version: '0.1.0', accepts: ['text/html', 'image/*'], grants: [] });
  const runtime = await createDynamicRuntime(request => store.capabilityFetch(request));
  async function process(input: Input) {
    const run = await store.begin(input.inputId, 'fixture-bundle');
    try {
      return await store.publish(run.id, await runtime.execute<Publication[]>(bundleProcessorSource, { runId: run.id, input }));
    } catch (error) { await store.fail(run.id, error); throw error; }
  }
  try {
    const pageUrl = fixture.origin + '/page.html';
    const acquired = await runAcquisitionInProcess(store, pageUrl, 'fixture-page', fixturePageAcquirer);
    expect(fixture.requests).toEqual(['/page.html', '/blue.svg', '/green.svg']);
    expect(acquired.originals.map(artifact => artifact.mediaType)).toEqual(['text/html', 'image/svg+xml', 'image/svg+xml']);
    expect(acquired.originals.map(artifact => artifact.origin)).toEqual([...fixture.resources.keys()].map(path => ({ kind: 'url', url: fixture.origin + path })));
    expect(store.items()).toHaveLength(0);
    const [published] = await process(acquired);
    expect(published.item.artifacts.filter(artifact => artifact.role === 'original')).toEqual(acquired.originals);
    for (const artifact of acquired.originals) {
      if (artifact.origin.kind !== 'url') throw new Error('Expected URL origin');
      const bytes = await new Response(store.visibleArtifact(published.item.itemId, artifact.id).body).arrayBuffer();
      expect(Buffer.from(bytes)).toEqual(fixture.resources.get(new URL(artifact.origin.url).pathname)!.bytes);
    }
    expect(store.search(pageUrl)).toHaveLength(1);

    // Already captured bytes enter the same processing flow without running an acquirer.
    const captured = await store.intake([...fixture.resources].map(([path, resource]) => ({
      mediaType: resource.mediaType, origin: { kind: 'url' as const, url: fixture.origin + path }, body: new Blob([resource.bytes]).stream(),
    })));
    const [capturedPublication] = await process(captured);
    expect(fixture.requests).toHaveLength(3);
    expect(captured.originals.map(artifact => artifact.sha256)).toEqual(acquired.originals.map(artifact => artifact.sha256));
    expect(captured.originals.every((artifact, index) => artifact.id !== acquired.originals[index].id)).toBe(true);
    expect(capturedPublication.publication.title).toBe(published.publication.title);
    const reloaded = await FileStore.open(directory);
    expect(reloaded.inputs()).toEqual(store.inputs());
    expect(reloaded.results(acquired.inputId)).toEqual([published]);
    expect(reloaded.results(captured.inputId)).toEqual([capturedPublication]);
    await writeFile(new URL('../evidence/acquisition-observed.json', import.meta.url), JSON.stringify({
      observedAt: new Date().toISOString(),
      acquisitionEnvironment: 'In-process UrlAcquirer using ordinary fetch; environment and permissions are outside the contract',
      processingEnvironment: 'Miniflare 5 / workerd Dynamic Worker',
      flow: 'URL → HTML + two image artifacts → complete Input → published bundle',
      fixture: { pageUrl, requests: fixture.requests }, acquired, published,
      capture: { input: captured, publication: capturedPublication, acquisitionRequests: 0, sameStoredBytes: true },
      restartRetainedInputsAndResults: true,
    }, null, 2) + '\n');
  } finally { await runtime.dispose(); await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});

it('runs the download example with ordinary fetch and records the final response URL', async () => {
  const fixture = await pageServer();
  const directory = await mkdtemp(join(tmpdir(), 'acquisition-download-'));
  const store = await FileStore.open(directory);
  await store.installAcquirer({ ...downloadRegistration, urlOrigins: [fixture.origin] });
  const runner = await createRunner(store);
  try {
    const input = await runner.acquire(fixture.origin + '/redirect', 'url-download');
    expect(input.originals).toHaveLength(1);
    expect(input.originals[0]).toMatchObject({ mediaType: 'image/svg+xml', origin: { kind: 'url', url: fixture.origin + '/blue.svg' } });
    await expect(runner.acquire(fixture.origin + '/missing', 'url-download')).rejects.toThrow('URL download failed (404)');
    expect(store.inputs()).toEqual([input]);
    expect(store.items()).toHaveLength(0);
    expect(await readdir(join(directory, '.work'))).toEqual([]);
  } finally { await runner.dispose(); await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});
