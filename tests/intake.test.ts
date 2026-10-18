import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rename, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, streamText } from '../src/store';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'batch-intake-')); directories.push(directory);
  return { directory, store: await FileStore.open(directory) };
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

describe('completed ingestion becomes one processor input', () => {
  it('keeps ordered per-file provenance and host-issued identities for a folder of originals', async () => {
    const { store, directory } = await setup();
    // Byte contents are synthetic; this test exercises ingestion, not image decoding.
    const uploads = [
      { mediaType: 'image/jpeg', filename: 'beach.jpg', relativePath: 'holiday/day-1/beach.jpg', body: streamText('first image'), id: 'caller-selected', size: 0, sha256: 'caller-hash' },
      { mediaType: 'image/png', filename: 'map.png', relativePath: 'holiday/map.png', body: streamText('second image') },
    ];
    const item = await store.intake({ kind: 'upload' }, uploads);
    expect(store.items()).toEqual([item]); expect(item.source).toEqual({ kind: 'upload' });
    expect(item.itemId).toMatch(/^item_/); expect(new Set(item.originals.map(original => original.id)).size).toBe(2);
    expect(item.originals.map(original => [original.filename, original.relativePath])).toEqual([
      ['beach.jpg', 'holiday/day-1/beach.jpg'], ['map.png', 'holiday/map.png'],
    ]);
    for (const [index, text] of ['first image', 'second image'].entries()) {
      const original = item.originals[index];
      expect(original).toMatchObject({ itemId: item.itemId, role: 'original', size: Buffer.byteLength(text), sha256: digest(text) });
      expect(original.id).toMatch(/^artifact_/); expect(original.id).not.toBe('caller-selected');
      expect(await new Response(store.visibleArtifact(item.itemId, original.id).body).text()).toBe(text);
    }
    await store.install({ id: 'gallery', version: '1', accepts: ['image/*'], grants: [] });
    const run = await store.begin(item.itemId); expect(store.input(run.id)).toEqual(item);
    for (const original of item.originals) expect(await new Response(await store.host(run.id).read(original.id)).text()).toContain('image');
    await store.fail(run.id, 'test cleanup');
    expect((await FileStore.open(directory)).items()).toEqual([item]);
    expect(await readdir(join(directory, '.work'))).toEqual([]);
  });

  it('exposes no partial item while a later original is still streaming', async () => {
    const { store, directory } = await setup();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const reading = new Promise<void>(resolve => { entered = resolve; });
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) { entered(); controller.enqueue(new TextEncoder().encode('second')); await gate; controller.close(); },
    }, { highWaterMark: 0 });
    const intake = store.intake({ kind: 'upload' }, [
      { mediaType: 'image/jpeg', body: streamText('first') }, { mediaType: 'image/png', body },
    ]);
    await reading;
    try {
      expect(store.items()).toEqual([]); expect(await readdir(join(directory, 'blobs'))).toEqual([]);
      expect(await readdir(join(directory, '.work'))).toHaveLength(2);
      // Uploading does not reserve the metadata queue or publish a draft input.
      await store.install({ id: 'gallery', version: '1', accepts: ['image/*'], grants: [] });
      const saved = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8'));
      expect(saved.items).toEqual({}); expect(saved.artifacts).toEqual({});
    } finally { release(); }
    const item = await intake;
    expect(store.items()).toEqual([item]); expect(item.originals).toHaveLength(2);
    expect(await readdir(join(directory, '.work'))).toEqual([]);
  });

  it('cleans an interrupted batch without removing an existing shared blob', async () => {
    const { store, directory } = await setup();
    const existing = await store.intake({ kind: 'document' }, [{ mediaType: 'text/plain', body: streamText('shared') }]);
    let pulls = 0;
    const broken = new ReadableStream<Uint8Array>({ pull(controller) {
      if (pulls++ === 0) controller.enqueue(new TextEncoder().encode('partial'));
      else controller.error(new Error('upload interrupted'));
    } }, { highWaterMark: 0 });
    await expect(store.intake({ kind: 'upload' }, [
      { mediaType: 'text/plain', body: streamText('shared') },
      { mediaType: 'text/plain', body: streamText('unique but incomplete batch') },
      { mediaType: 'text/plain', body: broken },
    ])).rejects.toThrow('upload interrupted');
    expect(store.items()).toEqual([existing]);
    expect(await readdir(join(directory, '.work'))).toEqual([]);
    expect(await readdir(join(directory, 'blobs'))).toEqual([digest('shared')]);
    expect((await FileStore.open(directory)).items()).toEqual([existing]);
  });

  it('rolls back newly promoted blobs if the batch metadata commit fails', async () => {
    const { store, directory } = await setup();
    const existing = await store.intake({ kind: 'document' }, [{ mediaType: 'text/plain', body: streamText('shared') }]);
    await rename(join(directory, 'metadata.json'), join(directory, 'metadata.saved')); await mkdir(join(directory, 'metadata.json'));
    try {
      await expect(store.intake({ kind: 'upload' }, [
        { mediaType: 'text/plain', body: streamText('shared') },
        { mediaType: 'text/plain', body: streamText('new duplicate') },
        { mediaType: 'text/plain', body: streamText('new duplicate') },
        { mediaType: 'text/plain', body: streamText('another new blob') },
      ])).rejects.toThrow();
      expect(store.items()).toEqual([existing]);
      expect(await readdir(join(directory, '.work'))).toEqual([]);
      expect(await readdir(join(directory, 'blobs'))).toEqual([digest('shared')]);
      expect(await readFile(join(directory, 'blobs', digest('shared')), 'utf8')).toBe('shared');
      expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      await rm(join(directory, 'metadata.json'), { recursive: true }); await rename(join(directory, 'metadata.saved'), join(directory, 'metadata.json'));
    }
    expect((await FileStore.open(directory)).items()).toEqual([existing]);
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
    await expect(store.intake({ kind: 'upload' }, [
      { mediaType: 'text/plain', body: streamText('complete first original') },
      { mediaType: 'text/plain', body: broken },
      { mediaType: 'text/plain', body: later(true) },
      { mediaType: 'text/plain', body: later(false) },
    ])).rejects.toBe(failure);
    expect(cancellations).toEqual([failure, failure]); expect(laterPulls).toBe(0);
    expect(store.items()).toEqual([]); expect(await readdir(join(directory, '.work'))).toEqual([]);
    expect(await readdir(join(directory, 'blobs'))).toEqual([]);
  });

  it('cancels all provided streams when batch metadata is rejected before reading', async () => {
    const { store } = await setup(); const cancellations: unknown[] = []; let pulls = 0;
    const body = () => new ReadableStream<Uint8Array>({
      pull() { pulls++; }, cancel(reason) { cancellations.push(reason); },
    }, { highWaterMark: 0 });
    await expect(store.intake({ kind: 'upload' }, [
      { mediaType: 'image/png', body: body() },
      { mediaType: 'image/png', relativePath: '../invalid.png', body: body() },
      { mediaType: 'image/png', body: body() },
    ])).rejects.toThrow('invalid original relative path');
    expect(cancellations).toHaveLength(3);
    expect(cancellations.every(reason => reason === cancellations[0])).toBe(true);
    expect(pulls).toBe(0); expect(store.items()).toEqual([]);
  });

  it('selects only processors whose accepted media types cover every original', async () => {
    const { store } = await setup();
    await store.install({ id: 'gallery', version: '1', accepts: ['image/*'], grants: [] });
    await store.install({ id: 'jpeg-only', version: '1', accepts: ['image/jpeg'], grants: [] });
    await store.install({ id: 'mixed', version: '1', accepts: ['image/*', 'text/plain'], grants: [] });
    const images = await store.intake({ kind: 'upload' }, [
      { mediaType: 'image/jpeg', body: streamText('jpeg') }, { mediaType: 'image/png', body: streamText('png') },
    ]);
    expect(store.candidates(images.itemId).map(processor => processor.id)).toEqual(['gallery', 'mixed']);
    const mixed = await store.intake({ kind: 'upload' }, [
      { mediaType: 'image/jpeg', body: streamText('jpeg') }, { mediaType: 'text/plain', body: streamText('readme') },
    ]);
    expect(store.candidates(mixed.itemId).map(processor => processor.id)).toEqual(['mixed']);
    await expect(store.begin(mixed.itemId, 'gallery')).rejects.toThrow('does not accept input');
    const run = await store.begin(mixed.itemId); await store.fail(run.id, 'test cleanup');
  });

  it('rejects empty batches and invalid original metadata before storing bytes', async () => {
    const { store, directory } = await setup();
    await expect(store.intake({ kind: 'upload' }, [])).rejects.toThrow('at least one original');
    for (const mediaType of ['', 'image', 'image/*', 'text/plain\r\nInjected: yes']) {
      await expect(store.intake({ kind: 'upload' }, [{ mediaType, body: streamText('bad') }])).rejects.toThrow('media type');
    }
    for (const filename of ['', '.', '..', 'nested/file.png', 'folder\\file.png', 'bad\u0000.png']) {
      await expect(store.intake({ kind: 'upload' }, [{ mediaType: 'image/png', filename, body: streamText('bad') }])).rejects.toThrow('filename');
    }
    for (const relativePath of ['', '/absolute.png', '../outside.png', 'folder/../outside.png', './file.png', 'folder//file.png', 'folder/', 'folder\\file.png', 'C:/file.png', 'bad\u0000.png']) {
      await expect(store.intake({ kind: 'upload' }, [{ mediaType: 'image/png', relativePath, body: streamText('bad') }])).rejects.toThrow('relative path');
    }
    expect(store.items()).toEqual([]); expect(await readdir(join(directory, '.work'))).toEqual([]); expect(await readdir(join(directory, 'blobs'))).toEqual([]);
    const saved = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8'));
    expect(saved.items).toEqual({}); expect(saved.artifacts).toEqual({});
  });
});
