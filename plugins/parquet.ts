import { parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import type { Processor, ProcessorRegistration } from '../src/contract';
export const parquetRegistration: ProcessorRegistration = { id: 'parquet-summary', version: '0.1.0', accepts: ['application/vnd.apache.parquet'], grants: [] };
export const parquetProcessor: Processor = {
  async process(input, host) {
    if (input.originals.length !== 1 || input.originals[0].mediaType !== 'application/vnd.apache.parquet') throw new Error('Parquet summary requires exactly one supported original');
    const original = input.originals[0];
    const file = { byteLength: original.size, slice: async (start: number, end?: number) => new Response(await host.read(original.id, { start, end: end ?? original.size })).arrayBuffer() };
    // Default metadata prefetch is 512 KiB and would read this entire tiny fixture.
    // Footer-first access makes the selective byte-read claim measurable here.
    const metadata = await parquetMetadataAsync(file, { initialFetchSize: 8 });
    const rows = await parquetReadObjects({ file, metadata, columns: ['label', 'value'] });
    const lines = rows.map(row => `${row.label}: ${row.value}`); const text = lines.join('\n');
    const fallback = await host.write({ role: 'table-summary', mediaType: 'text/plain' }, new Blob([text]).stream());
    return [{ title: 'Parquet public summary', description: `${rows.length} rows; label and value selected. Secret column excluded.`, artifacts: [fallback.id], search: lines.map(text => ({ text, artifact: fallback.id })), presentation: { fallback: fallback.id } }];
  },
};
