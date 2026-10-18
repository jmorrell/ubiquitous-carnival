import { WorkerEntrypoint } from 'cloudflare:workers';
import { parquetProcessor } from './parquet';
import { httpHost } from '../src/http-host';
import type { Input } from '../src/contract';
export default class extends WorkerEntrypoint<{ HOST: { fetch(request: Request): Promise<Response> } }> {
  process(input: Input) { return parquetProcessor.process(input, httpHost(this.env.HOST)); }
}
