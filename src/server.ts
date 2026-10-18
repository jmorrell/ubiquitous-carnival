import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { FileStore } from './store';
import { createRunner } from './runner';
import { videoRegistration } from '../plugins/video';
import { parquetRegistration } from '../plugins/parquet';

const root = fileURLToPath(new URL('../', import.meta.url));
const store = await FileStore.open(process.env.DEMO_STORE ?? root + '.demo-store-core');
await store.install(videoRegistration); await store.install(parquetRegistration);
let items = store.items();
if (!items.some(item => item.originals[0].mediaType === 'video/webm')) {
  await store.intake({ kind: 'upload', filename: 'video.webm' }, 'video/webm', Readable.toWeb(createReadStream(root + 'fixtures/video.webm')) as ReadableStream<Uint8Array>);
  await store.intake({ kind: 'upload', filename: 'tiny.parquet' }, 'application/vnd.apache.parquet', Readable.toWeb(createReadStream(root + 'fixtures/tiny.parquet')) as ReadableStream<Uint8Array>);
  items = store.items();
}
const runner = await createRunner(store);
for (const item of items) if (!store.isPublished(item.itemId)) await runner.process(item.itemId, item.originals[0].mediaType === 'video/webm' ? 'video-viewer' : 'parquet-summary');
const videoId = items.find(item => item.originals[0].mediaType === 'video/webm')!.itemId;
const parquetId = items.find(item => item.originals[0].mediaType === 'application/vnd.apache.parquet')!.itemId;
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const itemId = url.searchParams.get('item') === 'parquet' ? parquetId : videoId;
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
