import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDynamicRuntime } from '../runtime/dynamic-runtime';
import type { ArtifactId, Processor, Publication, UrlAcquirer } from './contract';
import { FileStore } from './store';

/** In-process harness for semantic tests; this function is NOT an isolation boundary. */
export async function runInProcess(store: FileStore, inputId: string, plugin: string, processor: Processor) {
  const run = await store.begin(inputId, plugin);
  try { const result = await processor.process(store.input(run.id), store.host(run.id)); return await store.publish(run.id, result); }
  catch (error) { await store.fail(run.id, error); throw error; }
}

/** In-process acquisition harness; this function is NOT an isolation boundary. */
export async function runAcquisitionInProcess(store: FileStore, url: string, plugin: string, acquirer: UrlAcquirer) {
  const run = await store.beginAcquisition(url, plugin);
  try { return await store.completeAcquisition(run.id, await acquirer.acquire(run.url, store.acquisitionHost(run.id))); }
  catch (error) { await store.failAcquisition(run.id); throw error; }
}

const entrypoints = {
  'video-viewer': '../plugins/video-worker.ts',
  'parquet-summary': '../plugins/parquet-worker.ts',
  'image-gallery': '../plugins/gallery-worker.ts',
  'photo-items': '../plugins/photo-items-worker.ts',
} as const;
const acquisitionEntrypoints = { 'url-download': '../plugins/download-worker.ts' } as const;

export async function createRunner(store: FileStore) {
  const runtime = await createDynamicRuntime(request => store.capabilityFetch(request));
  const compiled = new Map<string, string>();
  async function compile(entrypoint: string) {
    let source = compiled.get(entrypoint);
    if (!source) {
      const entry = fileURLToPath(new URL(entrypoint, import.meta.url));
      const result = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'], loader: { '.html': 'text' } });
      source = result.outputFiles[0].text; compiled.set(entrypoint, source);
    }
    return source;
  }
  return {
    async process(inputId: string, plugin: keyof typeof entrypoints) {
      const source = await compile(entrypoints[plugin]);
      const run = await store.begin(inputId, plugin, createHash('sha256').update(source).digest('hex'));
      try {
        const publications = await runtime.execute<Publication[]>(source, { runId: run.id, input: store.input(run.id) });
        return await store.publish(run.id, publications);
      } catch (error) { await store.fail(run.id, error); throw error; }
    },
    async acquire(url: string, plugin: keyof typeof acquisitionEntrypoints) {
      const source = await compile(acquisitionEntrypoints[plugin]);
      const run = await store.beginAcquisition(url, plugin);
      try {
        const artifacts = await runtime.execute<ArtifactId[]>(source, { runId: run.id, input: run.url, operation: 'acquire' });
        return await store.completeAcquisition(run.id, artifacts);
      } catch (error) { await store.failAcquisition(run.id); throw error; }
    },
    dispose: () => runtime.dispose(),
  };
}
