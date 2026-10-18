import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Artifact, ArtifactOrigin, ArtifactWriter, ByteRange, Input, Item, ProcessingHost, ProcessorRegistration, Publication, TranscriptSegment, UrlAcquirerRegistration, ViewContext } from './contract';

type Installed = { registration: ProcessorRegistration; epoch: string; active: boolean };
type InstalledAcquirer = { registration: UrlAcquirerRegistration; active: boolean };
type ProcessorInfo = { plugin: string; version: string; codeSha256?: string };
type StoredPublication = { publication: Publication; processor: ProcessorInfo };
type State = { schemaVersion: 7; inputs: Record<string, Input>; items: Record<string, Item>; artifacts: Record<string, Artifact>; publications: Record<string, StoredPublication>; processed: Record<string, string[]>; plugins: Record<string, Installed>; acquirers: Record<string, InstalledAcquirer> };
type PendingArtifact = { artifact: Artifact; path: string };
/** Execution authority and incomplete output are transient, never saved as a draft. */
type Run = ProcessorInfo & { id: string; inputId: string; epoch: string; outputs: Map<string, PendingArtifact>; finishing: boolean };
type AcquisitionRun = { id: string; outputs: Map<string, PendingArtifact>; finishing: boolean };
const blank = (): State => ({ schemaVersion: 7, inputs: {}, items: {}, artifacts: {}, publications: {}, processed: {}, plugins: {}, acquirers: {} });
const clone = <T>(value: T): T => structuredClone(value);
const id = (prefix: string) => `${prefix}_${randomUUID()}`;
function requireThat(test: unknown, message: string): asserts test { if (!test) throw new Error(message); }
const MAX_BLOB = 16 * 1024 * 1024;
const MAX_RUN = 32 * 1024 * 1024;
export const streamText = (text: string): ReadableStream<Uint8Array> => new Blob([text]).stream();
export type Transcriber = (original: Artifact) => Promise<TranscriptSegment[]>;
const validMediaType = (value: unknown): value is string => typeof value === 'string' && value.length < 150 && /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:;[^\r\n]*)?$/.test(value);
function artifactOrigin(value: ArtifactOrigin): ArtifactOrigin {
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 'invalid original origin');
  switch (value.kind) {
    case 'none': return { kind: 'none' };
    case 'file': {
      const { relativePath } = value;
      requireThat(typeof relativePath === 'string' && relativePath.length > 0 && relativePath.length <= 4096 && !/[\\\u0000-\u001f\u007f]/.test(relativePath) && !/^[A-Za-z]:/.test(relativePath) && relativePath.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'invalid original relative path');
      return { kind: 'file', relativePath };
    }
    case 'url': {
      const { url } = value;
      requireThat(typeof url === 'string' && url.length > 0 && url.length <= 8192 && !/[\u0000-\u001f\u007f]/.test(url), 'invalid original source URL');
      return { kind: 'url', url };
    }
    default: throw new Error('invalid original origin');
  }
}
function acquisitionUrl(value: string): URL {
  requireThat(typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\u0000-\u0020\u007f]/.test(value), 'invalid acquisition URL');
  const url = new URL(value);
  requireThat((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password, 'acquisition requires an HTTP(S) URL without credentials');
  return url;
}
/** Host-only intake helper; public upload APIs may assemble these streams in different ways. */
export interface OriginalUpload {
  mediaType: string;
  body: ReadableStream<Uint8Array>;
  origin: ArtifactOrigin;
}
/** Explicitly synthetic and deterministic. No audio recognition or provider call is claimed. */
export const syntheticTranscriber: Transcriber = async () => [
  { startMs: 0, endMs: 900, text: 'A blue square appears.' },
  { startMs: 1000, endMs: 1900, text: 'A green square appears.' },
];

