import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from '../src/store';
import { createRunner } from '../src/runner';
import { videoRegistration } from '../plugins/video';
import { parquetRegistration } from '../plugins/parquet';
import { galleryRegistration, type GalleryManifest } from '../plugins/gallery';
import { photoItemsRegistration } from '../plugins/photo-items';

it('runs single- and multiple-publication processors through actual Dynamic Workers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dynamic-core-'));
  const store = await FileStore.open(directory);
  for (const registration of [videoRegistration, parquetRegistration, galleryRegistration, photoItemsRegistration]) await store.install(registration);
  const runner = await createRunner(store);
  try {
    const video = await store.intake([{ filename: 'video.webm', mediaType: 'video/webm', body: new Blob([await readFile(new URL('../fixtures/video.webm', import.meta.url))]).stream() }]);
    const table = await store.intake([{ filename: 'tiny.parquet', mediaType: 'application/vnd.apache.parquet', body: new Blob([await readFile(new URL('../fixtures/tiny.parquet', import.meta.url))]).stream() }]);
    const imageUploads = () => Promise.all(['blue.svg', 'day-2/green.svg'].map(async path => ({
      filename: path.split('/').at(-1), relativePath: 'photos/' + path, mediaType: 'image/svg+xml',
      body: new Blob([await readFile(new URL('../fixtures/gallery/' + path, import.meta.url))]).stream(),
    })));
    const galleryInput = await store.intake(await imageUploads()); const photoInput = await store.intake(await imageUploads());
    const galleryResults = await runner.process(galleryInput.inputId, 'image-gallery');
    expect(galleryResults).toHaveLength(1); const galleryView = galleryResults[0];
    const gallery: GalleryManifest = await new Response(store.visibleArtifact(galleryView.item.itemId, galleryView.publication.artifacts[0]).body).json();
    expect(gallery.images.map(image => image.relativePath)).toEqual(['photos/blue.svg', 'photos/day-2/green.svg']);
    expect(gallery.images.map(image => image.artifact)).toEqual(galleryInput.originals.map(original => original.id));
    const photos = await runner.process(photoInput.inputId, 'photo-items');
    expect(photos).toHaveLength(2);
    expect(photos.map(view => view.item.artifacts.filter(artifact => artifact.role === 'original').map(artifact => artifact.id))).toEqual(photoInput.originals.map(original => [original.id]));
    expect(() => store.visibleArtifact(photos[0].item.itemId, photoInput.originals[1].id)).toThrow();
    const shared = photos[0].item.artifacts.find(artifact => artifact.role === 'photo-index')!;
    expect(photos[1].publication.artifacts).toContain(shared.id);
    expect(await new Response(store.visibleArtifact(photos[1].item.itemId, shared.id).body).json()).toEqual({ title: 'Imported images', count: 2 });
    expect(store.search('day-2/green').map(hit => hit.itemId).sort()).toEqual([galleryView.item.itemId, photos[1].item.itemId].sort());
    const [videoView] = await runner.process(video.inputId, 'video-viewer');
    const [tableView] = await runner.process(table.inputId, 'parquet-summary');
    const metadata = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8'));
    const videoProcessor = metadata.publications[videoView.item.itemId].processor; const tableProcessor = metadata.publications[tableView.item.itemId].processor;
    expect(videoProcessor.codeSha256).toMatch(/^[0-9a-f]{64}$/); expect(tableProcessor.codeSha256).not.toBe(videoProcessor.codeSha256);
    expect(videoView.publication.search).toHaveLength(2); expect(videoView.publication.search.every(entry => entry.artifact === video.originals[0].id)).toBe(true);
    expect(videoView.publication.presentation.component).toBeTruthy();
    expect(await new Response(store.visibleArtifact(tableView.item.itemId, tableView.publication.presentation.fallback).body).text()).toBe('Harbor: 12\nForest: 34');
    expect(() => store.visibleArtifact(tableView.item.itemId, table.originals[0].id)).toThrow();
    expect(store.search('SECRET')).toHaveLength(0);
    const reloaded = await FileStore.open(directory);
    for (const [input, results] of [[video, [videoView]], [table, [tableView]], [galleryInput, galleryResults], [photoInput, photos]] as const) expect(reloaded.results(input.inputId)).toEqual(results);
    await expect(runner.process(video.inputId, 'video-viewer')).rejects.toThrow('already processed');
    const reads = store.audit.reads.filter(read => read.inputId === table.inputId); expect(reads.every(read => !!read.range)).toBe(true); expect(reads.length).toBeGreaterThan(1);
    const layout = JSON.parse(await readFile(new URL('../fixtures/tiny-layout.json', import.meta.url), 'utf8'));
    expect(reads.some(read => read.range!.start === 0 && read.range!.end === table.originals[0].size)).toBe(false);
    expect(reads.some(read => read.range!.start < layout.columns.secret.end && read.range!.end > layout.columns.secret.start)).toBe(false);
    await mkdir(new URL('../evidence/', import.meta.url), { recursive: true });
    await writeFile(new URL('../evidence/semantic-observed.json', import.meta.url), JSON.stringify({
      observedAt: new Date().toISOString(), backend: 'Miniflare 5 / workerd Dynamic Workers',
      flow: 'completed Input → process once → one or more manifests → atomic published items → scoped views',
      gallery: { input: galleryInput, results: galleryResults, manifest: gallery, processor: metadata.publications[galleryView.item.itemId].processor },
      photos: { input: photoInput, results: photos, sharedArtifact: shared.id, siblingArtifactReadDenied: true, processor: metadata.publications[photos[0].item.itemId].processor },
      video: { result: videoView, processor: videoProcessor },
      parquet: { result: tableView, processor: tableProcessor, ranges: reads.map(read => read.range), excludedSecretSearchHits: store.search('SECRET').length, secretPage: layout.columns.secret, secretPageRead: false, originalNotGrantedToViewer: true },
      restartRetainedInputResults: true, replacementProcessingDenied: true,
    }, null, 2) + '\n');
  } finally { await runner.dispose(); await rm(directory, { recursive: true, force: true }); }
});
