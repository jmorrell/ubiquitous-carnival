import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Annotation, Artifact, ByteRange, Generation, Item, ProcessingHost, ProcessorRegistration, Publication, Source, Target, TranscriptSegment, ViewContext } from './contract';

type Installed = { registration: ProcessorRegistration; epoch: string; active: boolean };
type Run = Generation & { epoch: string; error?: string };
type Effect = { state: 'pending' | 'completed'; result?: TranscriptSegment[] };
type State = { items: Record<string, Item>; artifacts: Record<string, Artifact>; runs: Record<string, Run>; plugins: Record<string, Installed>; annotations: Annotation[]; effects: Record<string, Effect> };
const blank = (): State => ({ items: {}, artifacts: {}, runs: {}, plugins: {}, annotations: [], effects: {} });
const clone = <T>(value: T): T => structuredClone(value);
const id = (prefix: string) => `${prefix}_${randomUUID()}`;
function requireThat(test: unknown, message: string): asserts test { if (!test) throw new Error(message); }
const MAX_BLOB = 16 * 1024 * 1024;
const MAX_RUN = 32 * 1024 * 1024;
export const streamText = (text: string): ReadableStream<Uint8Array> => new Blob([text]).stream();
export type Transcriber = (original: Artifact, profile: 'v1' | 'v2') => Promise<TranscriptSegment[]>;
/** Explicitly synthetic and deterministic. No audio recognition or provider call is claimed. */
export const syntheticTranscriber: Transcriber = async (_original, profile) => [
  { startMs: 0, endMs: 900, text: profile === 'v1' ? 'A blue square appears.' : 'A bright blue square appears.' },
  { startMs: 1000, endMs: 1900, text: 'A green square appears.' },
];

