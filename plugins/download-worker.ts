import { WorkerEntrypoint } from 'cloudflare:workers';
import { downloadAcquirer } from './download';
import { httpAcquisitionHost } from '../src/http-acquisition-host';
export default class extends WorkerEntrypoint<{ HOST: { fetch(request: Request): Promise<Response> } }> {
  acquire(url: string) { return downloadAcquirer.acquire(url, httpAcquisitionHost(this.env.HOST)); }
}
