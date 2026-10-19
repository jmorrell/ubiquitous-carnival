import { WorkerEntrypoint } from 'cloudflare:workers';
import { processPhotos } from './photo-items';
import { httpHost } from '../src/http-host';
import type { Input } from '../src/contract';
export default class extends WorkerEntrypoint<{ HOST: { fetch(request: Request): Promise<Response> } }> {
  process(input: Input) { return processPhotos(input, httpHost(this.env.HOST)); }
}
