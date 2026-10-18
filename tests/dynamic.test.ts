import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from '../src/store';
import { createRunner } from '../src/runner';
import { videoRegistration } from '../plugins/video';
import { parquetRegistration } from '../plugins/parquet';

it('runs both real processors once inside Dynamic Workers through streamed scoped capabilities', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dynamic-core-'));
  const store = await FileStore.open(directory); await store.install(videoRegistration); await store.install(parquetRegistration);
  const runner = await createRunner(store);
  try {
    const video = await store.intake({ kind: 'upload', filename: 'video.webm' }, 'video/webm', new Blob([await readFile(new URL('../fixtures/video.webm', import.meta.url))]).stream());
    const table = await store.intake({ kind: 'upload', filename: 'tiny.parquet' }, 'application/vnd.apache.parquet', new Blob([await readFile(new URL('../fixtures/tiny.parquet', import.meta.url))]).stream());
    const videoView = await runner.process(video.itemId, videoRegistration.id as 'video-viewer');
    const tableView = await runner.process(table.itemId, parquetRegistration.id as 'parquet-summary');
    const metadata = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8'));
    const videoProcessor = metadata.publications[video.itemId].processor; const tableProcessor = metadata.publications[table.itemId].processor;
    expect(videoProcessor.codeSha256).toMatch(/^[0-9a-f]{64}$/); expect(tableProcessor.codeSha256).not.toBe(videoProcessor.codeSha256);
    expect(videoView.publication.search).toHaveLength(2); expect(videoView.publication.search.every(entry => entry.artifact === video.originals[0].id)).toBe(true);
    expect(videoView.publication.presentation.component).toBeTruthy();
    expect(await new Response(store.visibleArtifact(table.itemId, tableView.publication.presentation.fallback).body).text()).toBe('Harbor: 12\nForest: 34');
    expect(store.search('SECRET')).toHaveLength(0);
    const reloaded = await FileStore.open(directory); expect(reloaded.context(video.itemId)).toEqual(videoView); expect(reloaded.context(table.itemId)).toEqual(tableView);
    await expect(runner.process(video.itemId, 'video-viewer')).rejects.toThrow('already published');
    const reads = store.audit.reads.filter(read => read.itemId === table.itemId); expect(reads.every(read => !!read.range)).toBe(true); expect(reads.length).toBeGreaterThan(1);
    const layout = JSON.parse(await readFile(new URL('../fixtures/tiny-layout.json', import.meta.url), 'utf8'));
    expect(reads.some(read => read.range!.start === 0 && read.range!.end === table.originals[0].size)).toBe(false);
    expect(reads.some(read => read.range!.start < layout.columns.secret.end && read.range!.end > layout.columns.secret.start)).toBe(false);
    await mkdir(new URL('../evidence/', import.meta.url), { recursive: true });
    await writeFile(new URL('../evidence/semantic-observed.json', import.meta.url), JSON.stringify({ observedAt: new Date().toISOString(), backend: 'Miniflare 5 / workerd Dynamic Workers', flow: 'intake → process once → publish → view', video: { publication: videoView.publication, processor: videoProcessor }, parquet: { publication: tableView.publication, processor: tableProcessor, ranges: reads.map(read => read.range), excludedSecretSearchHits: store.search('SECRET').length, secretPage: layout.columns.secret, secretPageRead: false }, restartRetainedPublications: true, replacementProcessingDenied: true }, null, 2) + '\n');
  } finally { await runner.dispose(); await rm(directory, { recursive: true, force: true }); }
});
