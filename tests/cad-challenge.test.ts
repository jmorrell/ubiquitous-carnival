import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, streamText } from '../src/store';
import type { Input, Publication, ProcessorRegistration, Selector } from '../src/contract';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const registration: ProcessorRegistration = {
  id: 'cad-held-out-challenge', version: '1', accepts: ['model/step'], grants: [],
};
// A synthetic locator on synthetic bytes. This is not a parsed or validated CAD face.
const selector: Selector = {
  kind: 'fragment', scheme: 'urn:magpie:cad:face-uv:v1', value: 'face=7;u=0.25;v=0.75',
};
const originalBytes = 'synthetic CAD artifact; deliberately not valid STEP';

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'cad-challenge-')); directories.push(directory);
  const store = await FileStore.open(directory); await store.install(registration);
  const item = await store.intake({ kind: 'upload', filename: 'synthetic.step' }, 'model/step', streamText(originalBytes));
  return { directory, store, item };
}
async function staged(store: FileStore, item: Input, locator: Selector = selector) {
  const run = await store.begin(item.itemId);
  const fallback = await store.host(run.id).write({ role: 'readable-fallback', mediaType: 'text/plain' }, streamText('Synthetic CAD fixture. No geometry was parsed.'));
  const publication: Publication = {
    title: 'CAD selector challenge', description: 'Synthetic target only',
    artifacts: [fallback.id],
    targets: [{ key: 'face-point', artifact: item.originals[0].id, selector: locator }],
    search: [], presentation: { fallback: fallback.id },
  };
  return { run, publication };
}

it('held-out CAD amendment retains an original-bound locator and note across upgrade, reprocessing and removal', async () => {
  const { store, item, directory } = await setup();
  const initial = await staged(store, item);
  const published = await store.publish(initial.run.id, initial.publication);
  const firstTarget = published.generation.targets![0];
  const note = await store.annotate(item.itemId, firstTarget.id, 'Inspect this synthetic face location.');

  await store.install({ ...registration, version: '2' });
  // Property insertion order is an encoding detail, not a change of location.
  const reordered: Selector = { value: 'face=7;u=0.25;v=0.75', scheme: 'urn:magpie:cad:face-uv:v1', kind: 'fragment' };
  const regenerated = await staged(store, item, reordered);
  const next = await store.publish(regenerated.run.id, regenerated.publication);
  expect(next.generation.targets![0].id).toBe(firstTarget.id);
  expect(next.annotationStatus[note.id]).toBe('current');
  expect(next.annotations[0]).toEqual(note);

  const changedSelector: Selector = { kind: 'fragment', scheme: 'urn:magpie:cad:face-uv:v1', value: 'face=8;u=0.25;v=0.75' };
  const changed = await staged(store, item, changedSelector);
  const changedView = await store.publish(changed.run.id, changed.publication);
  expect(changedView.generation.targets![0].id).not.toBe(firstTarget.id);
  expect(changedView.annotationStatus[note.id]).toBe('historical');
  expect(store.resolveTarget(item.itemId, note.target)).toEqual({ target: firstTarget, status: 'historical' });

  await store.remove(registration.id);
  expect(store.context(item.itemId).annotations[0]).toEqual(note);
  expect(store.resolveTarget(item.itemId, note.target).target.selector).toEqual(selector);
  expect(await new Response(store.visibleArtifact(item.itemId, item.originals[0].id).body).text()).toBe(originalBytes);
  expect(await new Response(store.visibleArtifact(item.itemId, changed.publication.presentation.fallback).body).text()).toContain('No geometry was parsed.');
  const restarted = await FileStore.open(directory);
  expect(restarted.context(item.itemId).annotations[0]).toEqual(note);
  expect(restarted.resolveTarget(item.itemId, note.target)).toEqual({ target: firstTarget, status: 'historical' });
});

it('validates inert fragment representation and retains ordinary artifact ownership enforcement', async () => {
  const { store, item } = await setup();
  const { run, publication } = await staged(store, item);
  for (const invalid of [
    { kind: 'fragment', scheme: 'cad-face', value: '7' },
    { kind: 'fragment', scheme: 'urn:magpie:cad:face-uv', value: '7' },
    { kind: 'fragment', scheme: 'urn:magpie:cad:face-uv:v1', value: ' ' },
    { kind: 'fragment', scheme: 'urn:magpie:cad:face-uv:v1', value: 'x'.repeat(4097) },
  ]) {
    // Deliberately bypass TS: untrusted JSON must be checked before publication.
    const invalidPublication = { ...publication, targets: [{ ...publication.targets[0], selector: invalid }] };
    await expect(store.publish(run.id, invalidPublication as unknown as Publication)).rejects.toThrow('invalid namespaced fragment');
  }
  const foreign = await store.intake({ kind: 'upload', filename: 'other.step' }, 'model/step', streamText('another synthetic original'));
  await expect(store.publish(run.id, {
    ...publication, targets: [{ ...publication.targets[0], artifact: foreign.originals[0].id }],
  })).rejects.toThrow('target artifact not published');
  expect(() => store.context(item.itemId)).toThrow('not published');
  await store.publish(run.id, publication);
  expect(store.context(item.itemId).generation.targets![0].selector).toEqual(selector);
});
