import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Publication } from '../src/contract';
import { FileStore, streamText } from '../src/store';
import { runInProcess } from '../src/runner';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'publication-set-')); directories.push(directory);
  const store = await FileStore.open(directory);
  await store.install({ id: 'documents', version: '0.1.0', accepts: ['text/plain'] });
  const input = await store.intake([
    { mediaType: 'text/plain', origin: { kind: 'url', url: 'https://example.com/first' }, body: streamText('First original') },
    { mediaType: 'text/plain', origin: { kind: 'url', url: 'https://example.com/second' }, body: streamText('Second original') },
  ]);
  return { directory, store, input };
}
const manifest = (title: string, fallback: string, artifacts = [fallback]): Publication => ({
  title, description: '', artifacts, search: [{ text: title, artifact: fallback }], presentation: { fallback },
});
const bytes = async (store: FileStore, itemId: string, artifactId: string) => new Response(store.visibleArtifact(itemId, artifactId).body).text();

describe('an input produces an atomic set of published items', () => {
  it('assigns separate result identities, scopes each item explicitly, and persists intentional sharing', async () => {
    const { store, input, directory } = await setup();
    expect(store.items()).toEqual([]); expect(store.results(input.inputId)).toEqual([]);
    const run = await store.begin(input.inputId); const host = store.host(run.id);
    const shared = await host.write({ role: 'shared-index', mediaType: 'text/plain' }, streamText('Shared index'));
    const discarded = await host.write({ role: 'unused', mediaType: 'text/plain' }, streamText('Unpublished output'));
    const [first, second] = input.originals;
    const publications = [
      manifest('First result', first.id, [first.id, shared.id]),
      manifest('Second result', second.id, [second.id, shared.id]),
      manifest('Another view of first', first.id, [first.id, shared.id]),
    ];
    const contexts = await store.publish(run.id, publications);
    const itemIds = contexts.map(context => context.item.itemId);
    expect(new Set(itemIds).size).toBe(3); expect(itemIds).not.toContain(input.inputId);
    expect(contexts.map(context => context.publication)).toEqual(publications);
    expect(contexts.map(context => context.item.artifacts.map(artifact => artifact.id))).toEqual(publications.map(publication => publication.artifacts));
    expect(contexts[0].item.artifacts[0]).toEqual(first);
    expect(first.origin).toEqual({ kind: 'url', url: 'https://example.com/first' });
    expect(second.origin).toEqual({ kind: 'url', url: 'https://example.com/second' });
    expect(shared.origin).toEqual({ kind: 'none' }); expect(discarded.origin).toEqual({ kind: 'none' });
    expect(store.items()).toEqual(contexts.map(context => context.item));
    expect(store.results(input.inputId)).toEqual(contexts); expect(store.isProcessed(input.inputId)).toBe(true);
    for (const itemId of itemIds) expect(await bytes(store, itemId, shared.id)).toBe('Shared index');
    expect(await bytes(store, itemIds[0], first.id)).toBe('First original');
    expect(await bytes(store, itemIds[2], first.id)).toBe('First original');
    expect(() => store.visibleArtifact(itemIds[0], second.id)).toThrow('not published for item');
    expect(() => store.visibleArtifact(itemIds[1], first.id)).toThrow('not published for item');
    expect(() => store.visibleArtifact(itemIds[0], discarded.id)).toThrow('not published for item');
    expect(() => store.visibleArtifact(input.inputId, first.id)).toThrow('unknown item');
    expect(store.search('First result')).toEqual([{ itemId: itemIds[0], text: 'First result', artifact: first.id }]);
    expect(store.search('Second result')).toEqual([{ itemId: itemIds[1], text: 'Second result', artifact: second.id }]);
    expect(await readdir(join(directory, '.work'))).toEqual([]);
    expect((await readdir(join(directory, 'blobs'))).sort()).toEqual([first.sha256, second.sha256, shared.sha256].sort());
    await expect(host.read(first.id)).rejects.toThrow('not live');
    const saved = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8'));
    expect(saved.processed[input.inputId]).toEqual(itemIds);
    expect(Object.keys(saved.artifacts)).toHaveLength(3);
    const reopened = await FileStore.open(directory);
    expect(reopened.results(input.inputId)).toEqual(contexts); expect(reopened.inputs()).toEqual([input]);
    await expect(reopened.begin(input.inputId)).rejects.toThrow('already processed');
    expect(() => reopened.visibleArtifact(itemIds[0], second.id)).toThrow('not published for item');
  });

  it('rejects an invalid later result without publishing the valid first result and discards the run', async () => {
    const { store, input, directory } = await setup();
    await expect(runInProcess(store, input.inputId, 'documents', async (value, host) => {
      const fallback = await host.write({ role: 'summary', mediaType: 'text/plain' }, streamText('Tentative summary'));
      return [manifest('Valid first result', fallback.id), {
        ...manifest('Invalid later result', fallback.id),
        search: [{ text: 'omitted original', artifact: value.originals[1].id }],
      }];
    })).rejects.toThrow('search artifact');
    expect(store.items()).toEqual([]); expect(store.results(input.inputId)).toEqual([]);
    expect(store.isProcessed(input.inputId)).toBe(false); expect(store.search('Valid')).toEqual([]);
    expect(await readdir(join(directory, '.work'))).toEqual([]);
    expect((await readdir(join(directory, 'blobs'))).sort()).toEqual(input.originals.map(original => original.sha256).sort());
    const reopened = await FileStore.open(directory);
    expect(reopened.items()).toEqual([]); expect(reopened.results(input.inputId)).toEqual([]);
  });

  it('rolls back all new blobs on a failed set commit while preserving already shared content', async () => {
    const { store, input, directory } = await setup();
    const existing = await store.intake([{ origin: { kind: 'none' }, mediaType: 'text/plain', body: streamText('Already stored shared bytes') }]);
    const priorRun = await store.begin(existing.inputId);
    const [prior] = await store.publish(priorRun.id, [manifest('Already published', existing.originals[0].id)]);
    const before = (await readdir(join(directory, 'blobs'))).sort();
    const run = await store.begin(input.inputId); const host = store.host(run.id);
    // Different artifact identities can share hashes with an existing blob and with each other.
    const reused = await host.write({ role: 'reused', mediaType: 'text/plain' }, streamText('Already stored shared bytes'));
    const first = await host.write({ role: 'first', mediaType: 'text/plain' }, streamText('New shared output bytes'));
    const duplicate = await host.write({ role: 'duplicate', mediaType: 'text/plain' }, streamText('New shared output bytes'));
    await rename(join(directory, 'metadata.json'), join(directory, 'metadata.saved')); await mkdir(join(directory, 'metadata.json'));
    await expect(store.publish(run.id, [
      manifest('New first result', reused.id, [reused.id, first.id]),
      manifest('New second result', duplicate.id),
    ])).rejects.toThrow();
    expect(store.items()).toEqual([prior.item]); expect(store.results(input.inputId)).toEqual([]);
    expect(store.isProcessed(input.inputId)).toBe(false); expect(store.search('New')).toEqual([]);
    expect((await readdir(join(directory, 'blobs'))).sort()).toEqual(before);
    expect(await bytes(store, prior.item.itemId, existing.originals[0].id)).toBe('Already stored shared bytes');
    await store.fail(run.id, 'commit failed'); expect(await readdir(join(directory, '.work'))).toEqual([]);
    await rm(join(directory, 'metadata.json'), { recursive: true }); await rename(join(directory, 'metadata.saved'), join(directory, 'metadata.json'));
    const reopened = await FileStore.open(directory);
    expect(reopened.items()).toEqual([prior.item]); expect(reopened.results(input.inputId)).toEqual([]);
    expect(reopened.isProcessed(input.inputId)).toBe(false);
  });

  it('requires a nonempty bounded result set, and accepts an explicitly selected original as fallback', async () => {
    const { store, input } = await setup(); const run = await store.begin(input.inputId);
    const publication = manifest('Original text', input.originals[0].id);
    await expect(store.publish(run.id, [])).rejects.toThrow('one to 100 publications');
    await expect(store.publish(run.id, Array.from({ length: 101 }, () => publication))).rejects.toThrow('one to 100 publications');
    expect(store.results(input.inputId)).toEqual([]); expect(store.items()).toEqual([]);
    const [context] = await store.publish(run.id, [publication]);
    expect(context.item.artifacts).toEqual([input.originals[0]]);
    expect(await bytes(store, context.item.itemId, input.originals[0].id)).toBe('First original');
    expect(() => store.visibleArtifact(context.item.itemId, input.originals[1].id)).toThrow('not published for item');
    expect(() => store.results('unknown-input')).toThrow('unknown input');
  });
});
