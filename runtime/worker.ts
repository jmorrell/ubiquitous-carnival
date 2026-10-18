import { WorkerEntrypoint } from 'cloudflare:workers';

interface Env {
  LOADER: WorkerLoader;
  STORE: Fetcher;
  HOST_SECRET: string;
}
interface Scope { runId: string }

// This class is trusted host code. The child receives an RPC stub, never env,
// a storage binding, a credential, or authority to choose the run identity.
export class ScopedHost extends WorkerEntrypoint<Env, Scope> {
  async read(objectId: string, range?: { offset: number; length: number }): Promise<Response> {
    const url = new URL('http://fixture/read');
    url.searchParams.set('objectId', objectId);
    if (range) {
      url.searchParams.set('offset', String(range.offset));
      url.searchParams.set('length', String(range.length));
    }
    const response = await this.env.STORE.fetch(url, {
      headers: { 'x-run': this.ctx.props.runId },
    });
    if (!response.ok) throw new Error(await response.text());
    return response;
  }

  async write(body: ReadableStream<Uint8Array>): Promise<{ bytes: number; text: string }> {
    const response = await this.env.STORE.fetch('http://fixture/write', {
      method: 'PUT', headers: { 'x-run': this.ctx.props.runId }, body,
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }

  async derive(objectId: string): Promise<{ source: string; text: string }> {
    const response = await this.env.STORE.fetch('http://fixture/derive', {
      method: 'POST',
      headers: { 'x-run': this.ctx.props.runId, authorization: `Bearer ${this.env.HOST_SECRET}` },
      body: objectId,
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { code, runId, outboundControl } = await request.json() as {
      code: string; runId: string; outboundControl?: boolean;
    };
    const exports = ctx.exports as unknown as {
      ScopedHost(options: { props: Scope }): Fetcher;
    };
    const worker = env.LOADER.load({
      compatibilityDate: '2026-10-01',
      mainModule: 'probe.js',
      modules: { 'probe.js': code },
      env: { HOST: exports.ScopedHost({ props: { runId } }) },
      ...(outboundControl ? {} : { globalOutbound: null }),
    });
    const plugin = worker.getEntrypoint() as unknown as {
      run(): Promise<unknown>; readAfterRevocation(): Promise<unknown>;
    };
    const first = await plugin.run();
    await env.STORE.fetch('http://fixture/revoke', { method: 'POST', headers: { 'x-run': runId } });
    const revoked = await plugin.readAfterRevocation();
    return Response.json({ first, revoked });
  },
};