/** Single-process prototype: atomic metadata snapshots, immutable streamed blobs, no database/GC. */
export class FileStore {
  private state: State;
  private queue: Promise<unknown> = Promise.resolve();
  readonly audit: { reads: { run: string; artifact: string; range?: ByteRange }[] } = { reads: [] };
  private constructor(readonly directory: string, state: State, private transcriber: Transcriber) { this.state = state; }
  static async open(directory: string, transcriber: Transcriber = syntheticTranscriber) {
    await fs.mkdir(join(directory, 'blobs'), { recursive: true });
    let state: State;
    try { state = JSON.parse(await fs.readFile(join(directory, 'metadata.json'), 'utf8')); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; state = blank(); }
    const store = new FileStore(directory, state, transcriber);
    // A process crash never implicitly resumes a generation. The pending effect ledger stays fenced.
    for (const run of Object.values(state.runs)) if (run.state === 'staging') { run.state = 'failed'; run.error = 'interrupted before publication'; }
    await store.save();
    return store;
  }
  private async save(state = this.state) {
    const temporary = join(this.directory, `metadata.${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, 'wx');
    try { await handle.writeFile(JSON.stringify(state, null, 2)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, join(this.directory, 'metadata.json'));
  }
  private mutate<T>(action: () => T): Promise<T> {
    const operation = this.queue.then(async () => {
      const previous = this.state; const next = clone(previous); let result: T;
      // Mutations are synchronous against a draft. Readers see only the committed snapshot.
      this.state = next;
      try { result = action(); } finally { this.state = previous; }
      await this.save(next); this.state = next; return result;
    });
    this.queue = operation.catch(() => {}); return operation;
  }
  async install(registration: ProcessorRegistration) {
    requireThat(registration.id && registration.version && registration.accepts.length, 'invalid registration');
    return this.mutate(() => { this.state.plugins[registration.id] = { registration: clone(registration), epoch: id('epoch'), active: true }; });
  }
  async remove(plugin: string) { return this.mutate(() => { const installed = this.state.plugins[plugin]; requireThat(installed, 'unknown plugin'); installed.active = false; }); }
  private async blob(body: ReadableStream<Uint8Array>) {
    const temporary = join(this.directory, 'blobs', `${randomUUID()}.tmp`);
    const file = await fs.open(temporary, 'wx'); const hash = createHash('sha256'); let size = 0;
    try {
      for await (const chunk of body as any as AsyncIterable<Uint8Array>) {
        requireThat(chunk instanceof Uint8Array, 'byte stream required'); size += chunk.byteLength;
        requireThat(size <= MAX_BLOB, 'blob quota exceeded'); hash.update(chunk); await file.writeFile(chunk);
      }
      await file.sync();
    } catch (error) { await file.close(); await fs.rm(temporary, { force: true }); throw error; }
    await file.close(); const sha256 = hash.digest('hex');
    try { await fs.link(temporary, join(this.directory, 'blobs', sha256)); } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
    finally { await fs.rm(temporary, { force: true }); }
    return { sha256, size };
  }
  async intake(source: Source, mediaType: string, body: ReadableStream<Uint8Array>): Promise<Item> {
    const stored = await this.blob(body); const itemId = id('item');
    const original: Artifact = { id: id('artifact'), itemId, generation: null, role: 'original', mediaType, ...stored };
    const item: Item = { itemId, source: clone(source), originals: [original] };
    await this.mutate(() => { this.state.artifacts[original.id] = original; this.state.items[itemId] = item; }); return clone(item);
  }
  items() { return clone(Object.values(this.state.items)); }
  candidates(itemId: string): ProcessorRegistration[] {
    const item = this.state.items[itemId]; requireThat(item, 'unknown item');
    return clone(Object.values(this.state.plugins).filter(p => p.active && p.registration.accepts.some(pattern => item.originals.some(a => a.mediaType === pattern || (pattern.endsWith('/*') && a.mediaType.startsWith(pattern.slice(0, -1)))))).map(p => p.registration));
  }
  async begin(itemId: string, choice?: string, codeSha256?: string): Promise<Generation> {
    return this.mutate(() => {
      const candidates = this.candidates(itemId);
      requireThat(choice || candidates.length === 1, candidates.length > 1 ? 'explicit handler choice required' : 'no handler');
      const selected = candidates.find(p => p.id === (choice ?? candidates[0].id)); requireThat(selected, 'handler does not accept input');
      // Latest requested generation wins. Old work is fenced before the new scope is returned.
      for (const old of Object.values(this.state.runs)) if (old.itemId === itemId && old.state === 'staging') { old.state = 'failed'; old.error = 'superseded'; }
      const run: Run = { id: id('generation'), itemId, plugin: selected.id, version: selected.version, state: 'staging', codeSha256, epoch: this.state.plugins[selected.id].epoch };
      this.state.runs[run.id] = run; return clone(run);
    });
  }
  input(runId: string) { const run = this.live(runId); return clone(this.state.items[run.itemId]); }
  private live(runId: string): Run {
    const run = this.state.runs[runId]; requireThat(run?.state === 'staging', 'generation is not live');
    const installed = this.state.plugins[run.plugin]; requireThat(installed?.active && installed.epoch === run.epoch, 'capability revoked'); return run;
  }
  private owned(run: Run, artifactId: string) {
    const artifact = this.state.artifacts[artifactId];
    requireThat(artifact && artifact.itemId === run.itemId && (artifact.generation === null || artifact.generation === run.id), 'artifact outside capability'); return artifact;
  }
  private bytes(artifact: Artifact, range?: ByteRange): ReadableStream<Uint8Array> {
    if (range) {
      requireThat(Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && range.start >= 0 && range.end >= range.start && range.end <= artifact.size, 'invalid range');
      if (range.start === range.end) return streamText('');
    }
    return Readable.toWeb(createReadStream(join(this.directory, 'blobs', artifact.sha256), range ? { start: range.start, end: range.end - 1 } : undefined)) as ReadableStream<Uint8Array>;
  }
  host(runId: string): ProcessingHost {
    return {
      read: async (artifactId, range) => {
        const artifact = this.owned(this.live(runId), artifactId); this.audit.reads.push({ run: runId, artifact: artifactId, range }); return this.bytes(artifact, range);
      },
      write: async (meta, body) => {
        this.live(runId); requireThat(typeof meta.role === 'string' && meta.role.length > 0 && meta.role.length < 100 && typeof meta.mediaType === 'string' && meta.mediaType.length < 150, 'invalid artifact metadata');
        const stored = await this.blob(body);
        return this.mutate(() => {
          const run = this.live(runId); const staged = Object.values(this.state.artifacts).filter(a => a.generation === runId); const size = staged.reduce((n, a) => n + a.size, 0);
          requireThat(staged.length < 100, 'artifact count quota exceeded');
          requireThat(size + stored.size <= MAX_RUN, 'generation quota exceeded');
          const artifact: Artifact = { id: id('artifact'), itemId: run.itemId, generation: runId, ...meta, ...stored };
          this.state.artifacts[artifact.id] = artifact; return clone(artifact);
        });
      },
      transcribe: async (originalId, profile) => {
        const run = this.live(runId); const original = this.owned(run, originalId);
        requireThat(original.generation === null && original.mediaType.startsWith('video/'), 'transcription requires original video');
        requireThat(profile === 'v1' || profile === 'v2', 'unapproved transcription profile');
        requireThat(this.state.plugins[run.plugin].registration.grants.includes('transcribe'), 'transcription grant required');
        // Host derives scope and options. A changed model/profile is a distinct external effect.
        const key = `${run.itemId}:${run.plugin}:${original.sha256}:${profile}`;
        const cached = await this.mutate(() => {
          this.live(runId); const effect = this.state.effects[key];
          if (effect?.state === 'completed') return clone(effect.result!);
          requireThat(!effect, 'effect outcome uncertain; reconciliation required');
          this.state.effects[key] = { state: 'pending' }; return null;
        });
        if (cached) return cached;
        // If the process dies or the provider fails ambiguously, pending is deliberately NOT retried.
        const result = await this.transcriber(clone(original), profile);
        await this.mutate(() => { this.state.effects[key] = { state: 'completed', result: clone(result) }; });
        this.live(runId); return clone(result);
      },
    };
  }
  async publish(runId: string, publication: Publication) {
    const run = this.live(runId); const p = clone(publication);
    requireThat(typeof p.title === 'string' && p.title.length <= 300 && typeof p.description === 'string' && p.description.length <= 2000, 'invalid publication metadata');
    requireThat(Array.isArray(p.artifacts) && p.artifacts.length <= 100 && new Set(p.artifacts).size === p.artifacts.length, 'invalid artifact manifest');
    for (const artifactId of p.artifacts) requireThat(this.owned(run, artifactId).generation === runId, 'publication needs generation artifacts');
    const visible = new Set([...this.state.items[run.itemId].originals.map(a => a.id), ...p.artifacts]);
    requireThat(p.presentation && p.artifacts.includes(p.presentation.fallback) && this.state.artifacts[p.presentation.fallback].mediaType === 'text/plain', 'readable text fallback required');
    for (const value of [p.presentation.thumbnail, p.presentation.component]) if (value) requireThat(p.artifacts.includes(value), 'presentation artifact not published');
    if (p.presentation.component) requireThat(this.state.artifacts[p.presentation.component].mediaType === 'text/html', 'component must be html');
    requireThat(Array.isArray(p.targets) && p.targets.length <= 1000, 'invalid targets');
    const keys = new Set<string>(); const targets: Target[] = [];
    for (const target of p.targets) {
      requireThat(typeof target.key === 'string' && target.key.length > 0 && target.key.length <= 100 && !keys.has(target.key), 'duplicate or invalid target key'); keys.add(target.key);
      requireThat(visible.has(target.artifact), 'target artifact not published'); const artifact = this.owned(run, target.artifact); const selector = target.selector;
      requireThat(selector && ['whole', 'time', 'text', 'fragment'].includes(selector.kind), 'unknown selector');
      if (selector.kind === 'time') requireThat(artifact.mediaType.startsWith('video/') && Number.isFinite(selector.startMs) && Number.isFinite(selector.endMs) && selector.startMs >= 0 && selector.endMs > selector.startMs, 'invalid time target');
      if (selector.kind === 'text') {
        requireThat(artifact.mediaType === 'text/plain' && Number.isSafeInteger(selector.start) && Number.isSafeInteger(selector.end) && selector.start >= 0 && selector.end > selector.start && typeof selector.quote === 'string', 'invalid text target');
        const text = await new Response(this.bytes(artifact)).text(); requireThat(text.slice(selector.start, selector.end) === selector.quote && selector.end <= text.length, 'text quote mismatch');
      }
      if (selector.kind === 'fragment') requireThat(typeof selector.scheme === 'string' && selector.scheme.length <= 200 && /^urn:[a-z0-9][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)+:v[1-9][0-9]*$/.test(selector.scheme) && typeof selector.value === 'string' && selector.value.trim().length > 0 && selector.value.length <= 4096, 'invalid namespaced fragment');
      // Object field ordering is transport detail, not annotation identity.
      const locator = selector.kind === 'whole' ? ['whole']
        : selector.kind === 'time' ? ['time', selector.startMs, selector.endMs]
        : selector.kind === 'text' ? ['text', selector.start, selector.end, selector.quote]
        : ['fragment', selector.scheme, selector.value];
      const targetId = 'target_' + createHash('sha256').update(JSON.stringify([run.itemId, target.artifact, target.key, locator])).digest('hex').slice(0, 24);
      targets.push({ ...target, id: targetId, itemId: run.itemId, generation: runId });
    }
    requireThat(Array.isArray(p.search) && p.search.length <= 1000 && p.search.every(entry => typeof entry.text === 'string' && entry.text.length <= 10000 && keys.has(entry.target)), 'search target must exist');
    await this.mutate(() => { const current = this.live(runId); current.publication = p; current.targets = targets; current.state = 'published'; this.state.items[run.itemId].activeGeneration = runId; });
    return this.context(run.itemId);
  }
  async fail(runId: string, error: unknown) { return this.mutate(() => { const run = this.state.runs[runId]; requireThat(run && run.state === 'staging', 'cannot fail completed generation'); run.state = 'failed'; run.error = String(error); }); }
  context(itemId: string): ViewContext {
    const item = this.state.items[itemId]; requireThat(item?.activeGeneration, 'item is not published'); const generation = clone(this.state.runs[item.activeGeneration]);
    if (!this.state.plugins[generation.plugin]?.active && generation.publication) delete generation.publication.presentation.component;
    const annotations = clone(this.state.annotations.filter(a => a.itemId === itemId));
    const current = new Set(generation.targets!.map(target => target.id));
    return { item: clone(item), generation, annotations, annotationStatus: Object.fromEntries(annotations.map(annotation => [annotation.id, current.has(annotation.target) ? 'current' : 'historical'])) }; 
  }
  search(query: string) {
    return Object.values(this.state.items).flatMap(item => {
      if (!item.activeGeneration) return []; const run = this.state.runs[item.activeGeneration];
      return run.publication!.search.filter(entry => entry.text.toLowerCase().includes(query.toLowerCase())).map(entry => ({ itemId: item.itemId, text: entry.text, target: clone(run.targets!.find(t => t.key === entry.target)!) }));
    });
  }
  resolveTarget(itemId: string, targetId: string): { target: Target; status: 'current' | 'historical' } {
    const current = this.context(itemId).generation.targets!.find(t => t.id === targetId);
    if (current) return { target: clone(current), status: 'current' };
    const historical = Object.values(this.state.runs).filter(run => run.itemId === itemId && run.state === 'published').flatMap(run => run.targets ?? []).find(t => t.id === targetId);
    requireThat(historical, 'target not found'); return { target: clone(historical), status: 'historical' };
  }
  targetStatus(itemId: string, targetId: string): 'current' | 'historical' { return this.resolveTarget(itemId, targetId).status; }
  async annotate(itemId: string, targetId: string, body: string, author: 'user' | 'agent' = 'user') {
    requireThat(typeof body === 'string' && body.trim().length > 0 && body.length <= 4000, 'invalid annotation');
    const valid = Object.values(this.state.runs).some(run => run.itemId === itemId && run.state === 'published' && run.targets?.some(t => t.id === targetId)); requireThat(valid, 'annotation target is not published for item');
    const annotation: Annotation = { id: id('note'), itemId, target: targetId, body, author };
    await this.mutate(() => { this.state.annotations.push(annotation); }); return clone(annotation);
  }
  visibleArtifact(itemId: string, artifactId: string, range?: ByteRange) {
    const item = this.state.items[itemId]; requireThat(item, 'unknown item'); const artifact = this.state.artifacts[artifactId]; requireThat(artifact?.itemId === itemId, 'foreign artifact');
    const published = Object.values(this.state.runs).find(run => run.id === artifact.generation && run.state === 'published' && run.publication?.artifacts.includes(artifactId));
    requireThat(artifact.generation === null || published, 'artifact is not published');
    requireThat(!published || this.state.plugins[published.plugin]?.active || published.publication?.presentation.component !== artifactId, 'component removed');
    return { artifact: clone(artifact), body: this.bytes(artifact, range) };
  }
  /** Called only from the trusted runtime bridge; x-run is injected by its scoped capability. */
  async capabilityFetch(request: Request): Promise<Response> {
    try {
      const runId = request.headers.get('x-run') ?? ''; const host = this.host(runId); const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname.startsWith('/read/')) {
        const range = url.searchParams.has('start') ? { start: Number(url.searchParams.get('start')), end: Number(url.searchParams.get('end')) } : undefined;
        return new Response(await host.read(decodeURIComponent(url.pathname.slice(6)), range));
      }
      if (request.method === 'PUT' && url.pathname === '/write') return Response.json(await host.write({ role: request.headers.get('x-role') ?? '', mediaType: request.headers.get('content-type') ?? '' }, request.body ?? streamText('')));
      if (request.method === 'POST' && url.pathname === '/transcribe') { const { original, profile } = await request.json() as any; return Response.json(await host.transcribe(original, profile)); }
      return new Response('unknown capability operation', { status: 400 });
    } catch (error) { return new Response(String(error), { status: 403 }); }
  }
}
