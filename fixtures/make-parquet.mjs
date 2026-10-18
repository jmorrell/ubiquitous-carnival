// Minimal Parquet v1 writer for this fixture only: required UTF8 BYTE_ARRAY, uncompressed.
// Field IDs/types below follow parquet-format thrift. Regeneration is deterministic/offline.
import { writeFileSync } from 'node:fs';
const T = { I32: 5, I64: 6, BINARY: 8, LIST: 9, STRUCT: 12 };
const varint = value => { let n = BigInt(value); const out = []; do { const byte = Number(n & 127n); n >>= 7n; out.push(byte | (n ? 128 : 0)); } while (n); return Buffer.from(out); };
const integer = n => varint(BigInt(n) * 2n);
const binary = value => { const b = Buffer.from(value); return Buffer.concat([varint(b.length), b]); };
const list = (type, entries) => Buffer.concat([entries.length < 15 ? Buffer.from([(entries.length << 4) | type]) : Buffer.concat([Buffer.from([0xf0 | type]), varint(entries.length)]), ...entries]);
const struct = fields => { let previous = 0; const out = []; for (const [field, type, value] of fields) { const delta = field - previous; out.push(delta > 0 && delta < 16 ? Buffer.from([(delta << 4) | type]) : Buffer.concat([Buffer.from([type]), integer(field)]), value); previous = field; } return Buffer.concat([...out, Buffer.from([0])]); };
const i32 = (field, value) => [field, T.I32, integer(value)];
const i64 = (field, value) => [field, T.I64, integer(value)];
const str = (field, value) => [field, T.BINARY, binary(value)];
const columns = { label: ['Harbor', 'Forest'], value: ['12', '34'], secret: ['SECRET-DO-NOT-INDEX-ALPHA', 'SECRET-DO-NOT-INDEX-BETA'] };
let offset = 4; const pages = []; const chunks = []; const layout = { columns: {} };
for (const [name, values] of Object.entries(columns)) {
  const data = Buffer.concat(values.map(value => { const bytes = Buffer.from(value); const length = Buffer.alloc(4); length.writeUInt32LE(bytes.length); return Buffer.concat([length, bytes]); }));
  const pageHeader = struct([i32(1, 0), i32(2, data.length), i32(3, data.length), [5, T.STRUCT, struct([i32(1, values.length), i32(2, 0), i32(3, 3), i32(4, 3)])]]);
  const page = Buffer.concat([pageHeader, data]); pages.push(page);
  layout.columns[name] = { start: offset, end: offset + page.length, dataStart: offset + pageHeader.length, dataEnd: offset + page.length };
  chunks.push(struct([i64(2, offset), [3, T.STRUCT, struct([i32(1, 6), [2, T.LIST, list(T.I32, [integer(0), integer(3)])], [3, T.LIST, list(T.BINARY, [binary(name)])], i32(4, 0), i64(5, 2), i64(6, page.length), i64(7, page.length), i64(9, offset)])]])); offset += page.length;
}
const schema = [struct([str(4, 'schema'), i32(5, 3)]), ...Object.keys(columns).map(name => struct([i32(1, 6), i32(3, 0), str(4, name), i32(6, 0)]))];
const metadata = struct([i32(1, 1), [2, T.LIST, list(T.STRUCT, schema)], i64(3, 2), [4, T.LIST, list(T.STRUCT, [struct([[1, T.LIST, list(T.STRUCT, chunks)], i64(2, offset - 4), i64(3, 2)])])], str(6, 'extension-point-experiment fixture')]);
const footerLength = Buffer.alloc(4); footerLength.writeUInt32LE(metadata.length);
writeFileSync(new URL('./tiny.parquet', import.meta.url), Buffer.concat([Buffer.from('PAR1'), ...pages, metadata, footerLength, Buffer.from('PAR1')]));

layout.footerStart = offset; layout.byteLength = offset + metadata.length + 8;
writeFileSync(new URL('./tiny-layout.json', import.meta.url), JSON.stringify(layout, null, 2) + '\n');
