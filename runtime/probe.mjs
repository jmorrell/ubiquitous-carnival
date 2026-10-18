import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, Response, convertV4MiniflareOptions } from 'miniflare';

const directory = new URL('./', import.meta.url);
const code = await readFile(new URL('untrusted-probe.js', directory), 'utf8');
const built = await build({
  entryPoints: [new URL('worker.ts', directory).pathname], bundle: true,
  format: 'esm', platform: 'neutral', external: ['cloudflare:*'], write: false,
});

// These bytes and paid-service outputs are synthetic. The Worker Loader,
// separate V8 isolate, RPC serialization and egress denial are real workerd.
const secret = 'synthetic-host-credential-do-not-copy-to-plugin';
const objects = new Map([
  ['original-a', '0123456789'],
  ['original-b', 'foreign-item-private-bytes'],
]);
const runs = new Map();
const audit = [];
let outboundCalls = 0;

async function store(request) {
  const url = new URL(request.url);
  const runId = request.headers.get('x-run');
  const run = runs.get(runId);
  if (!run) return new Response('unknown run', { status: 403 });
  if (url.pathname === '/revoke') {
    run.active = false;
    return new Response('revoked');
  }
  if (!run.active) return new Response('run revoked', { status: 403 });
  if (url.pathname === '/read') {
    const objectId = url.searchParams.get('objectId');
    audit.push({ operation: 'read', runId, objectId });
    if (objectId !== run.objectId) return new Response('object outside capability', { status: 403 });
    const source = objects.get(objectId);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const length = Number(url.searchParams.get('length') ?? source.length);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || offset + length > source.length) {
      return new Response('invalid range', { status: 416 });
    }
    return new Response(source.slice(offset, offset + length), {
      status: 206,
      headers: { 'content-range': `bytes ${offset}-${offset + length - 1}/${source.length}` },
    });
  }
  if (url.pathname === '/write') {
    assert.equal(request.method, 'PUT');
    let text = '';
    const decoder = new TextDecoder();
    let bytes = 0;
    for await (const chunk of request.body) {
      bytes += chunk.byteLength;
      if (bytes > 1000) return new Response('quota exceeded', { status: 413 });
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
    audit.push({ operation: 'write', runId, bytes });
    return Response.json({ text, bytes });
  }
  if (url.pathname === '/derive') {
    const objectId = await request.text();
    if (objectId !== run.objectId) return new Response('object outside capability', { status: 403 });
    assert.equal(request.headers.get('authorization'), `Bearer ${secret}`);
    audit.push({ operation: 'derive', runId, objectId, credentialValidated: true });
    return Response.json({ source: objectId, text: 'controlled transcript fixture' });
  }
  return new Response('unknown operation', { status: 404 });
}

const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true,
  script: built.outputFiles[0].text,
  compatibilityDate: '2026-10-01',
  workerLoaders: { LOADER: {} },
  bindings: { HOST_SECRET: secret },
  serviceBindings: { STORE: store },
  outboundService: async () => {
    outboundCalls++;
    return new Response('ambient-egress-canary');
  },
}));

try {
  async function execute(runId, outboundControl = false) {
    runs.set(runId, { objectId: 'original-a', active: true });
    const response = await mf.dispatchFetch('http://host/probe', {
      method: 'POST', body: JSON.stringify({ code, runId, outboundControl }),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return JSON.parse(text);
  }

  // Establish that denied egress is not merely a failed network or DNS lookup.
  const control = await execute('control', true);
  assert.deepEqual(control.first.ambientFetch, { allowed: true, value: 'ambient-egress-canary' });
  const before = outboundCalls;
  const result = await execute('isolated');
  assert.deepEqual(result.first.range, { text: '2345', status: 206, contentRange: 'bytes 2-5/10' });
  assert.deepEqual(result.first.streamedWrite, { text: 'derived artifact', bytes: 16 });
  assert.deepEqual(result.first.derivation, { source: 'original-a', text: 'controlled transcript fixture' });
  for (const attack of ['foreignRead', 'foreignDerivation', 'ambientFetch', 'ambientTcp', 'hostEnvironment', 'hostContext']) {
    assert.equal(result.first[attack].allowed, false, `${attack} escaped: ${JSON.stringify(result.first[attack])}`);
  }
  assert.match(result.first.foreignRead.error, /outside capability/);
  assert.match(result.first.ambientFetch.error, /not permitted to access the internet/);
  assert.match(result.first.ambientTcp.error, /not permitted to access the internet/);
  assert.match(result.revoked.error, /run revoked/);
  assert.equal(result.revoked.allowed, false);
  assert.deepEqual(result.first.ambient, {
    keys: ['HOST'], globalKeys: ['HOST'], secret: null,
    store: 'undefined', loader: 'undefined', process: 'object',
    processEnvKeys: [], processSecret: null,
  });
  assert.equal(outboundCalls, before, 'isolated child reached outbound canary');
  assert.equal(JSON.stringify(result).includes(secret), false);
  const report = {
    runtime: 'workerd 1.20261012.1 through miniflare 5.20261012.1-beta',
    observedAt: new Date().toISOString(),
    controlFetch: control.first.ambientFetch,
    isolated: result,
    outboundCallsDuringIsolatedProbe: outboundCalls - before,
    audit: audit.filter(entry => entry.runId === 'isolated'),
  };
  await writeFile(new URL('observed.json', directory), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  console.log('PASS: real Dynamic Worker capability, revocation, RPC streams and ambient egress probes');
} finally {
  await mf.dispose();
}
