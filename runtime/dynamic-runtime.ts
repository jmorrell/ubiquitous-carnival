import { Miniflare, Response as MiniflareResponse, convertV4MiniflareOptions } from 'miniflare';

const hostSource = `
import { WorkerEntrypoint } from 'cloudflare:workers';

export class ScopedHost extends WorkerEntrypoint {
  async fetch(request) {
    // Scope comes from the trusted caller, never from child request headers.
    const headers = new Headers(request.headers);
    headers.set('x-run', this.ctx.props.runId);
    return this.env.STORE.fetch(new Request(request, { headers }));
  }
}

export default {
  async fetch(request, env, ctx) {
    const { source, context } = await request.json();
    if (typeof context.runId !== 'string') throw new Error('runId required');
    const operation = context.operation ?? 'process';
    if (operation !== 'process' && operation !== 'acquire') throw new Error('invalid worker operation');
    if (operation === 'acquire' && typeof context.input !== 'string') throw new Error('acquisition URL required');
    const plugin = env.LOADER.load({
      compatibilityDate: '2026-10-01',
      mainModule: 'plugin.js',
      modules: { 'plugin.js': source },
      env: { HOST: ctx.exports.ScopedHost({ props: { runId: context.runId } }) },
      globalOutbound: null,
    }).getEntrypoint();
    return Response.json(await (operation === 'acquire' ? plugin.acquire(context.input) : plugin.process(context.input)));
  }
};
`;

/** Actual workerd transport; STORE must enforce every operation's run/object policy. */
export async function createDynamicRuntime(storeFetch: (request: Request) => Promise<Response>) {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: hostSource,
    compatibilityDate: '2026-10-01',
    workerLoaders: { LOADER: {} },
    serviceBindings: {
      STORE: async request => {
        const response = await storeFetch(request as unknown as Request);
        return new MiniflareResponse(response.body as never, {
          status: response.status, headers: Array.from(response.headers.entries()),
        });
      },
    },
  }));
  await mf.ready;
  return {
    async execute<Result, Input = unknown>(source: string, context: { runId: string; input: Input; operation?: 'process' | 'acquire' }): Promise<Result> {
      const response = await mf.dispatchFetch('http://trusted-runner/execute', {
        method: 'POST', body: JSON.stringify({ source, context }),
      });
      if (!response.ok) throw new Error(`Dynamic Worker failed (${response.status}): ${await response.text()}`);
      return await response.json() as Result;
    },
    async dispose() { await mf.dispose(); },
  };
}
