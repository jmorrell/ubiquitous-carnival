/** Experimental v0. The host validates these structures at runtime. IDs are host-issued. */
export type ArtifactId = string;
export type ItemId = string;
export type TargetId = string;
export type Source =
  | { kind: "url" | "capture"; url: string }
  | { kind: "upload"; filename: string }
  | { kind: "document"; author: "user" | "agent" };
export interface Artifact {
  id: ArtifactId;
  itemId: ItemId;
  generation: string | null;
  role: string;
  mediaType: string;
  size: number;
  sha256: string;
}
export interface Input { itemId: ItemId; source: Source; originals: readonly Artifact[] }
/** End is exclusive. */
export interface ByteRange { start: number; end: number }
export type Selector =
  | { kind: "whole" }
  | { kind: "time"; startMs: number; endMs: number }
  | { kind: "text"; start: number; end: number; quote: string }
  /** Inert locator with an explicitly versioned namespace; its renderer validates domain semantics. */
  | { kind: "fragment"; scheme: string; value: string };
export interface TargetDraft { key: string; artifact: ArtifactId; selector: Selector }
export interface Target extends TargetDraft { id: TargetId; itemId: ItemId; generation: string }
/** target refers to a TargetDraft.key in this publication, not a global target ID. */
export interface SearchEntry { text: string; target: string }
export interface Publication {
  title: string;
  description: string;
  artifacts: ArtifactId[];
  targets: TargetDraft[];
  search: SearchEntry[];
  presentation: { fallback: ArtifactId; thumbnail?: ArtifactId; component?: ArtifactId };
}
export interface TranscriptSegment { startMs: number; endMs: number; text: string }
/** Host capabilities: scoped to a live generation, never a bucket or Env. */
export interface ProcessingHost {
  read(artifact: ArtifactId, range?: ByteRange): Promise<ReadableStream<Uint8Array>>;
  write(meta: { role: string; mediaType: string }, body: ReadableStream<Uint8Array>): Promise<Artifact>;
  /** Grant required. Profile identifies provider/model/options; credentials stay in the host. */
  transcribe(original: ArtifactId, profile: "v1" | "v2"): Promise<TranscriptSegment[]>;
}
/** The single executable backend hook. Recognition is declarative and host-owned. */
export interface Processor { process(input: Input, host: ProcessingHost): Promise<Publication> }
export interface ProcessorRegistration {
  id: string;
  version: string;
  accepts: readonly string[];
  grants: readonly "transcribe"[];
}
export interface Generation {
  id: string;
  itemId: ItemId;
  plugin: string;
  version: string;
  /** Host digest of the actual bundled Dynamic Worker source; absent in the semantic harness. */
  codeSha256?: string;
  state: "staging" | "failed" | "published";
  publication?: Publication;
  targets?: Target[];
}
export interface Item extends Input { activeGeneration?: string }
export interface Annotation { id: string; itemId: ItemId; target: TargetId; body: string; author: "user" | "agent" }
/** Frontend requests propose user actions; only host UI confirmation commits a note. */
export type ViewRequest =
  | { id: string; method: "read"; artifact: ArtifactId; range?: ByteRange }
  | { id: string; method: "proposeAnnotation"; target: TargetId; body: string };
/** Wire replies on the authenticated MessagePort. Bytes here are bounded browser-fixture buffers. */
export type ViewReply =
  | { id: string; ok: true; bytes: ArrayBuffer; mediaType: string }
  | { id: string; ok: true; value: "pending-host-confirmation" }
  | { id: string; ok: false; error: string };
export interface ViewContext {
  item: Item;
  generation: Generation;
  annotations: Annotation[];
  /** Derived by the host; a retired derivative is never silently re-anchored. */
  annotationStatus: Record<string, "current" | "historical">;
}

/** Only these fields cross into the isolated component; existing notes stay in the host. */
export type ComponentContext = Pick<ViewContext, "item" | "generation">;
