import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { FileStore } from './store';
import { createRunner } from './runner';
import { videoRegistration } from '../plugins/video';
import { parquetRegistration } from '../plugins/parquet';
import { photoItemsRegistration } from '../plugins/photo-items';

const root = fileURLToPath(new URL('../', import.meta.url));
const store = await FileStore.open(process.env.DEMO_STORE ?? root + '.demo-store-artifacts');
await store.install(videoRegistration); await store.install(parquetRegistration); await store.install(photoItemsRegistration);
const runner = await createRunner(store);
async function demoItem(filename: string, mediaType: string, plugin: 'video-viewer' | 'parquet-summary') {
  const input = store.inputs().find(input => input.originals.length === 1 && input.originals[0].mediaType === mediaType)
    ?? await store.intake([{ origin: { kind: 'file', relativePath: filename }, mediaType, body: Readable.toWeb(createReadStream(root + 'fixtures/' + filename)) as ReadableStream<Uint8Array> }]);
  const results = store.isProcessed(input.inputId) ? store.results(input.inputId) : await runner.process(input.inputId, plugin);
  return results[0].item.itemId;
}
const videoId = await demoItem('video.webm', 'video/webm', 'video-viewer');
const parquetId = await demoItem('tiny.parquet', 'application/vnd.apache.parquet', 'parquet-summary');
const photos = store.inputs().find(input => input.originals.length === 2 && input.originals.every(original => original.mediaType === 'image/svg+xml'))
  ?? await store.intake(['blue.svg', 'day-2/green.svg'].map(relativePath => ({
    origin: { kind: 'file' as const, relativePath: 'photos/' + relativePath }, mediaType: 'image/svg+xml',
    body: Readable.toWeb(createReadStream(root + 'fixtures/gallery/' + relativePath)) as ReadableStream<Uint8Array>,
  })));
const photoItems = store.isProcessed(photos.inputId) ? store.results(photos.inputId) : await runner.process(photos.inputId, 'photo-items');
const demoItems = new Map([['video', videoId], ['parquet', parquetId], ...photoItems.map((context, index) => [`photo-${index + 1}`, context.item.itemId] as const)]);
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const itemId = demoItems.get(url.searchParams.get('item') ?? 'video');
    if (!itemId) throw new Error('Unknown demo item');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/host.js')) {
      response.setHeader('Content-Type', url.pathname === '/' ? 'text/html' : 'text/javascript');
      response.end(await readFile(root + (url.pathname === '/' ? 'browser/index.html' : 'browser/host.js'))); return;
    }
    if (request.method === 'GET' && url.pathname === '/api/context') {
      const context = store.context(itemId);
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(context)); return;
    }
    if (request.method === 'GET' && url.pathname === '/api/search') {
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(store.search(url.searchParams.get('q') ?? ''))); return;
    }
    if (request.method === 'GET' && url.pathname.startsWith('/api/artifacts/')) {
      const artifactId = decodeURIComponent(url.pathname.slice('/api/artifacts/'.length));
      const raw = request.headers.range; let range;
      if (raw) { const match = /^bytes=(\d+)-(\d+)$/.exec(raw); if (!match) throw new Error('invalid range'); range = { start: Number(match[1]), end: Number(match[2]) + 1 }; }
      const { artifact, body } = store.visibleArtifact(itemId, artifactId, range);
      response.setHeader('Content-Type', artifact.mediaType); response.setHeader('Accept-Ranges', 'bytes');
      response.setHeader('Content-Length', range ? range.end - range.start : artifact.size);
      if (range) { response.statusCode = 206; response.setHeader('Content-Range', `bytes ${range.start}-${range.end - 1}/${artifact.size}`); }
      // Every artifact is untrusted, including active MIME types with parameters.
      // Fetching bytes remains allowed; navigating to an artifact never grants host-origin script authority.
      response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      Readable.fromWeb(body as any).pipe(response); return;
    }
    response.statusCode = 404; response.end('not found');
  } catch (error) { response.statusCode = 403; response.end(String(error)); }
});
server.listen(4173, '127.0.0.1', () => console.log('Demo with actual Dynamic Workers: http://127.0.0.1:4173'));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { server.close(); void runner.dispose().finally(() => process.exit(0)); });
