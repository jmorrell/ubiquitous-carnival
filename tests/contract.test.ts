import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { mkdtemp, readFile, readdir, rename, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, streamText, syntheticTranscriber, type Transcriber } from '../src/store';
import { runInProcess } from '../src/runner';
import { createVideoProcessor, videoRegistration } from '../plugins/video';
import { parquetProcessor, parquetRegistration } from '../plugins/parquet';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function setup(transcriber?: Transcriber) {
  const directory = await mkdtemp(join(tmpdir(), 'core-contract-')); directories.push(directory);
  const store = await FileStore.open(directory, transcriber); await store.install(videoRegistration); await store.install(parquetRegistration);
  const input = await store.intake([{ origin: { kind: 'file', relativePath: 'video.webm' }, mediaType: 'video/webm', body: new Blob([await readFile(new URL('../fixtures/video.webm', import.meta.url))]).stream() }]);
  return { store, input, directory };
}
const processor = createVideoProcessor('<p>arbitrary plugin component</p>');
async function processed(store: FileStore, inputId: string) {
  const run = await store.begin(inputId, videoRegistration.id);
  const [publication] = await processor.process(store.input(run.id), store.host(run.id)); return { run, publication };
}

describe('one processing call and validated publication results', () => {
  it('keeps incomplete output private, publishes once, and retains the result across restart', async () => {
    let calls = 0; const { store, input, directory } = await setup(async original => { calls++; return syntheticTranscriber(original); });
    const { run, publication } = await processed(store, input.inputId);
    expect(store.isProcessed(input.inputId)).toBe(false); expect(store.search('blue')).toEqual([]);
    expect(() => store.context(input.inputId)).toThrow('not published');
    expect(store.items()).toEqual([]); expect(store.results(input.inputId)).toEqual([]);
    expect(() => store.visibleArtifact(input.inputId, publication.artifacts[0])).toThrow('unknown item');
    const before = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8'));
    expect(Object.keys(before.artifacts)).toEqual([input.originals[0].id]); expect(before.publications).toEqual({});
    const [published] = await store.publish(run.id, [publication]);
    expect(calls).toBe(1); expect(published.publication).toEqual(publication); expect(store.isProcessed(input.inputId)).toBe(true);
    expect(published.item.artifacts.find(artifact => artifact.id === input.originals[0].id)?.origin).toEqual({ kind: 'file', relativePath: 'video.webm' });
    for (const artifact of published.item.artifacts.filter(artifact => artifact.role !== 'original')) expect(artifact.origin).toEqual({ kind: 'none' });
    expect(store.search('blue')[0].artifact).toBe(input.originals[0].id);
    await expect(store.host(run.id).read(input.originals[0].id)).rejects.toThrow('not live');
    expect(await readdir(join(directory, '.work'))).toEqual([]);
    const reloaded = await FileStore.open(directory);
    expect(reloaded.context(published.item.itemId)).toEqual(published);
    expect(await new Response(reloaded.visibleArtifact(published.item.itemId, publication.presentation.fallback).body).text()).toContain('A blue square');
    const saved = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8'));
    expect(Object.keys(saved).sort()).toEqual(['artifacts', 'inputs', 'items', 'plugins', 'processed', 'publications', 'schemaVersion']);
  });
  it('discards failed work and retains only the original, with no automatic retry', async () => {
    let calls = 0; const { store, input, directory } = await setup(async () => { calls++; throw new Error('synthetic service failure'); });
    await expect(runInProcess(store, input.inputId, videoRegistration.id, {
      async process(input, host) {
        await host.write({ role: 'temporary', mediaType: 'text/plain' }, streamText('incomplete'));
        await host.transcribe(input.originals[0].id); throw new Error('unreachable');
      },
    })).rejects.toThrow('synthetic service failure');
    expect(calls).toBe(1); expect(store.isProcessed(input.inputId)).toBe(false); expect(store.search('incomplete')).toEqual([]);
    expect(await readdir(join(directory, '.work'))).toEqual([]);
    expect(await readdir(join(directory, 'blobs'))).toEqual([input.originals[0].sha256]);
    const reloaded = await FileStore.open(directory); expect(reloaded.inputs()).toEqual([input]); expect(reloaded.items()).toEqual([]); expect(reloaded.isProcessed(input.inputId)).toBe(false);
    // Failure leaves no saved execution to resume; a later explicit call starts from the original.
    const fresh = await reloaded.begin(input.inputId); await reloaded.fail(fresh.id, 'test cleanup');
  });
  it('rejects foreign reads, invalid ranges, and unpublished search/presentation references', async () => {
    const { store, input, directory } = await setup();
    const foreign = await store.intake([{ origin: { kind: 'none' }, mediaType: 'text/plain', body: streamText('foreign confidential content') }]);
    const { run, publication } = await processed(store, input.inputId); const host = store.host(run.id);
    await expect(host.read(foreign.originals[0].id)).rejects.toThrow('outside capability');
    for (const range of [{ start: -1, end: 2 }, { start: 2, end: 1 }, { start: 0, end: input.originals[0].size + 1 }, { start: 0.5, end: 1 }]) {
      await expect(host.read(input.originals[0].id, range)).rejects.toThrow('invalid range');
    }
    expect((await new Response(await host.read(input.originals[0].id, { start: 0, end: 4 })).arrayBuffer()).byteLength).toBe(4);
    await expect(store.publish(run.id, [{ ...publication, artifacts: [...publication.artifacts, foreign.originals[0].id] }])).rejects.toThrow('outside capability');
    await expect(store.publish(run.id, [{ ...publication, artifacts: publication.artifacts.filter(id => id !== input.originals[0].id) }])).rejects.toThrow('search artifact');
    await expect(store.publish(run.id, [{ ...publication, search: [{ text: 'secret', artifact: foreign.originals[0].id }] }])).rejects.toThrow('search artifact');
    const omitted = await host.write({ role: 'discarded', mediaType: 'text/plain' }, streamText('not in the returned manifest'));
    await expect(store.publish(run.id, [{ ...publication, search: [{ text: 'discarded', artifact: omitted.id }] }])).rejects.toThrow('search artifact');
    await expect(store.publish(run.id, [{ ...publication, presentation: { fallback: omitted.id } }])).rejects.toThrow('fallback');
    expect(store.isProcessed(input.inputId)).toBe(false); const [published] = await store.publish(run.id, [publication]);
    expect(() => store.visibleArtifact(published.item.itemId, foreign.originals[0].id)).toThrow('not published');
    expect(() => store.visibleArtifact(published.item.itemId, omitted.id)).toThrow('not published');
    expect(await readdir(join(directory, 'blobs'))).not.toContain(omitted.sha256);
    expect(await readdir(join(directory, '.work'))).toEqual([]);
  });
  it('requires explicit ambiguous selection and denies concurrent or replacement processing', async () => {
    const { store, input, directory } = await setup(); await store.install({ ...videoRegistration, id: 'other-video' });
    await expect(store.begin(input.inputId)).rejects.toThrow('explicit handler choice');
    const results = await Promise.allSettled([store.begin(input.inputId, videoRegistration.id), store.begin(input.inputId, videoRegistration.id)]);
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const fulfilled = results.find(result => result.status === 'fulfilled')! as PromiseFulfilledResult<{ id: string; inputId: string }>;
    const rejected = results.find(result => result.status === 'rejected')! as PromiseRejectedResult;
    expect(String(rejected.reason)).toContain('already processing');
    const run = fulfilled.value; await store.publish(run.id, await processor.process(store.input(run.id), store.host(run.id)));
    await expect(store.begin(input.inputId, videoRegistration.id)).rejects.toThrow('already processed');
    await expect((await FileStore.open(directory)).begin(input.inputId, videoRegistration.id)).rejects.toThrow('already processed');
  });
  it('revokes future processing and component access while retaining published data and search', async () => {
    const { store, input, directory } = await setup(); const [published] = await runInProcess(store, input.inputId, videoRegistration.id, processor);
    const other = await store.intake([{ origin: { kind: 'file', relativePath: 'other.webm' }, mediaType: 'video/webm', body: streamText('synthetic second original') }]);
    const run = await store.begin(other.inputId); const host = store.host(run.id);
    await store.remove(videoRegistration.id);
    await expect(host.read(other.originals[0].id)).rejects.toThrow('revoked');
    await expect(host.write({ role: 'late', mediaType: 'text/plain' }, streamText('late'))).rejects.toThrow('revoked');
    await expect(host.transcribe(other.originals[0].id)).rejects.toThrow('revoked');
    await store.fail(run.id, 'removed');
    expect(store.context(published.item.itemId).publication.presentation.component).toBeUndefined();
    expect(() => store.visibleArtifact(published.item.itemId, published.publication.presentation.component!)).toThrow('component removed');
    expect(store.search('blue')).toHaveLength(1);
    expect(await new Response(store.visibleArtifact(published.item.itemId, published.publication.presentation.fallback).body).text()).toContain('A blue square');
    expect((await new Response(store.visibleArtifact(published.item.itemId, input.originals[0].id).body).arrayBuffer()).byteLength).toBe(input.originals[0].size);
    expect((await FileStore.open(directory)).context(published.item.itemId).publication.presentation.component).toBeUndefined();
  });
  it('never exposes a publication whose metadata commit fails and cleans failed output', async () => {
    const { store, input, directory } = await setup(); const { run, publication } = await processed(store, input.inputId);
    await rename(join(directory, 'metadata.json'), join(directory, 'metadata.saved')); await mkdir(join(directory, 'metadata.json'));
    await expect(store.publish(run.id, [publication])).rejects.toThrow();
    expect(store.isProcessed(input.inputId)).toBe(false); expect(() => store.context(input.inputId)).toThrow('not published');
    expect(store.results(input.inputId)).toEqual([]); expect(store.items()).toEqual([]);
    expect(() => store.visibleArtifact(input.inputId, publication.presentation.fallback)).toThrow('unknown item');
    await store.fail(run.id, 'metadata failure');
    expect(await readdir(join(directory, '.work'))).toEqual([]); expect(await readdir(join(directory, 'blobs'))).toEqual([input.originals[0].sha256]);
    await rm(join(directory, 'metadata.json'), { recursive: true }); await rename(join(directory, 'metadata.saved'), join(directory, 'metadata.json'));
    expect((await FileStore.open(directory)).isProcessed(input.inputId)).toBe(false);
  });
  it('reports successful intake and publication even if post-commit temporary cleanup fails', async () => {
    const { store, input, directory } = await setup(); const { run, publication } = await processed(store, input.inputId);
    const realRemove = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rm;
    const remove = vi.mocked(fs.rm).mockImplementation(async (path, options) => {
      const work = join(directory, '.work');
      if (path === join(work, run.id) || (typeof path === 'string' && path.startsWith(directory + '/') && path.endsWith('.tmp'))) throw new Error('injected temporary cleanup failure');
      return realRemove(path, options);
    });
    try {
      const added = await store.intake([{ origin: { kind: 'none' }, mediaType: 'text/plain', body: streamText('saved original') }]);
      expect(store.inputs()).toContainEqual(added);
      expect(store.items()).toEqual([]); expect(store.results(added.inputId)).toEqual([]);
      const [result] = await store.publish(run.id, [publication]);
      expect(result.publication).toEqual(publication); expect(store.isProcessed(input.inputId)).toBe(true);
      const reopened = await FileStore.open(directory);
      expect(reopened.context(result.item.itemId)).toEqual(result); expect(reopened.inputs()).toContainEqual(added);
      await expect(store.host(run.id).read(input.originals[0].id)).rejects.toThrow('not live');
      await expect(store.begin(input.inputId)).rejects.toThrow('already processed');
    } finally { remove.mockImplementation(realRemove); }
  });
  it('rechecks revocation after streamed writes and host service calls finish', async () => {
    let releaseService!: () => void; const serviceGate = new Promise<void>(resolve => { releaseService = resolve; });
    const { store, input, directory } = await setup(async original => { await serviceGate; return syntheticTranscriber(original); });
    const run = await store.begin(input.inputId); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const body = new ReadableStream<Uint8Array>({ async start(controller) { controller.enqueue(new TextEncoder().encode('first')); await gate; controller.close(); } });
    const writing = store.host(run.id).write({ role: 'late', mediaType: 'text/plain' }, body);
    const transcribing = store.host(run.id).transcribe(input.originals[0].id);
    const writeAssertion = expect(writing).rejects.toThrow('revoked'); const serviceAssertion = expect(transcribing).rejects.toThrow('revoked');
    await store.remove(videoRegistration.id); release(); releaseService(); await Promise.all([writeAssertion, serviceAssertion]);
    await store.fail(run.id, 'removed'); expect(await readdir(join(directory, '.work'))).toEqual([]);
    expect(await readdir(join(directory, 'blobs'))).toEqual([input.originals[0].sha256]);
  });
  it('requires the explicit transcription grant and an owned original video', async () => {
    let calls = 0; const { store, input } = await setup(async original => { calls++; return syntheticTranscriber(original); });
    await store.install({ ...videoRegistration, id: 'without-service', grants: [] });
    const run = await store.begin(input.inputId, 'without-service'); const host = store.host(run.id);
    await expect(host.transcribe(input.originals[0].id)).rejects.toThrow('grant required');
    const derived = await host.write({ role: 'derived-video', mediaType: 'video/webm' }, streamText('derived'));
    await expect(host.transcribe(derived.id)).rejects.toThrow('original video'); expect(calls).toBe(0);
    await store.fail(run.id, 'test cleanup');
  });
  it('enforces byte and output quotas without retaining rejected writes', async () => {
    const { store, input, directory } = await setup(); const run = await store.begin(input.inputId); const host = store.host(run.id);
    await expect(host.write({ role: 'too-large', mediaType: 'application/octet-stream' }, new Blob([new Uint8Array(16 * 1024 * 1024 + 1)]).stream())).rejects.toThrow('blob quota');
    const chunk = new Uint8Array(12 * 1024 * 1024);
    await host.write({ role: 'one', mediaType: 'application/octet-stream' }, new Blob([chunk]).stream());
    await host.write({ role: 'two', mediaType: 'application/octet-stream' }, new Blob([chunk]).stream());
    await expect(host.write({ role: 'three', mediaType: 'application/octet-stream' }, new Blob([chunk]).stream())).rejects.toThrow('output quota');
    expect(await readdir(join(directory, '.work', run.id))).toHaveLength(2);
    await store.fail(run.id, 'test cleanup'); expect(await readdir(join(directory, '.work'))).toEqual([]);
  });
  it('rejects the previous saved format with a fresh-store instruction', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'old-contract-')); directories.push(directory);
    const old = JSON.stringify({ items: {}, runs: {} }); await writeFile(join(directory, 'metadata.json'), old);
    await expect(FileStore.open(directory)).rejects.toThrow('use a fresh directory');
    expect(await readFile(join(directory, 'metadata.json'), 'utf8')).toBe(old);
  });
});

