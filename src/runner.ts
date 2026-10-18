import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDynamicRuntime } from '../runtime/dynamic-runtime';
import type { Processor, Publication } from './contract';
import { FileStore } from './store';

/** In-process harness for semantic tests; this function is NOT an isolation boundary. */
export async function runInProcess(store: FileStore, inputId: string, plugin: string, processor: Processor) {
  const run = await store.begin(inputId, plugin);
  try { const result = await processor.process(store.input(run.id), store.host(run.id)); return await store.publish(run.id, result); }
  catch (error) { await store.fail(run.id, error); throw error; }
}

const entrypoints = {
  'video-viewer': '../plugins/video-worker.ts',
  'parquet-summary': '../plugins/parquet-worker.ts',
  'image-gallery': '../plugins/gallery-worker.ts',
  'photo-items': '../plugins/photo-items-worker.ts',
} as const;

export async function createRunner(store: FileStore) {
  const runtime = await createDynamicRuntime(request => store.capabilityFetch(request));
  const compiled = new Map<string, string>();
  return {
    async process(inputId: string, plugin: keyof typeof entrypoints) {
      let source = compiled.get(plugin);
      if (!source) {
        const entry = fileURLToPath(new URL(entrypoints[plugin], import.meta.url));
        const result = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'], loader: { '.html': 'text' } });
        source = result.outputFiles[0].text; compiled.set(plugin, source);
      }
      const run = await store.begin(inputId, plugin, createHash('sha256').update(source).digest('hex'));
      try {
        const publications = await runtime.execute<Publication[]>(source, { runId: run.id, input: store.input(run.id) });
        return await store.publish(run.id, publications);
      } catch (error) { await store.fail(run.id, error); throw error; }
    },
    dispose: () => runtime.dispose(),
  };
}
