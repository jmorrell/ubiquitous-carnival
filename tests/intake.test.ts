import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rename, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, streamText, type OriginalUpload } from '../src/store';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'batch-intake-')); directories.push(directory);
  return { directory, store: await FileStore.open(directory) };
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

describe('completed ingestion becomes one processor input', () => {
  it('keeps ordered origins and host-issued identities across mixed originals', async () => {
    const { store, directory } = await setup();
    // Byte contents are synthetic; this test exercises ingestion, not image decoding.
    const uploads = [
      { origin: { kind: 'file' as const, relativePath: 'holiday/day-1/beach.jpg', ignored: 'not retained' }, mediaType: 'image/jpeg', body: streamText('first image'), id: 'caller-selected', size: 0, sha256: 'caller-hash' },
      { origin: { kind: 'url' as const, url: 'https://example.org/map' }, mediaType: 'image/png', body: streamText('second image') },
      { origin: { kind: 'none' as const }, mediaType: 'image/svg+xml', body: streamText('third image') },
    ];
    const input = await store.intake(uploads);
    expect(store.inputs()).toEqual([input]); expect(store.items()).toEqual([]);
    expect(input.inputId).toMatch(/^input_/); expect(new Set(input.originals.map(original => original.id)).size).toBe(3);
    expect(input.originals.map(original => original.origin)).toEqual([
      { kind: 'file', relativePath: 'holiday/day-1/beach.jpg' },
      { kind: 'url', url: 'https://example.org/map' },
      { kind: 'none' },
    ]);
    await store.install({ id: 'gallery', version: '1', accepts: ['image/*'] });
    const run = await store.begin(input.inputId); expect(store.input(run.id)).toEqual(input);
    for (const [index, text] of ['first image', 'second image', 'third image'].entries()) {
      const original = input.originals[index];
      expect(original).toMatchObject({ role: 'original', size: Buffer.byteLength(text), sha256: digest(text) });
      expect(original.id).toMatch(/^artifact_/); expect(original.id).not.toBe('caller-selected');
      expect(original).not.toHaveProperty('filename'); expect(original).not.toHaveProperty('relativePath'); expect(original).not.toHaveProperty('sourceUrl');
      expect(await new Response(await store.host(run.id).read(original.id)).text()).toBe(text);
    }
    const generated = await store.host(run.id).write({ role: 'caption', mediaType: 'text/plain' }, streamText('Generated caption'));
    expect(generated.origin).toEqual({ kind: 'none' });
    await store.fail(run.id, 'test cleanup');
    expect((await FileStore.open(directory)).inputs()).toEqual([input]);
    expect(await readdir(join(directory, '.work'))).toEqual([]);
  });

  it('snapshots each origin before asynchronous streaming begins', async () => {
    const { store, directory } = await setup();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const reading = new Promise<void>(resolve => { entered = resolve; });
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) { entered(); await gate; controller.enqueue(new TextEncoder().encode('first')); controller.close(); },
    }, { highWaterMark: 0 });
    const fileOrigin = { kind: 'file' as const, relativePath: 'photo.jpg' };
    const urlOrigin = { kind: 'url' as const, url: 'https://example.com/original' };
    const uploads: OriginalUpload[] = [
      { mediaType: 'image/jpeg', origin: fileOrigin, body },
      { mediaType: 'image/png', origin: urlOrigin, body: streamText('second') },
    ];
    const intake = store.intake(uploads); await reading;
    fileOrigin.relativePath = '../changed.jpg'; urlOrigin.url = 'https://example.com/changed';
    uploads[0].origin = { kind: 'none' }; uploads[1].mediaType = 'text/plain'; release();
    const input = await intake;
    expect(input.originals.map(original => ({ mediaType: original.mediaType, origin: original.origin }))).toEqual([
      { mediaType: 'image/jpeg', origin: { kind: 'file', relativePath: 'photo.jpg' } },
      { mediaType: 'image/png', origin: { kind: 'url', url: 'https://example.com/original' } },
    ]);
    expect((await FileStore.open(directory)).inputs()).toEqual([input]);
  });

  it('exposes no partial input while a later original is still streaming', async () => {
    const { store, directory } = await setup();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const reading = new Promise<void>(resolve => { entered = resolve; });
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) { entered(); controller.enqueue(new TextEncoder().encode('second')); await gate; controller.close(); },
    }, { highWaterMark: 0 });
    const intake = store.intake([
      { origin: { kind: 'none' }, mediaType: 'image/jpeg', body: streamText('first') }, { origin: { kind: 'none' }, mediaType: 'image/png', body },
    ]);
    await reading;
    try {
      expect(store.inputs()).toEqual([]); expect(await readdir(join(directory, 'blobs'))).toEqual([]);
      expect(await readdir(join(directory, '.work'))).toHaveLength(2);
      // Uploading does not reserve the metadata queue or publish a draft input.
      await store.install({ id: 'gallery', version: '1', accepts: ['image/*'] });
      const saved = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8'));
      expect(saved.inputs).toEqual({}); expect(saved.artifacts).toEqual({});
    } finally { release(); }
    const input = await intake;
    expect(store.inputs()).toEqual([input]); expect(input.originals).toHaveLength(2);
    expect(await readdir(join(directory, '.work'))).toEqual([]);
  });

  it('cleans an interrupted batch without removing an existing shared blob', async () => {
    const { store, directory } = await setup();
    const existing = await store.intake([{ origin: { kind: 'none' }, mediaType: 'text/plain', body: streamText('shared') }]);
    let pulls = 0;
    const broken = new ReadableStream<Uint8Array>({ pull(controller) {
      if (pulls++ === 0) controller.enqueue(new TextEncoder().encode('partial'));
      else controller.error(new Error('upload interrupted'));
    } }, { highWaterMark: 0 });
    await expect(store.intake([
      { origin: { kind: 'none' }, mediaType: 'text/plain', body: streamText('shared') },
      { origin: { kind: 'none' }, mediaType: 'text/plain', body: streamText('unique but incomplete batch') },
      { origin: { kind: 'none' }, mediaType: 'text/plain', body: broken },
    ])).rejects.toThrow('upload interrupted');
    expect(store.inputs()).toEqual([existing]);
    expect(await readdir(join(directory, '.work'))).toEqual([]);
    expect(await readdir(join(directory, 'blobs'))).toEqual([digest('shared')]);
    expect((await FileStore.open(directory)).inputs()).toEqual([existing]);
  });

  it('rolls back newly promoted blobs if the batch metadata commit fails', async () => {
    const { store, directory } = await setup();
    const existing = await store.intake([{ origin: { kind: 'none' }, mediaType: 'text/plain', body: streamText('shared') }]);
    await rename(join(directory, 'metadata.json'), join(directory, 'metadata.saved')); await mkdir(join(directory, 'metadata.json'));
    try {
      await expect(store.intake([
        { origin: { kind: 'none' }, mediaType: 'text/plain', body: streamText('shared') },
        { origin: { kind: 'none' }, mediaType: 'text/plain', body: streamText('new duplicate') },
        { origin: { kind: 'none' }, mediaType: 'text/plain', body: streamText('new duplicate') },
        { origin: { kind: 'none' }, mediaType: 'text/plain', body: streamText('another new blob') },
      ])).rejects.toThrow();
      expect(store.inputs()).toEqual([existing]);
      expect(await readdir(join(directory, '.work'))).toEqual([]);
      expect(await readdir(join(directory, 'blobs'))).toEqual([digest('shared')]);
      expect(await readFile(join(directory, 'blobs', digest('shared')), 'utf8')).toBe('shared');
      expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      await rm(join(directory, 'metadata.json'), { recursive: true }); await rename(join(directory, 'metadata.saved'), join(directory, 'metadata.json'));
    }
    expect((await FileStore.open(directory)).inputs()).toEqual([existing]);
  });

  it('cancels later streams after an interrupted upload while preserving the original rejection', async () => {
    const { store, directory } = await setup();
    const failure = new Error('upload interrupted'); const cancellations: unknown[] = []; let laterPulls = 0;
    const broken = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(failure); } }, { highWaterMark: 0 });
    const later = (failCancellation: boolean) => new ReadableStream<Uint8Array>({
      pull() { laterPulls++; },
      async cancel(reason) {
        await Promise.resolve(); cancellations.push(reason);
        if (failCancellation) throw new Error('stream cleanup failed');
      },
    }, { highWaterMark: 0 });
    await expect(store.intake([
      { origin: { kind: 'none' }, mediaType: 'text/plain', body: streamText('complete first original') },
      { origin: { kind: 'none' }, mediaType: 'text/plain', body: broken },
      { origin: { kind: 'none' }, mediaType: 'text/plain', body: later(true) },
      { origin: { kind: 'none' }, mediaType: 'text/plain', body: later(false) },
    ])).rejects.toBe(failure);
    expect(cancellations).toEqual([failure, failure]); expect(laterPulls).toBe(0);
    expect(store.inputs()).toEqual([]); expect(await readdir(join(directory, '.work'))).toEqual([]);
    expect(await readdir(join(directory, 'blobs'))).toEqual([]);
  });

  it('cancels all provided streams when batch metadata is rejected before reading', async () => {
    const { store } = await setup(); const cancellations: unknown[] = []; let pulls = 0;
    const body = () => new ReadableStream<Uint8Array>({
      pull() { pulls++; }, cancel(reason) { cancellations.push(reason); },
    }, { highWaterMark: 0 });
    await expect(store.intake([
      { origin: { kind: 'none' }, mediaType: 'image/png', body: body() },
      { origin: { kind: 'file', relativePath: '../invalid.png' }, mediaType: 'image/png', body: body() },
      { origin: { kind: 'none' }, mediaType: 'image/png', body: body() },
    ])).rejects.toThrow('invalid original relative path');
    expect(cancellations).toHaveLength(3);
    expect(cancellations.every(reason => reason === cancellations[0])).toBe(true);
    expect(pulls).toBe(0); expect(store.inputs()).toEqual([]);
  });

  it('selects only processors whose accepted media types cover every original', async () => {
    const { store } = await setup();
    await store.install({ id: 'gallery', version: '1', accepts: ['image/*'] });
    await store.install({ id: 'jpeg-only', version: '1', accepts: ['image/jpeg'] });
    await store.install({ id: 'mixed', version: '1', accepts: ['image/*', 'text/plain'] });
    const images = await store.intake([
      { origin: { kind: 'none' }, mediaType: 'image/jpeg', body: streamText('jpeg') }, { origin: { kind: 'none' }, mediaType: 'image/png', body: streamText('png') },
    ]);
    expect(store.candidates(images.inputId).map(processor => processor.id)).toEqual(['gallery', 'mixed']);
    const mixed = await store.intake([
      { origin: { kind: 'none' }, mediaType: 'image/jpeg', body: streamText('jpeg') }, { origin: { kind: 'none' }, mediaType: 'text/plain', body: streamText('readme') },
    ]);
    expect(store.candidates(mixed.inputId).map(processor => processor.id)).toEqual(['mixed']);
    await expect(store.begin(mixed.inputId, 'gallery')).rejects.toThrow('does not accept input');
    const run = await store.begin(mixed.inputId); await store.fail(run.id, 'test cleanup');
  });

  it('rejects empty batches and invalid original metadata before storing bytes', async () => {
    const { store, directory } = await setup();
    await expect(store.intake([])).rejects.toThrow('at least one original');
    for (const mediaType of ['', 'image', 'image/*', 'text/plain\r\nInjected: yes']) {
      await expect(store.intake([{ origin: { kind: 'none' }, mediaType, body: streamText('bad') }])).rejects.toThrow('media type');
    }
    for (const relativePath of ['', '/absolute.png', '../outside.png', 'folder/../outside.png', './file.png', 'folder//file.png', 'folder/', 'folder\\file.png', 'C:/file.png', 'bad\u0000.png']) {
      await expect(store.intake([{ origin: { kind: 'file', relativePath }, mediaType: 'image/png', body: streamText('bad') }])).rejects.toThrow('relative path');
    }
    for (const url of ['', 'bad\u0000url']) {
      await expect(store.intake([{ origin: { kind: 'url', url }, mediaType: 'text/html', body: streamText('bad') }])).rejects.toThrow('source URL');
    }
    for (const origin of [undefined, null, 'none', [], {}, { kind: 'unknown' }]) {
      await expect(store.intake([{ origin, mediaType: 'text/plain', body: streamText('bad') }] as unknown as OriginalUpload[])).rejects.toThrow('invalid original origin');
    }
    for (const origin of [{ kind: 'file' }, { kind: 'file', relativePath: null }, { kind: 'file', relativePath: 1 }]) {
      await expect(store.intake([{ origin, mediaType: 'image/png', body: streamText('bad') }] as unknown as OriginalUpload[])).rejects.toThrow('relative path');
    }
    for (const origin of [{ kind: 'url' }, { kind: 'url', url: null }, { kind: 'url', url: 1 }]) {
      await expect(store.intake([{ origin, mediaType: 'text/html', body: streamText('bad') }] as unknown as OriginalUpload[])).rejects.toThrow('source URL');
    }
    expect(store.inputs()).toEqual([]); expect(store.items()).toEqual([]); expect(await readdir(join(directory, '.work'))).toEqual([]); expect(await readdir(join(directory, 'blobs'))).toEqual([]);
    const saved = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8'));
    expect(saved.inputs).toEqual({}); expect(saved.artifacts).toEqual({});
  });
});
