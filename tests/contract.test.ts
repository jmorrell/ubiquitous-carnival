import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, rename, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, streamText, syntheticTranscriber } from '../src/store';
import { runInProcess } from '../src/runner';
import { createVideoProcessor, videoRegistration } from '../plugins/video';
import { parquetProcessor, parquetRegistration } from '../plugins/parquet';
import type { Publication } from '../src/contract';
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function setup(transcriber = syntheticTranscriber) {
  const directory = await mkdtemp(join(tmpdir(), 'extension-contract-')); directories.push(directory);
  const store = await FileStore.open(directory, transcriber); await store.install(videoRegistration); await store.install(parquetRegistration);
  const item = await store.intake({ kind: 'upload', filename: 'video.webm' }, 'video/webm', new Blob([await readFile(new URL('../fixtures/video.webm', import.meta.url))]).stream());
  return { store, item, directory };
}
const processor = createVideoProcessor('<p>arbitrary plugin component</p>');
async function staged(store: FileStore, itemId: string) { const run = await store.begin(itemId, videoRegistration.id); const publication = await processor.process(store.input(run.id), store.host(run.id)); return { run, publication }; }

describe('durable publication and scoped capabilities', () => {
  it('keeps failed staging invisible, retries completed service effect without repeating it, and reloads', async () => {
    let effects = 0; const { store, item, directory } = await setup(async (...args) => { effects++; return syntheticTranscriber(...args); });
    const first = await staged(store, item.itemId);
    expect(() => store.context(item.itemId)).toThrow('not published');
    expect(() => store.visibleArtifact(item.itemId, first.publication.artifacts[0])).toThrow('not published');
    await store.fail(first.run.id, 'injected crash just before publication');
    const published = await runInProcess(store, item.itemId, videoRegistration.id, processor);
    expect(effects).toBe(1); expect(published.generation.state).toBe('published');
    expect(store.search('blue')[0].target.selector.kind).toBe('time');
    expect(published.generation.publication!.artifacts).not.toContain(first.publication.artifacts[0]);
    const reloaded = await FileStore.open(directory);
    expect(reloaded.context(item.itemId).generation.id).toBe(published.generation.id);
    expect(await new Response(reloaded.visibleArtifact(item.itemId, published.generation.publication!.presentation.fallback).body).text()).toContain('A blue square');
  });
  it('persists ambiguous effects and fences retry after restart instead of claiming exactly once', async () => {
    let calls = 0; const { store, item, directory } = await setup(async () => { calls++; throw new Error('provider accepted effect; response lost'); });
    await expect(runInProcess(store, item.itemId, videoRegistration.id, processor)).rejects.toThrow('response lost');
    const restarted = await FileStore.open(directory, async (...args) => { calls++; return syntheticTranscriber(...args); });
    await expect(runInProcess(restarted, item.itemId, videoRegistration.id, processor)).rejects.toThrow('outcome uncertain');
    expect(calls).toBe(1); expect(() => restarted.context(item.itemId)).toThrow('not published');
  });
  it('rejects actual foreign reads/artifacts/targets, invalid quotes and unresolved search before publishing', async () => {
    const { store, item } = await setup(); const foreign = await store.intake({ kind: 'document', author: 'user' }, 'text/plain', streamText('foreign confidential content'));
    const { run, publication } = await staged(store, item.itemId);
    await expect(store.host(run.id).read(foreign.originals[0].id)).rejects.toThrow('outside capability');
    expect(() => store.visibleArtifact(item.itemId, foreign.originals[0].id)).toThrow('foreign artifact');
    await expect(store.publish(run.id, { ...publication, artifacts: [...publication.artifacts, foreign.originals[0].id] })).rejects.toThrow('outside capability');
    await expect(store.publish(run.id, { ...publication, targets: [{ key: 'foreign', artifact: foreign.originals[0].id, selector: { kind: 'whole' } }] })).rejects.toThrow('not published');
    const corrupted = structuredClone(publication); (corrupted.targets[1].selector as { quote: string }).quote = 'invented';
    await expect(store.publish(run.id, corrupted)).rejects.toThrow('quote mismatch');
    await expect(store.publish(run.id, { ...publication, search: [{ text: 'secret', target: 'missing' }] })).rejects.toThrow('search target');
    expect(() => store.context(item.itemId)).toThrow('not published');
    await store.publish(run.id, publication);
    await expect(store.annotate(item.itemId, 'invented-target', 'note')).rejects.toThrow('not published');
  });
  it('requires explicit handler choice and fences older generations and removed capability objects', async () => {
    const { store, item } = await setup(); await store.install({ ...videoRegistration, id: 'other-video' });
    await expect(store.begin(item.itemId)).rejects.toThrow('explicit handler choice');
    const first = await staged(store, item.itemId); const oldHost = store.host(first.run.id);
    const second = await store.begin(item.itemId, videoRegistration.id);
    await expect(oldHost.read(item.originals[0].id)).rejects.toThrow('not live');
    await expect(store.publish(first.run.id, first.publication)).rejects.toThrow('not live');
    const host = store.host(second.id); await store.remove(videoRegistration.id);
    await expect(host.write({ role: 'late', mediaType: 'text/plain' }, streamText('late'))).rejects.toThrow('revoked');
    await expect(host.transcribe(item.originals[0].id, 'v1')).rejects.toThrow('revoked');
  });
  it('preserves old transcript notes as historical, stable original cues, and data after plugin removal', async () => {
    const { store, item, directory } = await setup(); const initial = await runInProcess(store, item.itemId, videoRegistration.id, processor);
    const oldText = initial.generation.targets!.find(t => t.key === 'text-0')!; const cue = initial.generation.targets!.find(t => t.key === 'cue-0')!;
    await store.annotate(item.itemId, oldText.id, 'review this exact old phrase'); await store.annotate(item.itemId, cue.id, 'review this moment');
    const next = await runInProcess(store, item.itemId, videoRegistration.id, createVideoProcessor('<p>new component</p>', 'v2'));
    expect(store.resolveTarget(item.itemId, oldText.id)).toEqual({ target: oldText, status: 'historical' });
    expect(store.targetStatus(item.itemId, cue.id)).toBe('current');
    expect(() => store.targetStatus(item.itemId, 'invented')).toThrow('not found');
    await store.remove(videoRegistration.id);
    const removed = store.context(item.itemId); expect(removed.generation.publication!.presentation.component).toBeUndefined();
    expect(removed.annotations).toHaveLength(2); expect(store.search('bright blue')).toHaveLength(1);
    expect(() => store.visibleArtifact(item.itemId, next.generation.publication!.presentation.component!)).toThrow('component removed');
    expect(await new Response(store.visibleArtifact(item.itemId, oldText.artifact).body).text()).toContain('A blue square');
    expect((await new Response(store.visibleArtifact(item.itemId, item.originals[0].id).body).arrayBuffer()).byteLength).toBe(item.originals[0].size);
    expect((await FileStore.open(directory)).context(item.itemId).annotations).toHaveLength(2);
  });
  it('never exposes a publication whose metadata rename fails', async () => {
    const { store, item, directory } = await setup(); const { run, publication } = await staged(store, item.itemId);
    await rename(join(directory, 'metadata.json'), join(directory, 'metadata.saved')); await mkdir(join(directory, 'metadata.json'));
    await expect(store.publish(run.id, publication)).rejects.toThrow();
    expect(() => store.context(item.itemId)).toThrow('not published');
    await rm(join(directory, 'metadata.json'), { recursive: true }); await rename(join(directory, 'metadata.saved'), join(directory, 'metadata.json'));
    await store.publish(run.id, publication); expect(store.context(item.itemId).generation.id).toBe(run.id);
  });
  it('rechecks revocation when a streamed write commits', async () => {
    const { store, item } = await setup(); const run = await store.begin(item.itemId); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const body = new ReadableStream<Uint8Array>({ async start(controller) { controller.enqueue(new TextEncoder().encode('first')); await gate; controller.close(); } });
    const writing = store.host(run.id).write({ role: 'late', mediaType: 'text/plain' }, body);
    await store.remove(videoRegistration.id); release(); await expect(writing).rejects.toThrow('revoked');
  });
});

