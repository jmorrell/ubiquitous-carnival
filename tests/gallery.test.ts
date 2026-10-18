import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileStore, streamText } from '../src/store';
import { runInProcess } from '../src/runner';
import { galleryProcessor, galleryRegistration, type GalleryManifest } from '../plugins/gallery';
import { createVideoProcessor, videoRegistration } from '../plugins/video';
import { parquetProcessor, parquetRegistration } from '../plugins/parquet';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'folder-gallery-')); directories.push(directory);
  const store = await FileStore.open(directory); await store.install(galleryRegistration);
  return { store, directory };
}

it('passes a folder as one item to a gallery processor and preserves each original path', async () => {
  const { store, directory } = await setup();
  const paths = ['blue.svg', 'day-2/green.svg'];
  const originals = await Promise.all(paths.map(async path => ({
    filename: path.split('/').at(-1), relativePath: `photos/${path}`, mediaType: 'image/svg+xml',
    body: new Blob([await readFile(new URL('../fixtures/gallery/' + path, import.meta.url))]).stream(),
  })));
  const item = await store.intake({ kind: 'upload' }, originals);
  expect(store.items()).toHaveLength(1); expect(item.originals).toHaveLength(2);
  const run = await store.begin(item.itemId, galleryRegistration.id);
  const input = store.input(run.id); const host = store.host(run.id);
  const contents = await Promise.all(input.originals.map(async original => new Response(await host.read(original.id)).text()));
  expect(contents[0]).toContain('#2463eb'); expect(contents[1]).toContain('#12966a');
  const result = await store.publish(run.id, await galleryProcessor.process(input, host));
  const manifest: GalleryManifest = await new Response(store.visibleArtifact(item.itemId, result.publication.artifacts[0]).body).json();
  expect(manifest.images.map(image => [image.artifact, image.filename, image.relativePath])).toEqual(item.originals.map(original => [original.id, original.filename, original.relativePath]));
  expect(await new Response(store.visibleArtifact(item.itemId, result.publication.presentation.fallback).body).text()).toBe('photos/blue.svg\nphotos/day-2/green.svg');
  expect(store.search('day-2/green')).toEqual([{ itemId: item.itemId, text: 'photos/day-2/green.svg', artifact: item.originals[1].id }]);
  expect((await FileStore.open(directory)).context(item.itemId)).toEqual(result);
});

it('single-file examples reject a collection instead of silently ignoring its other members', async () => {
  const { store } = await setup();
  for (const [registration, processor, mediaType] of [
    [videoRegistration, createVideoProcessor('<p>viewer</p>'), 'video/webm'],
    [parquetRegistration, parquetProcessor, 'application/vnd.apache.parquet'],
  ] as const) {
    await store.install(registration);
    const item = await store.intake({ kind: 'upload' }, [
      { mediaType, body: streamText('first') }, { mediaType, body: streamText('second') },
    ]);
    await expect(runInProcess(store, item.itemId, registration.id, processor)).rejects.toThrow('requires exactly one supported original');
    expect(store.isPublished(item.itemId)).toBe(false);
  }
});
