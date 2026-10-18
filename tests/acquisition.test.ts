import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rename, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, streamText, type UrlFetcher } from '../src/store';
import type { UrlAcquirerRegistration } from '../src/contract';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const registration: UrlAcquirerRegistration = { id: 'webpage', version: '1', urlOrigins: ['https://example.com'], grants: ['fetch'] };
async function setup(fetcher?: UrlFetcher) {
  const directory = await mkdtemp(join(tmpdir(), 'url-acquisition-')); directories.push(directory);
  const store = await FileStore.open(directory, undefined, fetcher); await store.installAcquirer(registration);
  return { directory, store };
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

describe('URL acquisition produces stored artifact input before processing', () => {
  it('fetches only the submitted URL, strips response headers, and commits selected originals in order', async () => {
    const fetcher = vi.fn(async () => new Response('<h1>Captured page</h1>', { headers: { 'content-type': 'text/html', 'set-cookie': 'session=private', 'x-host-secret': 'private' } }));
    const { store, directory } = await setup(fetcher);
    const run = await store.beginAcquisition('https://EXAMPLE.com:443/story#section'); const host = store.acquisitionHost(run.id);
    expect(run.url).toBe('https://example.com/story#section');
    const response = await store.capabilityFetch(new Request('https://capability/fetch?url=https://elsewhere.invalid', { headers: { 'x-run': run.id, authorization: 'guest value' } }));
    expect(fetcher.mock.calls).toEqual([[run.url]]); expect([...response.headers]).toEqual([['content-type', 'text/html']]);
    const html = await host.write({ mediaType: 'text/html' }, response.body!);
    const text = await host.write({ mediaType: 'text/plain' }, streamText('Captured page'));
    const omitted = await host.write({ mediaType: 'text/plain' }, streamText('omitted'));
    expect(html).toMatchObject({ role: 'original', origin: { kind: 'url', url: run.url }, sha256: digest('<h1>Captured page</h1>') });
    expect(store.inputs()).toEqual([]); expect(store.items()).toEqual([]); expect(await readdir(join(directory, 'blobs'))).toEqual([]);
    const input = await store.completeAcquisition(run.id, [text.id, html.id]);
    expect(input.originals).toEqual([text, html]); expect(store.inputs()).toEqual([input]); expect(store.items()).toEqual([]);
    expect(await readdir(join(directory, '.work'))).toEqual([]);
    expect((await readdir(join(directory, 'blobs'))).sort()).toEqual([text.sha256, html.sha256].sort());
    const saved = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8'));
    expect(saved.artifacts).not.toHaveProperty(omitted.id); expect(saved.acquirers.webpage.registration).toEqual(registration);
    await expect(host.fetch()).rejects.toThrow('not live'); await expect(host.write({ mediaType: 'text/plain' }, streamText('late'))).rejects.toThrow('not live');
    const reopened = await FileStore.open(directory); expect(reopened.inputs()).toEqual([input]); expect(reopened.acquisitionCandidates(run.url)).toEqual([registration]);
    await reopened.install({ id: 'reader', version: '1', accepts: ['text/plain', 'text/html'], grants: [] });
    const processing = await reopened.begin(input.inputId);
    expect(await new Response(await reopened.host(processing.id).read(html.id)).text()).toBe('<h1>Captured page</h1>');
    await reopened.fail(processing.id, 'done');
  });

  it('rejects empty, duplicate, foreign, and invented completion references without exposing an input', async () => {
    const { store, directory } = await setup(); const run = await store.beginAcquisition('https://example.com/a');
    const artifact = await store.acquisitionHost(run.id).write({ mediaType: 'text/plain' }, streamText('own'));
    const other = await store.beginAcquisition('https://example.com/b');
    const foreign = await store.acquisitionHost(other.id).write({ mediaType: 'text/plain' }, streamText('foreign'));
    for (const ids of [[], [artifact.id, artifact.id], Array(101).fill(artifact.id)]) await expect(store.completeAcquisition(run.id, ids)).rejects.toThrow('unique acquired artifacts');
    for (const ids of [[foreign.id], ['artifact_invented'], [artifact.id, foreign.id]]) await expect(store.completeAcquisition(run.id, ids)).rejects.toThrow('outside acquisition');
    expect(store.inputs()).toEqual([]); expect(await readdir(join(directory, 'blobs'))).toEqual([]);
    await store.failAcquisition(run.id); await store.failAcquisition(other.id); expect(await readdir(join(directory, '.work'))).toEqual([]);
  });

  it('keeps acquisition selection separate, checks exact origins, and requires fetch grants and an adapter', async () => {
    const { store, directory } = await setup();
    await expect(store.beginAcquisition('https://other.example/a', 'webpage')).rejects.toThrow('does not accept URL origin');
    await expect(store.beginAcquisition('https://example.com.evil/a')).rejects.toThrow('no acquisition handler');
    await expect(store.beginAcquisition('http://example.com/a')).rejects.toThrow('no acquisition handler');
    for (const url of ['file:///private/file', 'data:text/plain,hello', 'https://user:password@example.com/a', 'https://example.com/a\n']) await expect(store.beginAcquisition(url)).rejects.toThrow();
    for (const origin of ['https://example.com/', 'https://example.com/path', 'https://example.com?query', 'https://example.com#hash']) await expect(store.installAcquirer({ ...registration, urlOrigins: [origin] })).rejects.toThrow('exact HTTP(S) origins');
    await store.installAcquirer({ ...registration, id: 'second', grants: [] });
    await expect(store.beginAcquisition('https://example.com/a')).rejects.toThrow('explicit acquisition handler choice');
    const ungranted = await store.beginAcquisition('https://example.com/a', 'second');
    await expect(store.acquisitionHost(ungranted.id).fetch()).rejects.toThrow('fetch grant required');
    const granted = await store.beginAcquisition('https://example.com/a', 'webpage');
    await expect(store.acquisitionHost(granted.id).fetch()).rejects.toThrow('adapter is not configured');
    for (const path of ['/read/artifact_invented', '/transcribe', '/unknown']) {
      const response = await store.capabilityFetch(new Request(`https://capability${path}`, { method: path === '/transcribe' ? 'POST' : 'GET', headers: { 'x-run': granted.id } }));
      expect(response.status).toBe(400); expect(await response.text()).toContain('unknown acquisition');
    }
    await store.failAcquisition(ungranted.id); await store.failAcquisition(granted.id); expect(await readdir(join(directory, '.work'))).toEqual([]);
  });

  it('cancels rejected fetch responses and never creates an input from them', async () => {
    const cancelled: unknown[] = []; let response!: Response;
    const { store } = await setup(async () => response);
    const run = await store.beginAcquisition('https://example.com/a'); const host = store.acquisitionHost(run.id);
    for (const kind of ['error', 'redirect', 'followed-redirect', 'bad-type']) {
      const body = new ReadableStream<Uint8Array>({ cancel(reason) { cancelled.push(reason); } }, { highWaterMark: 0 });
      response = new Response(body, { status: kind === 'error' ? 500 : kind === 'redirect' ? 302 : 200, headers: { 'content-type': kind === 'bad-type' ? 'not-a-media-type' : 'text/html' } });
      if (kind === 'followed-redirect') Object.defineProperty(response, 'redirected', { value: true });
      await expect(host.fetch()).rejects.toThrow(kind === 'bad-type' ? 'media type' : 'without redirects');
    }
    expect(cancelled).toHaveLength(4); expect(store.inputs()).toEqual([]); await store.failAcquisition(run.id);
  });

  it('revokes a pending fetch after removal without holding the metadata queue', async () => {
    let release!: (response: Response) => void; let entered!: () => void;
    const pending = new Promise<Response>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
    const { store, directory } = await setup(async () => { entered(); return pending; });
    const run = await store.beginAcquisition('https://example.com/a'); const host = store.acquisitionHost(run.id);
    const fetching = host.fetch(); const rejected = expect(fetching).rejects.toThrow('revoked'); await started;
    await store.removeAcquirer('webpage'); // Must finish while the network adapter is still pending.
    let cancelled = false;
    release(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/plain' } }));
    await rejected; expect(cancelled).toBe(true);
    await store.installAcquirer(registration); await expect(host.fetch()).rejects.toThrow('revoked');
    await expect(store.completeAcquisition(run.id, [])).rejects.toThrow('revoked');
    await store.failAcquisition(run.id); expect(store.inputs()).toEqual([]); expect(await readdir(join(directory, '.work'))).toEqual([]);
  });

  it('cleans a failed stream and discards earlier staged outputs when acquisition fails', async () => {
    const { store, directory } = await setup(); const run = await store.beginAcquisition('https://example.com/a'); const host = store.acquisitionHost(run.id);
    await host.write({ mediaType: 'text/plain' }, streamText('earlier output'));
    let pulls = 0;
    const broken = new ReadableStream<Uint8Array>({ pull(controller) { if (pulls++ === 0) controller.enqueue(new TextEncoder().encode('partial')); else controller.error(new Error('retrieval interrupted')); } }, { highWaterMark: 0 });
    await expect(host.write({ mediaType: 'text/plain' }, broken)).rejects.toThrow('retrieval interrupted');
    expect(await readdir(join(directory, '.work', run.id))).toHaveLength(1);
    await store.failAcquisition(run.id); expect(store.inputs()).toEqual([]); expect(await readdir(join(directory, '.work'))).toEqual([]); expect(await readdir(join(directory, 'blobs'))).toEqual([]);
    await expect(host.fetch()).rejects.toThrow('not live');
  });

  it('rolls back promoted acquisition blobs on commit failure without removing shared bytes', async () => {
    const { store, directory } = await setup();
    const existing = await store.intake([{ mediaType: 'text/plain', origin: { kind: 'none' }, body: streamText('shared') }]);
    const run = await store.beginAcquisition('https://example.com/a'); const host = store.acquisitionHost(run.id);
    const artifacts = [];
    for (const value of ['shared', 'new duplicate', 'new duplicate', 'other']) artifacts.push(await host.write({ mediaType: 'text/plain' }, streamText(value)));
    await rename(join(directory, 'metadata.json'), join(directory, 'metadata.saved')); await mkdir(join(directory, 'metadata.json'));
    try {
      await expect(store.completeAcquisition(run.id, artifacts.map(artifact => artifact.id))).rejects.toThrow();
      expect(store.inputs()).toEqual([existing]); expect(await readdir(join(directory, 'blobs'))).toEqual([digest('shared')]);
      expect(await readFile(join(directory, 'blobs', digest('shared')), 'utf8')).toBe('shared');
      expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      await rm(join(directory, 'metadata.json'), { recursive: true }); await rename(join(directory, 'metadata.saved'), join(directory, 'metadata.json'));
      await store.failAcquisition(run.id);
    }
    expect((await FileStore.open(directory)).inputs()).toEqual([existing]); expect(await readdir(join(directory, '.work'))).toEqual([]);
  });

  it('accepts local browser captures directly without invoking URL acquisition', async () => {
    const fetcher = vi.fn(async () => { throw new Error('must not fetch'); }); const { store } = await setup(fetcher);
    const input = await store.intake([{ mediaType: 'text/html', origin: { kind: 'url', url: 'https://private.example/account' }, body: streamText('<p>Captured locally</p>') }]);
    expect(input.originals[0].origin).toEqual({ kind: 'url', url: 'https://private.example/account' });
    expect(fetcher).not.toHaveBeenCalled(); expect(store.inputs()).toEqual([input]);
  });
});
