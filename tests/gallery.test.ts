import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileStore, streamText } from '../src/store';
import { runInProcess } from '../src/runner';
import { galleryProcessor, galleryRegistration, type GalleryManifest } from '../plugins/gallery';
import { photoItemsProcessor, photoItemsRegistration } from '../plugins/photo-items';
import { createVideoProcessor, videoRegistration } from '../plugins/video';
import { parquetProcessor, parquetRegistration } from '../plugins/parquet';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'folder-gallery-')); directories.push(directory);
  const store = await FileStore.open(directory); await store.install(galleryRegistration); await store.install(photoItemsRegistration);
  return { store, directory };
}
async function images() {
  return Promise.all(['blue.svg', 'day-2/green.svg'].map(async path => ({
    origin: { kind: 'file' as const, relativePath: `photos/${path}` }, mediaType: 'image/svg+xml',
    body: new Blob([await readFile(new URL('../fixtures/gallery/' + path, import.meta.url))]).stream(),
  })));
}

it('turns an image input into one gallery with explicit original references', async () => {
  const { store, directory } = await setup();
  const input = await store.intake(await images());
  expect(store.items()).toEqual([]); expect(input.originals).toHaveLength(2);
  const run = await store.begin(input.inputId, galleryRegistration.id); const host = store.host(run.id);
  const contents = await Promise.all(input.originals.map(async original => new Response(await host.read(original.id)).text()));
  expect(contents[0]).toContain('#2463eb'); expect(contents[1]).toContain('#12966a');
  const results = await store.publish(run.id, await galleryProcessor.process(store.input(run.id), host));
  expect(results).toHaveLength(1); const result = results[0]; const itemId = result.item.itemId;
  const manifest: GalleryManifest = await new Response(store.visibleArtifact(itemId, result.publication.artifacts[0]).body).json();
  expect(manifest.images).toEqual(input.originals.map((original, index) => ({ artifact: original.id, caption: ['photos/blue.svg', 'photos/day-2/green.svg'][index] })));
  expect(input.originals.map(original => original.origin)).toEqual([
    { kind: 'file', relativePath: 'photos/blue.svg' }, { kind: 'file', relativePath: 'photos/day-2/green.svg' },
  ]);
  for (const artifact of result.item.artifacts.filter(artifact => artifact.role !== 'original')) expect(artifact.origin).toEqual({ kind: 'none' });
  expect(await new Response(store.visibleArtifact(itemId, result.publication.presentation.fallback).body).text()).toBe('photos/blue.svg\nphotos/day-2/green.svg');
  expect(store.search('day-2/green')).toEqual([{ itemId, text: 'photos/day-2/green.svg', artifact: input.originals[1].id }]);
  expect(result.item.artifacts.filter(artifact => artifact.role === 'original')).toEqual(input.originals);
  expect((await FileStore.open(directory)).results(input.inputId)).toEqual(results);
});

it('lets the selected processor turn equivalent image bytes into separate items', async () => {
  const { store, directory } = await setup();
  // Fresh inputs compare processors without reprocessing a completed input.
  const galleryInput = await store.intake(await images()); const photoInput = await store.intake(await images());
  expect(photoInput.originals.map(original => original.sha256)).toEqual(galleryInput.originals.map(original => original.sha256));
  const gallery = await runInProcess(store, galleryInput.inputId, galleryRegistration.id, galleryProcessor);
  const photos = await runInProcess(store, photoInput.inputId, photoItemsRegistration.id, photoItemsProcessor);
  expect(gallery).toHaveLength(1); expect(photos).toHaveLength(2);
  expect(new Set(photos.map(view => view.item.itemId)).size).toBe(2);
  for (const [index, view] of photos.entries()) {
    expect(view.item.artifacts.filter(artifact => artifact.role === 'original')).toEqual([photoInput.originals[index]]);
    expect(view.publication.search).toEqual([{ text: ['photos/blue.svg', 'photos/day-2/green.svg'][index], artifact: photoInput.originals[index].id }]);
  }
  const shared = photos[0].item.artifacts.find(artifact => artifact.role === 'photo-index')!;
  expect(photos[1].publication.artifacts).toContain(shared.id);
  expect(await new Response(store.visibleArtifact(photos[1].item.itemId, shared.id).body).json()).toEqual({ title: 'Imported images', count: 2 });
  expect((await FileStore.open(directory)).results(photoInput.inputId)).toEqual(photos);
});

it('single-file examples reject a collection instead of silently ignoring its other members', async () => {
  const { store } = await setup();
  for (const [registration, processor, mediaType] of [
    [videoRegistration, createVideoProcessor('<p>viewer</p>'), 'video/webm'],
    [parquetRegistration, parquetProcessor, 'application/vnd.apache.parquet'],
  ] as const) {
    await store.install(registration);
    const input = await store.intake([
      { origin: { kind: 'none' }, mediaType, body: streamText('first') }, { origin: { kind: 'none' }, mediaType, body: streamText('second') },
    ]);
    await expect(runInProcess(store, input.inputId, registration.id, processor)).rejects.toThrow('requires exactly one supported original');
    expect(store.isProcessed(input.inputId)).toBe(false); expect(store.results(input.inputId)).toEqual([]);
  }
});
