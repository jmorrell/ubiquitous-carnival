import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rename, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, streamText } from '../src/store';
import type { Artifact, ArtifactOrigin, UrlAcquirerRegistration } from '../src/contract';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const registration: UrlAcquirerRegistration = { id: 'webpage', version: '1', urlOrigins: ['https://example.com'] };
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'url-acquisition-')); directories.push(directory);
  const store = await FileStore.open(directory); await store.installAcquirer(registration);
  return { directory, store };
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const plain = { mediaType: 'text/plain', origin: { kind: 'none' } as const };

describe('URL acquisition produces stored artifact input before processing', () => {
  it('commits HTML, images, and generated metadata together with their own origins and selected order', async () => {
    const { store, directory } = await setup();
    const run = await store.beginAcquisition('https://EXAMPLE.com:443/story#section'); const writer = store.acquisitionWriter(run.id);
    expect(run.url).toBe('https://example.com/story#section');
    const html = await writer.write({ mediaType: 'text/html', origin: { kind: 'url', url: run.url } }, streamText('<h1>Captured page</h1>'));
    const image = await writer.write({ mediaType: 'image/svg+xml', origin: { kind: 'url', url: 'https://cdn.example.net/photo.svg' } }, streamText('<svg/>'));
    const secondImage = await writer.write({ mediaType: 'image/svg+xml', origin: { kind: 'url', url: 'https://example.com/icon.svg' } }, streamText('<svg><title>Icon</title></svg>'));
    const metadata = await writer.write({ mediaType: 'application/json', origin: { kind: 'none' } }, streamText('{"title":"Captured page"}'));
    const omitted = await writer.write(plain, streamText('omitted'));
    expect(html).toMatchObject({ role: 'original', origin: { kind: 'url', url: run.url }, sha256: digest('<h1>Captured page</h1>') });
    expect(store.inputs()).toEqual([]); expect(store.items()).toEqual([]); expect(await readdir(join(directory, 'blobs'))).toEqual([]);
    const selected = [html, secondImage, image, metadata];
    const input = await store.completeAcquisition(run.id, selected);
    expect(input.originals).toEqual(selected); expect(store.inputs()).toEqual([input]); expect(store.items()).toEqual([]);
    expect(await readdir(join(directory, '.work'))).toEqual([]);
    expect((await readdir(join(directory, 'blobs'))).sort()).toEqual(selected.map(artifact => artifact.sha256).sort());
    const saved = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8'));
    expect(saved.artifacts).not.toHaveProperty(omitted.id); expect(saved.acquirers.webpage.registration).toEqual(registration);
    await expect(writer.write(plain, streamText('late'))).rejects.toThrow('not live');
    const reopened = await FileStore.open(directory); expect(reopened.inputs()).toEqual([input]); expect(reopened.acquisitionCandidates(run.url)).toEqual([registration]);
    await reopened.install({ id: 'reader', version: '1', accepts: ['text/html', 'image/*', 'application/json'], grants: [] });
    const processing = await reopened.begin(input.inputId);
    expect(await new Response(await reopened.host(processing.id).read(html.id)).text()).toBe('<h1>Captured page</h1>');
    expect(await new Response(await reopened.host(processing.id).read(image.id)).text()).toBe('<svg/>');
    await reopened.fail(processing.id, 'done');
  });

  it('rejects empty, duplicate, foreign, and invented outputs without exposing an input', async () => {
    const { store, directory } = await setup(); const run = await store.beginAcquisition('https://example.com/a');
    const artifact = await store.acquisitionWriter(run.id).write(plain, streamText('own'));
    const other = await store.beginAcquisition('https://example.com/b');
    const foreign = await store.acquisitionWriter(other.id).write(plain, streamText('foreign'));
    for (const artifacts of [[], [artifact, artifact], Array(101).fill(artifact)]) await expect(store.completeAcquisition(run.id, artifacts)).rejects.toThrow('unique acquired artifacts');
    for (const artifacts of [[foreign], [{ ...artifact, id: 'artifact_invented' }], [artifact, foreign]]) await expect(store.completeAcquisition(run.id, artifacts)).rejects.toThrow('outside acquisition');
    await expect(store.completeAcquisition(run.id, [null] as any)).rejects.toThrow('artifact descriptors');
    expect(store.inputs()).toEqual([]); expect(await readdir(join(directory, 'blobs'))).toEqual([]);
    await store.failAcquisition(run.id); await store.failAcquisition(other.id); expect(await readdir(join(directory, '.work'))).toEqual([]);
  });

  it('selects acquisition by submitted URL origin and asks for a choice when handlers overlap', async () => {
    const { store } = await setup();
    await expect(store.beginAcquisition('https://other.example/a', 'webpage')).rejects.toThrow('does not accept URL origin');
    await expect(store.beginAcquisition('https://example.com.evil/a')).rejects.toThrow('no acquisition handler');
    await expect(store.beginAcquisition('http://example.com/a')).rejects.toThrow('no acquisition handler');
    for (const url of ['file:///private/file', 'data:text/plain,hello', 'https://user:password@example.com/a', 'https://example.com/a\n']) await expect(store.beginAcquisition(url)).rejects.toThrow();
    for (const origin of ['https://example.com/', 'https://example.com/path', 'https://example.com?query', 'https://example.com#hash']) await expect(store.installAcquirer({ ...registration, urlOrigins: [origin] })).rejects.toThrow('exact HTTP(S) origins');
    await store.installAcquirer({ ...registration, id: 'second' });
    await expect(store.beginAcquisition('https://example.com/a')).rejects.toThrow('explicit acquisition handler choice');
    const run = await store.beginAcquisition('https://example.com/a', 'second');
    await store.removeAcquirer('second'); expect(store.acquisitionCandidates(run.url)).toEqual([registration]);
    await store.failAcquisition(run.id);
  });

  it('copies write metadata before streaming and commits canonical stored descriptors', async () => {
    const { store } = await setup(); const run = await store.beginAcquisition('https://example.com/a'); const writer = store.acquisitionWriter(run.id);
    const meta = { mediaType: 'text/plain', origin: { kind: 'file', relativePath: 'export/note.txt' } as ArtifactOrigin };
    const writing = writer.write(meta, streamText('actual bytes'));
    meta.mediaType = 'text/html'; meta.origin = { kind: 'none' };
    const artifact = await writing; const canonical = structuredClone(artifact);
    expect(artifact).toMatchObject({ mediaType: 'text/plain', origin: { kind: 'file', relativePath: 'export/note.txt' }, sha256: digest('actual bytes'), size: 12 });
    artifact.mediaType = 'image/png'; artifact.origin = { kind: 'url', url: 'https://invented.example' }; artifact.sha256 = 'invented'; artifact.size = 0; artifact.role = 'modified';
    const input = await store.completeAcquisition(run.id, [artifact]); expect(input.originals).toEqual([canonical]);
    input.originals[0].origin = { kind: 'none' }; expect(store.inputs()[0].originals).toEqual([canonical]);
  });

  it('validates per-artifact metadata before creating any stored bytes', async () => {
    const { store, directory } = await setup(); const run = await store.beginAcquisition('https://example.com/a'); const writer = store.acquisitionWriter(run.id);
    for (const origin of [null, { kind: 'other' }, { kind: 'url', url: '' }, { kind: 'file', relativePath: '../photo.jpg' }]) {
      await expect(writer.write({ mediaType: 'text/plain', origin } as any, streamText('invalid'))).rejects.toThrow('invalid original');
    }
    await expect(writer.write({ ...plain, mediaType: 'invalid' }, streamText('invalid'))).rejects.toThrow('media type');
    await expect(writer.write(plain, null as any)).rejects.toThrow('byte stream');
    expect(await readdir(join(directory, '.work', run.id))).toEqual([]); expect(store.inputs()).toEqual([]);
    await store.failAcquisition(run.id);
  });

  it('cleans a failed stream and discards earlier staged outputs when acquisition fails', async () => {
    const { store, directory } = await setup(); const run = await store.beginAcquisition('https://example.com/a'); const writer = store.acquisitionWriter(run.id);
    await writer.write(plain, streamText('earlier output'));
    let pulls = 0;
    const broken = new ReadableStream<Uint8Array>({ pull(controller) { if (pulls++ === 0) controller.enqueue(new TextEncoder().encode('partial')); else controller.error(new Error('retrieval interrupted')); } }, { highWaterMark: 0 });
    await expect(writer.write(plain, broken)).rejects.toThrow('retrieval interrupted');
    expect(await readdir(join(directory, '.work', run.id))).toHaveLength(1);
    await store.failAcquisition(run.id); expect(store.inputs()).toEqual([]); expect(await readdir(join(directory, '.work'))).toEqual([]); expect(await readdir(join(directory, 'blobs'))).toEqual([]);
    await expect(writer.write(plain, streamText('late'))).rejects.toThrow('not live');
  });

  it('rolls back promoted acquisition blobs on commit failure without removing shared bytes', async () => {
    const { store, directory } = await setup();
    const existing = await store.intake([{ ...plain, body: streamText('shared') }]);
    const run = await store.beginAcquisition('https://example.com/a'); const writer = store.acquisitionWriter(run.id);
    const artifacts: Artifact[] = [];
    for (const value of ['shared', 'new duplicate', 'new duplicate', 'other']) artifacts.push(await writer.write(plain, streamText(value)));
    await rename(join(directory, 'metadata.json'), join(directory, 'metadata.saved')); await mkdir(join(directory, 'metadata.json'));
    try {
      await expect(store.completeAcquisition(run.id, artifacts)).rejects.toThrow();
      expect(store.inputs()).toEqual([existing]); expect(await readdir(join(directory, 'blobs'))).toEqual([digest('shared')]);
      expect(await readFile(join(directory, 'blobs', digest('shared')), 'utf8')).toBe('shared');
      expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      await rm(join(directory, 'metadata.json'), { recursive: true }); await rename(join(directory, 'metadata.saved'), join(directory, 'metadata.json'));
      await store.failAcquisition(run.id);
    }
    expect((await FileStore.open(directory)).inputs()).toEqual([existing]); expect(await readdir(join(directory, '.work'))).toEqual([]);
  });

  it('accepts browser captures directly without an acquisition handler', async () => {
    const { store } = await setup(); await store.removeAcquirer('webpage');
    const input = await store.intake([
      { mediaType: 'text/html', origin: { kind: 'url', url: 'https://private.example/account' }, body: streamText('<p>Captured locally</p>') },
      { mediaType: 'image/svg+xml', origin: { kind: 'url', url: 'https://cdn.example/photo.svg' }, body: streamText('<svg/>') },
    ]);
    expect(input.originals.map(artifact => artifact.origin)).toEqual([{ kind: 'url', url: 'https://private.example/account' }, { kind: 'url', url: 'https://cdn.example/photo.svg' }]);
    expect(store.inputs()).toEqual([input]); expect(store.items()).toEqual([]);
  });
});
