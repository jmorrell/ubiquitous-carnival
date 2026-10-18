/** Experimental core contract. The host validates these structures at runtime. IDs are host-issued. */
export type ArtifactId = string;
export type ItemId = string;
export type Source =
  | { kind: "url"; url: string }
  | { kind: "upload" }
  | { kind: "document" };
export interface Artifact {
  id: ArtifactId;
  itemId: ItemId;
  role: string;
  mediaType: string;
  size: number;
  sha256: string;
}
/** Per-file provenance labels, never paths into the host filesystem. */
export interface OriginalArtifact extends Artifact { filename?: string; relativePath?: string }
/** Ingestion has completed: every original already has stored bytes and host-issued identity. */
export interface Input { itemId: ItemId; source: Source; originals: readonly OriginalArtifact[] }
export interface Item extends Input {}
/** End is exclusive. */
export interface ByteRange { start: number; end: number }
/** Search text resolves to a published artifact, with no host-managed location identity. */
export interface SearchEntry { text: string; artifact: ArtifactId }
export interface Publication {
  title: string;
  description: string;
  artifacts: ArtifactId[];
  search: SearchEntry[];
  presentation: { fallback: ArtifactId; thumbnail?: ArtifactId; component?: ArtifactId };
}
export interface TranscriptSegment { startMs: number; endMs: number; text: string }
/** Capabilities exist only during one processing call, never expose a bucket or Env. */
export interface ProcessingHost {
  read(artifact: ArtifactId, range?: ByteRange): Promise<ReadableStream<Uint8Array>>;
  write(meta: { role: string; mediaType: string }, body: ReadableStream<Uint8Array>): Promise<Artifact>;
  /** Grant required. Provider configuration and credentials stay in the host. */
  transcribe(original: ArtifactId): Promise<TranscriptSegment[]>;
}
/** The single executable backend hook. Recognition is declarative and host-owned. */
export interface Processor { process(input: Input, host: ProcessingHost): Promise<Publication> }
export interface ProcessorRegistration {
  id: string;
  version: string;
  accepts: readonly string[];
  grants: readonly "transcribe"[];
}
/** An isolated component can read this item's published artifacts. */
export type ViewRequest = { id: string; method: "read"; artifact: ArtifactId; range?: ByteRange };
/** Wire replies on the authenticated MessagePort. Bytes here are bounded browser-fixture buffers. */
export type ViewReply =
  | { id: string; ok: true; bytes: ArrayBuffer; mediaType: string }
  | { id: string; ok: false; error: string };
export interface ViewContext { item: Item; publication: Publication }
export type ComponentContext = ViewContext;
