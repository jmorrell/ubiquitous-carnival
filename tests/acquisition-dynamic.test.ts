import { expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { FileStore } from '../src/store';
import { createRunner } from '../src/runner';
import { createDynamicRuntime } from '../runtime/dynamic-runtime';
import { downloadRegistration } from '../plugins/download';
import { galleryRegistration } from '../plugins/gallery';

async function imageServer() {
  const bytes = await readFile(new URL('../fixtures/gallery/blue.svg', import.meta.url));
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    if (request.url !== '/image.svg') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': 'image/svg+xml', 'set-cookie': 'fixture-session=private', 'x-private-header': 'host-only' });
    response.end(bytes);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/image.svg`;
  return {
    bytes, url, requests: () => requests,
    // This exact-URL fixture adapter is host-owned. Registration is not permission to fetch arbitrary hosts.
    fetch: async (target: string) => {
      if (target !== url) throw new Error('fixture URL not allowed');
      return fetch(target, { redirect: 'manual' });
    },
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

it('acquires a URL through a Dynamic Worker, then processes its artifacts; capture bypasses acquisition', async () => {
  const fixture = await imageServer();
  const directory = await mkdtemp(join(tmpdir(), 'dynamic-acquisition-'));
  const store = await FileStore.open(directory, undefined, fixture.fetch);
  await store.installAcquirer({ ...downloadRegistration, urlOrigins: [new URL(fixture.url).origin] });
  await store.install(galleryRegistration);
  const runner = await createRunner(store);
  try {
    expect(store.inputs()).toHaveLength(0);
    expect(store.acquisitionCandidates(fixture.url).map(registration => registration.id)).toEqual(['url-download']);
    const acquired = await runner.acquire(fixture.url, 'url-download');
    expect(fixture.requests()).toBe(1);
    expect(acquired.originals).toHaveLength(1);
    expect(acquired.originals[0]).toMatchObject({ role: 'original', mediaType: 'image/svg+xml', origin: { kind: 'url', url: fixture.url } });
    expect(store.items()).toHaveLength(0);
    expect(store.candidates(acquired.inputId).map(registration => registration.id)).toEqual(['image-gallery']);
    const [published] = await runner.process(acquired.inputId, 'image-gallery');
    expect(Buffer.from(await new Response(store.visibleArtifact(published.item.itemId, acquired.originals[0].id).body).arrayBuffer())).toEqual(fixture.bytes);
    expect(store.search(fixture.url)).toHaveLength(1);

    // A browser can already have these bytes, including from an authenticated page. URL origin does not fetch.
    const captured = await store.intake([{ mediaType: 'image/svg+xml', origin: { kind: 'url', url: fixture.url }, body: new Blob([fixture.bytes]).stream() }]);
    const [capturedPublication] = await runner.process(captured.inputId, 'image-gallery');
    expect(fixture.requests()).toBe(1);
    expect(captured.originals[0].sha256).toBe(acquired.originals[0].sha256);
    expect(captured.originals[0].id).not.toBe(acquired.originals[0].id);
    expect(capturedPublication.publication.title).toBe(published.publication.title);
    const reloaded = await FileStore.open(directory);
    expect(reloaded.inputs()).toEqual(store.inputs());
    expect(reloaded.results(acquired.inputId)).toEqual([published]);
    expect(reloaded.results(captured.inputId)).toEqual([capturedPublication]);
    await writeFile(new URL('../evidence/acquisition-observed.json', import.meta.url), JSON.stringify({
      observedAt: new Date().toISOString(), backend: 'Miniflare 5 / workerd Dynamic Workers',
      acquisition: 'URL-only submission → scoped fetch of local HTTP fixture → stored image artifact',
      fixture: { url: fixture.url, requests: fixture.requests(), bytes: fixture.bytes.length },
      acquired, published,
      capture: { input: captured, publication: capturedPublication, acquisitionRequests: 0, sameStoredBytes: true },
      restartRetainedInputsAndResults: true,
    }, null, 2) + '\n');
  } finally { await runner.dispose(); await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});

it('separates acquisition and processing authority in real workers and cleans up a failed acquisition', async () => {
  const fixture = await imageServer();
  const directory = await mkdtemp(join(tmpdir(), 'dynamic-acquisition-scope-'));
  const store = await FileStore.open(directory, undefined, fixture.fetch);
  await store.installAcquirer({ ...downloadRegistration, urlOrigins: [new URL(fixture.url).origin] });
  await store.install(galleryRegistration);
  const runtime = await createDynamicRuntime(request => store.capabilityFetch(request));
  const source = `
    import { WorkerEntrypoint } from 'cloudflare:workers';
    export default class extends WorkerEntrypoint {
      async inspect(url) {
        let ambientFetch;
        try { await fetch(url); ambientFetch = 'allowed'; } catch (error) { ambientFetch = error.message; }
        const fetched = await this.env.HOST.fetch(new Request('https://capability.invalid/fetch'));
        const fetchedHeaders = [...fetched.headers.keys()];
        const fetchedBody = await fetched.text();
        const read = await this.env.HOST.fetch(new Request('https://capability.invalid/read/foreign'));
        const transcribe = await this.env.HOST.fetch(new Request('https://capability.invalid/transcribe', { method: 'POST', body: JSON.stringify({ original: 'foreign' }) }));
        return { ambientFetch, fetchStatus: fetched.status, fetchedHeaders, fetchedBody, readStatus: read.status, transcribeStatus: transcribe.status };
      }
      acquire(url) { return this.inspect(url); }
      process(url) { return this.inspect(url); }
    }
  `;
  try {
    const acquisition = await store.beginAcquisition(fixture.url, 'url-download');
    const receipt = await runtime.execute<{ ambientFetch: string; fetchStatus: number; fetchedHeaders: string[]; fetchedBody: string; readStatus: number; transcribeStatus: number }>(source, { runId: acquisition.id, input: acquisition.url, operation: 'acquire' });
    expect(receipt.ambientFetch).toMatch(/not permitted to access the internet/);
    expect(receipt.fetchStatus).toBe(200);
    expect(receipt.fetchedBody).toBe(fixture.bytes.toString());
    expect(receipt.fetchedHeaders).not.toContain('set-cookie');
    expect(receipt.fetchedHeaders).not.toContain('x-private-header');
    expect(receipt.readStatus).toBe(400);
    expect(receipt.transcribeStatus).toBe(400);
    await store.failAcquisition(acquisition.id);

    const input = await store.intake([{ mediaType: 'image/svg+xml', origin: { kind: 'none' }, body: new Blob([fixture.bytes]).stream() }]);
    const processing = await store.begin(input.inputId, 'image-gallery');
    const denied = await runtime.execute<{ ambientFetch: string; fetchStatus: number }>(source, { runId: processing.id, input: fixture.url });
    expect(denied.ambientFetch).toMatch(/not permitted to access the internet/);
    expect(denied.fetchStatus).toBe(400);
    expect(fixture.requests()).toBe(1);
    await store.fail(processing.id, new Error('probe complete'));

    const failed = await store.beginAcquisition(fixture.url, 'url-download');
    await expect(runtime.execute(`
      import { WorkerEntrypoint } from 'cloudflare:workers';
      export default class extends WorkerEntrypoint {
        async acquire() {
          const response = await this.env.HOST.fetch(new Request('https://capability.invalid/write', { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'incomplete acquisition' }));
          if (!response.ok) throw new Error('staging failed');
          throw new Error('fixture failed after staging');
        }
      }
    `, { runId: failed.id, input: failed.url, operation: 'acquire' })).rejects.toThrow('fixture failed after staging');
    await store.failAcquisition(failed.id);
    expect(store.inputs()).toEqual([input]);
    expect(store.items()).toHaveLength(0);
    expect(await readdir(join(directory, '.work'))).toEqual([]);
    expect(await readdir(join(directory, 'blobs'))).toEqual([input.originals[0].sha256]);
  } finally { await runtime.dispose(); await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});
