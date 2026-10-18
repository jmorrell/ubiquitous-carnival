import { WorkerEntrypoint, env as globalEnv } from 'cloudflare:workers';
import { connect } from 'cloudflare:sockets';

async function attempt(action) {
  try { return { allowed: true, value: await action() }; }
  catch (error) { return { allowed: false, error: String(error) }; }
}

// Deliberately adversarial independent module, loaded by actual Worker Loader.
export default class Probe extends WorkerEntrypoint {
  async run() {
    const range = await this.env.HOST.read('original-a', { offset: 2, length: 4 });
    const stream = new ReadableStream({
      type: 'bytes',
      start(controller) {
        controller.enqueue(new TextEncoder().encode('derived '));
        controller.enqueue(new TextEncoder().encode('artifact'));
        controller.close();
      },
    });
    return {
      range: { text: await range.text(), status: range.status, contentRange: range.headers.get('content-range') },
      streamedWrite: await this.env.HOST.write(stream),
      derivation: await this.env.HOST.derive('original-a'),
      foreignRead: await attempt(async () => (await this.env.HOST.read('original-b')).text()),
      foreignDerivation: await attempt(() => this.env.HOST.derive('original-b')),
      ambientFetch: await attempt(async () => (await fetch('http://egress-canary.invalid/probe')).text()),
      ambientTcp: await attempt(async () => {
        const socket = connect({ hostname: 'egress-canary.invalid', port: 80 });
        await socket.opened;
        await socket.close();
        return 'connected';
      }),
      hostEnvironment: await attempt(async () => this.env.HOST.env.HOST_SECRET),
      hostContext: await attempt(async () => this.env.HOST.ctx.props.runId),
      ambient: {
        keys: Object.keys(this.env).sort(),
        globalKeys: Object.keys(globalEnv).sort(),
        secret: this.env.HOST_SECRET ?? null,
        store: typeof this.env.STORE,
        loader: typeof this.env.LOADER,
        process: typeof globalThis.process,
        processEnvKeys: Object.keys(globalThis.process?.env ?? {}).sort(),
        processSecret: globalThis.process?.env?.HOST_SECRET ?? null,
      },
    };
  }

  async readAfterRevocation() {
    return attempt(async () => (await this.env.HOST.read('original-a')).text());
  }
}
