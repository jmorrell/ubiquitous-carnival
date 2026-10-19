/** Experimental core contract. The host validates these structures at runtime. IDs are host-issued. */
export type ArtifactId = string;
export type InputId = string;
export type ItemId = string;
/** Recorded provenance. File paths are labels, never paths into the host filesystem. */
export type ArtifactOrigin =
  | { kind: "none" }
  | { kind: "url"; url: string }
  | { kind: "file"; relativePath: string };
export interface Artifact {
  id: ArtifactId;
  role: string;
  mediaType: string;
  size: number;
  sha256: string;
  origin: ArtifactOrigin;
}
/** Ingestion has completed: every original already has stored bytes and host-issued identity. */
export interface Input { inputId: InputId; originals: readonly Artifact[] }
/** A published item exposes only the artifacts explicitly selected by its publication. */
export interface Item { itemId: ItemId; artifacts: readonly Artifact[] }
/** Obtaining content is implementation-specific; the returned artifacts become one complete Input. */
export type Acquire = (
  url: string,
  write: (meta: { mediaType: string; origin: ArtifactOrigin }, body: ReadableStream<Uint8Array>) => Promise<Artifact>,
) => Promise<Artifact[]>;
export interface AcquisitionRegistration {
  id: string;
  version: string;
  /** Exact HTTP(S) origins used for host-owned handler selection. */
  urlOrigins: readonly string[];
}
/** End is exclusive. */
export interface ByteRange { start: number; end: number }
/** Explicit plugin-supplied index text; the host does not interpret artifact contents. */
export interface SearchEntry { text: string; artifact: ArtifactId }
export interface Publication {
  title: string;
  description: string;
  /** Complete visible set: selected originals and/or processing outputs. References may be shared. */
  artifacts: ArtifactId[];
  search: SearchEntry[];
  presentation: { fallback: ArtifactId; thumbnail?: ArtifactId; component?: ArtifactId };
}
/** Artifact processing follows acquisition or direct ingestion. Recognition is host-owned. */
export type Process = (
  input: Input,
  artifacts: {
    read(artifact: ArtifactId, range?: ByteRange): Promise<ReadableStream<Uint8Array>>;
    write(meta: { role: string; mediaType: string }, body: ReadableStream<Uint8Array>): Promise<Artifact>;
  },
) => Promise<Publication[]>;
export interface ProcessorRegistration {
  id: string;
  version: string;
  accepts: readonly string[];
}
/** An isolated component can read this item's published artifacts. */
export type ViewRequest = { id: string; method: "read"; artifact: ArtifactId; range?: ByteRange };
/** Wire replies on the authenticated MessagePort. Bytes here are bounded browser-fixture buffers. */
export type ViewReply =
  | { id: string; ok: true; bytes: ArrayBuffer; mediaType: string }
  | { id: string; ok: false; error: string };
export interface ViewContext { item: Item; publication: Publication }
export type ComponentContext = ViewContext;