/** Single-process prototype: process an input once into an atomic set of items, with immutable blobs. */
export class FileStore {
  private queue: Promise<unknown> = Promise.resolve();
  private runs = new Map<string, Run>();
  private acquisitions = new Map<string, AcquisitionRun>();
  readonly audit: { reads: { run: string; inputId: string; artifact: string; range?: ByteRange }[] } = { reads: [] };
  private constructor(readonly directory: string, private state: State, private transcriber: Transcriber) {}
  static async open(directory: string, transcriber: Transcriber = syntheticTranscriber) {
    let state: State;
    try {
      state = JSON.parse(await fs.readFile(join(directory, 'metadata.json'), 'utf8'));
      requireThat(state.schemaVersion === 7, 'incompatible store format; use a fresh directory (for example .demo-store-artifacts)');
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; state = blank(); }
    await fs.mkdir(join(directory, 'blobs'), { recursive: true });
    await fs.mkdir(join(directory, '.work'), { recursive: true });
    const store = new FileStore(directory, state, transcriber);
    await store.save(state); return store;
  }
  private async save(state: State) {
    const temporary = join(this.directory, `metadata.${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, 'wx');
    try {
      try { await handle.writeFile(JSON.stringify(state, null, 2)); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, join(this.directory, 'metadata.json'));
    } finally {
      // Preserve the write/rename outcome; removing an already-renamed temporary file is housekeeping.
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }
  private serialize<T>(action: () => T | Promise<T>): Promise<T> {
    const operation = this.queue.then(action); this.queue = operation.catch(() => {}); return operation;
  }
  private mutate<T>(action: (next: State) => T): Promise<T> {
    return this.serialize(async () => {
      const next = clone(this.state); const result = action(next);
      await this.save(next); this.state = next; return result;
    });
  }
  async install(registration: ProcessorRegistration) {
    requireThat(registration.id && registration.version && registration.accepts.length, 'invalid registration');
    return this.mutate(next => { next.plugins[registration.id] = { registration: clone(registration), epoch: id('epoch'), active: true }; });
  }
  async remove(plugin: string) { return this.mutate(next => { const installed = next.plugins[plugin]; requireThat(installed, 'unknown plugin'); installed.active = false; }); }
  async installAcquirer(registration: UrlAcquirerRegistration) {
    requireThat(registration && typeof registration.id === 'string' && registration.id.length > 0 && typeof registration.version === 'string' && registration.version.length > 0 && Array.isArray(registration.urlOrigins) && registration.urlOrigins.length > 0 && registration.urlOrigins.length <= 100, 'invalid acquirer registration');
    for (const origin of registration.urlOrigins) requireThat(acquisitionUrl(origin).origin === origin, 'acquirer requires exact HTTP(S) origins');
    return this.mutate(next => { next.acquirers[registration.id] = { registration: clone(registration), active: true }; });
  }
  async removeAcquirer(plugin: string) { return this.mutate(next => { const installed = next.acquirers[plugin]; requireThat(installed, 'unknown acquirer'); installed.active = false; }); }
  acquisitionCandidates(value: string): UrlAcquirerRegistration[] {
    const url = acquisitionUrl(value);
    return clone(Object.values(this.state.acquirers).filter(p => p.active && p.registration.urlOrigins.includes(url.origin)).map(p => p.registration));
  }
  async beginAcquisition(value: string, choice?: string): Promise<{ id: string; url: string }> {
    const url = acquisitionUrl(value).href;
    return this.serialize(async () => {
      const candidates = this.acquisitionCandidates(url);
      requireThat(choice || candidates.length === 1, candidates.length > 1 ? 'explicit acquisition handler choice required' : 'no acquisition handler');
      const selected = candidates.find(p => p.id === (choice ?? candidates[0].id)); requireThat(selected, 'acquirer does not accept URL origin');
      const run: AcquisitionRun = { id: id('acquisition'), outputs: new Map(), finishing: false };
      await fs.mkdir(join(this.directory, '.work', run.id)); this.acquisitions.set(run.id, run); return { id: run.id, url };
    });
  }
  private liveAcquisition(runId: string): AcquisitionRun {
    const run = this.acquisitions.get(runId); requireThat(run && !run.finishing, 'acquisition call is not live');
    return run;
  }
  acquisitionWriter(runId: string): ArtifactWriter {
    return {
      write: async (meta, body) => {
        this.liveAcquisition(runId); requireThat(meta && validMediaType(meta.mediaType), 'invalid acquired artifact media type');
        requireThat(body && typeof body.getReader === 'function', 'acquired byte stream required');
        const mediaType = meta.mediaType; const origin = artifactOrigin(meta.origin);
        const { path, ...stored } = await this.temporaryBlob(body, join(this.directory, '.work', runId));
        try {
          const run = this.liveAcquisition(runId); const size = [...run.outputs.values()].reduce((n, value) => n + value.artifact.size, 0);
          requireThat(run.outputs.size < 100, 'artifact count quota exceeded'); requireThat(size + stored.size <= MAX_RUN, 'acquisition output quota exceeded');
          const artifact: Artifact = { id: id('artifact'), role: 'original', mediaType, origin, ...stored };
          run.outputs.set(artifact.id, { artifact, path }); return clone(artifact);
        } catch (error) { await fs.rm(path, { force: true }); throw error; }
      },
    };
  }
  async completeAcquisition(runId: string, artifacts: Artifact[]): Promise<Input> {
    return this.serialize(async () => {
      const run = this.liveAcquisition(runId);
      requireThat(Array.isArray(artifacts) && artifacts.every(artifact => artifact && typeof artifact.id === 'string'), 'acquired artifact descriptors required');
      const artifactIds = artifacts.map(artifact => artifact.id);
      requireThat(Array.isArray(artifactIds) && artifactIds.length > 0 && artifactIds.length <= 100 && new Set(artifactIds).size === artifactIds.length, 'one to 100 unique acquired artifacts required');
      // Returned descriptors select completed writes; durable metadata comes from the store.
      const selected = artifactIds.map(artifactId => { const output = run.outputs.get(artifactId); requireThat(output, 'artifact outside acquisition'); return output; });
      const input: Input = { inputId: id('input'), originals: selected.map(({ artifact }) => clone(artifact)) };
      run.finishing = true; const created: string[] = [];
      try {
        const next = clone(this.state);
        for (const { artifact, path } of selected) {
          if (await this.promote(path, artifact.sha256)) created.push(artifact.sha256);
          next.artifacts[artifact.id] = clone(artifact);
        }
        next.inputs[input.inputId] = input;
        await this.save(next); this.state = next; this.acquisitions.delete(runId);
      } catch (error) {
        run.finishing = false;
        for (const sha256 of created) await fs.rm(join(this.directory, 'blobs', sha256), { force: true });
        throw error;
      }
      await fs.rm(join(this.directory, '.work', runId), { recursive: true, force: true }).catch(() => {});
      return clone(input);
    });
  }
  async failAcquisition(runId: string) {
    await this.serialize(async () => { this.acquisitions.delete(runId); await fs.rm(join(this.directory, '.work', runId), { recursive: true, force: true }); });
  }
  private async temporaryBlob(body: ReadableStream<Uint8Array>, directory: string) {
    const path = join(directory, `${randomUUID()}.tmp`);
    const file = await fs.open(path, 'wx'); const hash = createHash('sha256'); let size = 0;
    try {
      for await (const chunk of body as any as AsyncIterable<Uint8Array>) {
        requireThat(chunk instanceof Uint8Array, 'byte stream required'); size += chunk.byteLength;
        requireThat(size <= MAX_BLOB, 'blob quota exceeded'); hash.update(chunk); await file.writeFile(chunk);
      }
      await file.sync();
    } catch (error) { await file.close(); await fs.rm(path, { force: true }); throw error; }
    await file.close(); return { path, sha256: hash.digest('hex'), size };
  }
  private async promote(path: string, sha256: string): Promise<boolean> {
    try { await fs.link(path, join(this.directory, 'blobs', sha256)); return true; }
    catch (error: any) { if (error.code !== 'EEXIST') throw error; return false; }
  }
  async intake(originals: readonly OriginalUpload[]): Promise<Input> {
    const unread = new Set(Array.isArray(originals) ? originals.map(original => original?.body) : []);
    const staged: { path: string; artifact: Artifact }[] = []; let committed = false;
    try {
      requireThat(Array.isArray(originals) && originals.length > 0, 'at least one original is required');
      const uploads = originals.map(original => {
        requireThat(original && validMediaType(original.mediaType), 'invalid original media type');
        const { mediaType, body } = original;
        requireThat(body && typeof body.getReader === 'function', 'original byte stream required');
        const origin = artifactOrigin(original.origin);
        // Canonical copies prevent caller mutation while streams are being read.
        return { mediaType, body, origin };
      });
      const inputId = id('input'); const input: Input = { inputId, originals: [] };
      // Keep partial uploads outside the input index; all streams must finish before committing.
      for (const { body, ...metadata } of uploads) {
        const { path, ...stored } = await this.temporaryBlob(body, join(this.directory, '.work'));
        unread.delete(body);
        staged.push({ path, artifact: { id: id('artifact'), role: 'original', ...metadata, ...stored } });
      }
      input.originals = staged.map(entry => entry.artifact);
      await this.serialize(async () => {
        const created: string[] = [];
        try {
          const next = clone(this.state);
          for (const { path, artifact } of staged) {
            if (await this.promote(path, artifact.sha256)) created.push(artifact.sha256);
            next.artifacts[artifact.id] = artifact;
          }
          next.inputs[inputId] = input;
          await this.save(next); this.state = next;
        } catch (error) {
          for (const sha256 of created) await fs.rm(join(this.directory, 'blobs', sha256), { force: true });
          throw error;
        }
      });
      committed = true; return clone(input);
    } catch (error) {
      // Later streams may already own resources even though intake has not pulled their bytes.
      // Cancellation is best-effort: one failed cleanup must not mask the upload's rejection.
      await Promise.allSettled([...unread].map(async body => { if (typeof body?.cancel === 'function') await body.cancel(error); }));
      throw error;
    } finally {
      // A saved batch is successful intake even if its temporary links cannot be removed.
      const cleanup = Promise.all(staged.map(({ path }) => fs.rm(path, { force: true })));
      if (committed) await cleanup.catch(() => {}); else await cleanup;
    }
  }
  inputs() { return clone(Object.values(this.state.inputs)); }
  items() { return clone(Object.values(this.state.items)); }
  isPublished(itemId: string) { return Boolean(this.state.publications[itemId]); }
  isProcessed(inputId: string) { return Object.hasOwn(this.state.processed, inputId); }
  results(inputId: string): ViewContext[] {
    requireThat(this.state.inputs[inputId], 'unknown input');
    return (this.state.processed[inputId] ?? []).map(itemId => this.context(itemId));
  }
  candidates(inputId: string): ProcessorRegistration[] {
    const input = this.state.inputs[inputId]; requireThat(input, 'unknown input');
    return clone(Object.values(this.state.plugins).filter(p => p.active && input.originals.every(a => p.registration.accepts.some(pattern => a.mediaType === pattern || (pattern.endsWith('/*') && a.mediaType.startsWith(pattern.slice(0, -1)))))).map(p => p.registration));
  }
  async begin(inputId: string, choice?: string, codeSha256?: string): Promise<{ id: string; inputId: string }> {
    return this.serialize(async () => {
      requireThat(!this.isProcessed(inputId), 'input is already processed');
      requireThat(![...this.runs.values()].some(run => run.inputId === inputId), 'input is already processing');
      const candidates = this.candidates(inputId);
      requireThat(choice || candidates.length === 1, candidates.length > 1 ? 'explicit handler choice required' : 'no handler');
      const selected = candidates.find(p => p.id === (choice ?? candidates[0].id)); requireThat(selected, 'handler does not accept input');
      const run: Run = { id: id('run'), inputId, plugin: selected.id, version: selected.version, codeSha256, epoch: this.state.plugins[selected.id].epoch, outputs: new Map(), finishing: false };
      await fs.mkdir(join(this.directory, '.work', run.id)); this.runs.set(run.id, run); return { id: run.id, inputId };
    });
  }
  input(runId: string) { const run = this.live(runId); return clone(this.state.inputs[run.inputId]); }
  private live(runId: string): Run {
    const run = this.runs.get(runId); requireThat(run && !run.finishing, 'processing call is not live');
    const installed = this.state.plugins[run.plugin]; requireThat(installed?.active && installed.epoch === run.epoch, 'capability revoked'); return run;
  }
  private owned(run: Run, artifactId: string): PendingArtifact {
    const output = run.outputs.get(artifactId); if (output) return output;
    const original = this.state.inputs[run.inputId].originals.find(artifact => artifact.id === artifactId);
    requireThat(original, 'artifact outside capability'); return { artifact: original, path: join(this.directory, 'blobs', original.sha256) };
  }
  private bytes(artifact: Artifact, range?: ByteRange, path = join(this.directory, 'blobs', artifact.sha256)): ReadableStream<Uint8Array> {
    if (range) {
      requireThat(Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && range.start >= 0 && range.end >= range.start && range.end <= artifact.size, 'invalid range');
      if (range.start === range.end) return streamText('');
    }
    return Readable.toWeb(createReadStream(path, range ? { start: range.start, end: range.end - 1 } : undefined)) as ReadableStream<Uint8Array>;
  }
  host(runId: string): ProcessingHost {
    return {
      read: async (artifactId, range) => {
        const run = this.live(runId); const { artifact, path } = this.owned(run, artifactId);
        this.audit.reads.push({ run: runId, inputId: run.inputId, artifact: artifactId, range }); return this.bytes(artifact, range, path);
      },
      write: async (meta, body) => {
        this.live(runId); requireThat(typeof meta.role === 'string' && meta.role.length > 0 && meta.role.length < 100 && typeof meta.mediaType === 'string' && meta.mediaType.length > 0 && meta.mediaType.length < 150, 'invalid artifact metadata');
        const { path, ...stored } = await this.temporaryBlob(body, join(this.directory, '.work', runId));
        try {
          // Recheck after the asynchronous stream; no authority survives removal or completion.
          const run = this.live(runId); const size = [...run.outputs.values()].reduce((n, value) => n + value.artifact.size, 0);
          requireThat(run.outputs.size < 100, 'artifact count quota exceeded'); requireThat(size + stored.size <= MAX_RUN, 'processing output quota exceeded');
          const artifact: Artifact = { id: id('artifact'), role: meta.role, mediaType: meta.mediaType, origin: { kind: 'none' }, ...stored };
          run.outputs.set(artifact.id, { artifact, path }); return clone(artifact);
        } catch (error) { await fs.rm(path, { force: true }); throw error; }
      },
      transcribe: async originalId => {
        const run = this.live(runId); const original = this.owned(run, originalId).artifact;
        requireThat(this.state.inputs[run.inputId].originals.some(artifact => artifact.id === originalId) && original.mediaType.startsWith('video/'), 'transcription requires original video');
        requireThat(this.state.plugins[run.plugin].registration.grants.includes('transcribe'), 'transcription grant required');
        const result = await this.transcriber(clone(original)); this.live(runId); return clone(result);
      },
    };
  }
  async publish(runId: string, publications: Publication[]): Promise<ViewContext[]> {
    const itemIds = await this.serialize(async () => {
      const run = this.live(runId); const manifests = clone(publications);
      requireThat(Array.isArray(manifests) && manifests.length > 0 && manifests.length <= 100, 'one to 100 publications required');
      const selectedOutputs = new Set<string>();
      // Validate the complete set before promoting any output or assigning result identities.
      for (const p of manifests) {
        requireThat(p && typeof p.title === 'string' && p.title.length <= 300 && typeof p.description === 'string' && p.description.length <= 2000, 'invalid publication metadata');
        requireThat(Array.isArray(p.artifacts) && p.artifacts.length <= 100 && new Set(p.artifacts).size === p.artifacts.length, 'invalid artifact manifest');
        for (const artifactId of p.artifacts) {
          this.owned(run, artifactId);
          if (run.outputs.has(artifactId)) selectedOutputs.add(artifactId);
        }
        const visible = new Set(p.artifacts);
        requireThat(p.presentation && visible.has(p.presentation.fallback) && this.owned(run, p.presentation.fallback).artifact.mediaType === 'text/plain', 'readable text fallback required');
        for (const value of [p.presentation.thumbnail, p.presentation.component]) if (value !== undefined) requireThat(visible.has(value), 'presentation artifact not published');
        if (p.presentation.component !== undefined) requireThat(this.owned(run, p.presentation.component).artifact.mediaType === 'text/html', 'component must be html');
        requireThat(Array.isArray(p.search) && p.search.length <= 1000 && p.search.every(entry => entry && typeof entry.text === 'string' && entry.text.length <= 10000 && visible.has(entry.artifact)), 'search artifact must be published for item');
      }
      run.finishing = true; const created: string[] = [];
      const resultIds = manifests.map(() => id('item'));
      try {
        const next = clone(this.state);
        // A selected output may appear in many manifests; it enters durable storage only once.
        for (const artifactId of selectedOutputs) {
          const { artifact, path } = run.outputs.get(artifactId)!;
          if (await this.promote(path, artifact.sha256)) created.push(artifact.sha256);
          next.artifacts[artifactId] = clone(artifact);
        }
        for (const [index, publication] of manifests.entries()) {
          const itemId = resultIds[index];
          next.items[itemId] = { itemId, artifacts: publication.artifacts.map(artifactId => clone(next.artifacts[artifactId])) };
          next.publications[itemId] = { publication, processor: { plugin: run.plugin, version: run.version, codeSha256: run.codeSha256 } };
        }
        next.processed[run.inputId] = resultIds;
        await this.save(next); this.state = next; this.runs.delete(runId);
      } catch (error) {
        run.finishing = false;
        for (const sha256 of created) await fs.rm(join(this.directory, 'blobs', sha256), { force: true });
        throw error;
      }
      // All results are durable now. Housekeeping must not undo or report failure for that save.
      await fs.rm(join(this.directory, '.work', runId), { recursive: true, force: true }).catch(() => {});
      return resultIds;
    });
    return itemIds.map(itemId => this.context(itemId));
  }
  async fail(runId: string, _error: unknown) {
    await this.serialize(async () => {
      this.runs.delete(runId); await fs.rm(join(this.directory, '.work', runId), { recursive: true, force: true });
    });
  }
  context(itemId: string): ViewContext {
    const stored = this.state.publications[itemId]; requireThat(stored, 'item is not published');
    const publication = clone(stored.publication);
    if (!this.state.plugins[stored.processor.plugin]?.active) delete publication.presentation.component;
    return { item: clone(this.state.items[itemId]), publication };
  }
  search(query: string) {
    return Object.entries(this.state.publications).flatMap(([itemId, { publication }]) => publication.search.filter(entry => entry.text.toLowerCase().includes(query.toLowerCase())).map(entry => ({ itemId, text: entry.text, artifact: entry.artifact })));
  }
  visibleArtifact(itemId: string, artifactId: string, range?: ByteRange) {
    const item = this.state.items[itemId]; requireThat(item, 'unknown item');
    const artifact = this.state.artifacts[artifactId];
    requireThat(artifact && item.artifacts.some(member => member.id === artifactId), 'artifact is not published for item');
    const stored = this.state.publications[itemId];
    requireThat(this.state.plugins[stored.processor.plugin]?.active || stored.publication.presentation.component !== artifactId, 'component removed');
    return { artifact: clone(artifact), body: this.bytes(artifact, range) };
  }
  /** Called only from the trusted runtime bridge; x-run is injected by its scoped capability. */
  async capabilityFetch(request: Request): Promise<Response> {
    try {
      const runId = request.headers.get('x-run') ?? ''; const url = new URL(request.url);
      const host = this.host(runId);
      if (request.method === 'GET' && url.pathname.startsWith('/read/')) {
        const range = url.searchParams.has('start') ? { start: Number(url.searchParams.get('start')), end: Number(url.searchParams.get('end')) } : undefined;
        return new Response(await host.read(decodeURIComponent(url.pathname.slice(6)), range));
      }
      if (request.method === 'PUT' && url.pathname === '/write') return Response.json(await host.write({ role: request.headers.get('x-role') ?? '', mediaType: request.headers.get('content-type') ?? '' }, request.body ?? streamText('')));
      if (request.method === 'POST' && url.pathname === '/transcribe') { const { original } = await request.json() as any; return Response.json(await host.transcribe(original)); }
      return new Response('unknown capability operation', { status: 400 });
    } catch (error) { return new Response(String(error), { status: 403 }); }
  }
}