describe('second scenario: actual Parquet without new host operations', () => {
  it('parses selected columns through range reads and excludes the raw secret column from search', async () => {
    const { store } = await setup();
    const bytes = await readFile(new URL('../fixtures/tiny.parquet', import.meta.url)); expect(bytes.subarray(0, 4).toString()).toBe('PAR1'); expect(bytes.toString()).toContain('SECRET-DO-NOT-INDEX');
    const item = await store.intake({ kind: 'upload', filename: 'tiny.parquet' }, 'application/vnd.apache.parquet', new Blob([bytes]).stream());
    const result = await runInProcess(store, item.itemId, parquetRegistration.id, parquetProcessor);
    const fallback = await new Response(store.visibleArtifact(item.itemId, result.generation.publication!.presentation.fallback).body).text();
    expect(fallback).toBe('Harbor: 12\nForest: 34'); expect(store.search('Harbor')).toHaveLength(1); expect(store.search('SECRET')).toHaveLength(0);
    const reads = store.audit.reads.filter(r => r.run === result.generation.id); expect(reads.length).toBeGreaterThan(1); expect(reads.every(r => !!r.range)).toBe(true);
    const layout = JSON.parse(await readFile(new URL('../fixtures/tiny-layout.json', import.meta.url), 'utf8'));
    expect(reads.some(r => r.range!.start === 0 && r.range!.end === bytes.length)).toBe(false);
    expect(reads.some(r => r.range!.start < layout.columns.secret.end && r.range!.end > layout.columns.secret.start)).toBe(false);
    const target = store.search('Forest')[0].target; expect(target.selector.kind).toBe('text');
    expect((await store.annotate(item.itemId, target.id, 'check this row')).target).toBe(target.id);
    expect(result.generation.publication!.presentation.component).toBeUndefined();
  });
});