describe('second scenario: actual Parquet without new host operations', () => {
  it('parses selected columns through range reads and excludes the raw secret column from search', async () => {
    const { store } = await setup();
    const bytes = await readFile(new URL('../fixtures/tiny.parquet', import.meta.url)); expect(bytes.subarray(0, 4).toString()).toBe('PAR1'); expect(bytes.toString()).toContain('SECRET-DO-NOT-INDEX');
    const input = await store.intake([{ origin: { kind: 'file', relativePath: 'tiny.parquet' }, mediaType: 'application/vnd.apache.parquet', body: new Blob([bytes]).stream() }]);
    const [result] = await runInProcess(store, input.inputId, parquetRegistration.id, parquetProcessor);
    const fallback = await new Response(store.visibleArtifact(result.item.itemId, result.publication.presentation.fallback).body).text();
    expect(fallback).toBe('Harbor: 12\nForest: 34'); expect(store.search('Harbor')).toHaveLength(1); expect(store.search('SECRET')).toHaveLength(0);
    const reads = store.audit.reads.filter(read => read.inputId === input.inputId); expect(reads.length).toBeGreaterThan(1); expect(reads.every(read => !!read.range)).toBe(true);
    const layout = JSON.parse(await readFile(new URL('../fixtures/tiny-layout.json', import.meta.url), 'utf8'));
    expect(reads.some(read => read.range!.start === 0 && read.range!.end === bytes.length)).toBe(false);
    expect(reads.some(read => read.range!.start < layout.columns.secret.end && read.range!.end > layout.columns.secret.start)).toBe(false);
    expect(store.search('Forest')[0].artifact).toBe(result.publication.presentation.fallback);
    expect(result.publication.presentation.component).toBeUndefined();
    expect(() => store.visibleArtifact(result.item.itemId, input.originals[0].id)).toThrow('not published for item');
  });
});
