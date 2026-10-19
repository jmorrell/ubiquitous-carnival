# Magpie: the core extension flow

Two extension points separate obtaining content from interpreting it: **URL → acquire artifacts**, then **artifacts → process → published items**. Uploads and browser captures enter directly at the artifact stage. The host owns storage and publication; an optional isolated component supplies each item's detail view.

## The flow

![A URL enters an acquisition extension, while files and browser captures bypass acquisition. The host completes a stored artifact Input, then an artifact processor returns publication manifests. The host atomically creates items with explicit artifact membership.](docs/diagrams/core-flow.png)

1. **Acquire or ingest.** For a URL alone, a selected acquisition extension obtains content and stages artifacts through the host. Files, pasted text, and already-downloaded browser captures go straight to ingestion. Either path produces `Input` only when every selected artifact's bytes are stored. No published item exists yet.
2. **Select.** Every original must match one of the processor's declared MIME types. If several processors match, require an explicit choice.
3. **Process.** Call `process(input, { read, write })` in a Dynamic Worker. This function reads bytes, writes files in its chosen formats, and supplies the strings to index.
4. **Publish.** The processor returns one or more publication manifests. The host validates every manifest, assigns item IDs, and saves the entire set atomically. A failed set exposes no partial items or search entries.
5. **View.** The host displays readable text. A custom component can read only the artifacts explicitly included in that item's publication through a broker.

An input can complete processing once, producing one or more items. Each item has one publication. Reprocessing, saved drafts, and annotations are outside this version. The host uses a temporary execution scope while processing; it is not a saved document or an editable result. Search entries identify the resulting item and one of its published artifacts, with no durable location/selector model.

## URL acquisition is a separate extension point

The core is **a URL in, an array of artifacts out**. An acquirer might fetch HTML and images, call an API, or use a browser. Network access, credentials, browser setup, and future permission restrictions belong to its execution environment; this contract does not model them.

```ts
const artifacts = await acquire(url, write);
// For example: [html, image1, image2]
```

`acquire` is a plain async function. Its `write(metadata, bytes)` argument is another function, storing one artifact's bytes and returning its host-issued descriptor. Each artifact has its own origin. The host validates the returned array and commits one complete `Input`; a failure exposes no partial input. Acquisition produces originals, and a later `process` function decides what to publish.

The host selects an acquirer by its declared HTTP(S) URL origins, with an explicit choice when several match. These origins select a handler; they do not restrict which URLs that handler can fetch.

The [download example](plugins/download.ts) uses ordinary `fetch` and returns a one-artifact array. A host with that acquirer installed can run the stages independently for an image URL:

```ts
const input = await runner.acquire(url, "url-download");
const items = await runner.process(input.inputId, "image-gallery");
```

The [integration test](tests/acquisition-flow.test.ts) acquires HTML plus image resources from local HTTP fixtures and passes the resulting artifact array to processing. It also submits equivalent captured bytes directly, showing that URL provenance does not trigger a fetch. A webpage captured in the browser follows this same bypass, including any resources supplied with it.

## Ingestion produces Input

`Input` remains artifact-only. URL acquisition, browser capture, direct uploads, and asynchronous large-file uploads can have different user-facing APIs and converge here. Their HTTP/upload protocols are not part of the extension contract; a bare URL is handled before the artifact-processing hook.

Every artifact has a required `origin`: `none`, `url`, or `file`. A URL origin carries `url`; a file origin carries `relativePath`, including the filename. For a loose file that is simply `"photo.jpg"`; for a folder import it might be `"holiday/photo.jpg"`. There are no separate filename fields or `OriginalArtifact` type. `none` means no recorded origin, and the host assigns it to processing derivatives. These are provenance labels: direct intake neither follows URLs nor reads paths from them. Submission identity, if needed later, can be host metadata.

The host-internal helper now accepts a nonempty batch of streams:

```ts
const input = await store.intake([
  {
    origin: { kind: "file", relativePath: "photos/blue.svg" },
    mediaType: "image/svg+xml", body: blueStream,
  },
  {
    origin: { kind: "file", relativePath: "photos/day-2/green.svg" },
    mediaType: "image/svg+xml", body: greenStream,
  },
]);
// One input batch; no published items yet.
// Input.originals contains both stored, host-issued descriptors.
```

The host computes IDs, sizes, and hashes. A failed ingestion exposes no partial input. Order and per-original provenance survive into the processor. A processor can turn the images into one gallery or separate photo items. The single-file video and Parquet examples explicitly reject collections instead of ignoring extra files.

The core distinction is small:

```ts
type ArtifactOrigin =
  | { kind: "none" }
  | { kind: "url"; url: string }
  | { kind: "file"; relativePath: string };
// Artifact.origin is required; callers can switch exhaustively on origin.kind.
type Input = { inputId: InputId; originals: readonly Artifact[] };
type Item = { itemId: ItemId; artifacts: readonly Artifact[] };
// process(input, { read, write }): Promise<Publication[]>
```

Each `Publication.artifacts` list is the complete visible set for its item, including any selected originals and generated artifacts. Several items may explicitly share a reference. The processor can read the whole assigned input; a viewer receives only its item's selected descriptors and bytes. Artifact identity is independent of item identity.

This defines output item boundaries without adding a document or block format. A general relationship model for captured pages and their supporting resources remains outside this experiment.

## Extension contracts and the viewer

![URL acquisition returns an array of stored artifacts, with its execution environment left open. The artifact processor runs in a Dynamic Worker. The browser viewer receives only reads of its published item's artifact set.](docs/diagrams/authority-boundaries.png)

| Surface | Responsibility |
| --- | --- |
| `AcquisitionRegistration` | Declares matching URL origins for handler selection. |
| `acquire(url, write)` | Obtains content and returns an `Artifact[]`; the host creates one complete `Input`. |
| Acquisition `write(metadata, bytes)` | Stores each artifact's bytes and origin, assigning its ID, size, and hash. |
| `ProcessorRegistration` | Declares accepted MIME types. Selection stays in the host. |
| `process(input, { read, write })` | Interprets stored artifacts and returns a nonempty `Publication[]`; the host creates the resulting item IDs. |
| Processing `read` and `write` | Stream bytes within the assigned input and execution scope, with range and quota checks. No bucket or storage path crosses the boundary. |
| `Publication` | Title, description, the complete set of visible artifact references, selected search text, and presentation references. Search and presentation references must be in that set. A `text/plain` fallback is required; thumbnail and component are optional. |
| Viewer `read` | The component's only host operation. The broker checks artifact membership before returning bytes. |

The [exact TypeScript contract](src/contract.ts) is small enough to read in full. [Editable tldraw canvases and Mermaid sources](docs/diagrams/README.md) accompany both diagrams.

Plugin data formats are internal details. A plugin writes the files it needs, and its viewer reads and interprets those files when it loads. The host stores their bytes without understanding their schema. Search is a separate integration: `Publication.search` supplies explicit strings to index, each referencing a published artifact. The host does not automatically extract text from stored files.

The acquisition example runs in the ordinary Node process and uses its normal networking. It has no acquisition-specific sandbox or network adapter. APIs, secrets, and browser integration can be supplied by an acquirer's environment without changing its output shape; those integrations are not implemented by this fixture.

The existing artifact processor runs in a Dynamic Worker with a scoped `HOST` binding and `globalOutbound: null`. Its trusted bridge supplies execution scope; the store checks scope, ownership, ranges, and quotas. Returning a manifest does not let processor code publish directly.

The browser boundary is independent: an opaque-origin iframe with `sandbox="allow-scripts"`, restrictive CSP, and a MessagePort transferred only to the expected frame. The component cannot access host DOM or make host mutations. Raw artifact responses also carry a restrictive CSP sandbox. [Browser implementation and evidence](evidence/browser.md).

## Examples using the same contract

| Example | Processing | Presentation |
| --- | --- | --- |
| URL acquisition | An acquirer returns HTML and image artifacts with separate source URLs. The host completes one input and a processor consumes the whole batch. | Readable output with explicit artifact membership. Equivalent captured bytes bypass acquisition entirely. |
| Video | The plugin writes its own transcript JSON, readable text, thumbnail, and component HTML, and explicitly supplies selected strings for search. Transcript and thumbnail content are controlled fixtures internal to the plugin. | Actual playback of a format-valid synthetic WebM and transcript-cue seeking. On load, the component reads the plugin's JSON and interprets it; the host knows nothing about transcripts or cues. |
| Parquet | A real parser reads selected byte ranges and materializes only `label` and `value`. The secret column is absent from the summary and search. | The same host displays the readable summary without a component. The original Parquet file is not granted to this item's viewer. |
| Folder/gallery | Two synthetic SVG images, including a nested path, enter as one input. The [gallery processor](plugins/gallery.ts) emits one item with a gallery manifest, labels, and explicit references to both originals. | Readable list fallback; thumbnail generation and a custom gallery viewer are not built here. |
| Individual photos | The [photo processor](plugins/photo-items.ts) turns equivalent image bytes into two items. Each item includes its own image and caption plus an explicitly shared count/title artifact. Tests compare fresh inputs, without reprocessing. | Separate readable captions. A browser test confirms sibling-only images and derivatives are denied while the shared metadata is readable from both items. |

Parquet's default footer prefetch initially read the whole tiny file despite using a range API. The processor now explicitly reads **343–351** (footer), **144–343** (metadata), and **4–70** (selected pages). Tests reject a whole-file read or any intersection with the excluded page **70–144**. This demonstrates selective I/O, not column-level authorization: the processor is granted the original and could request other ranges.

## Run it

Use Node 24 and the committed lockfile:

```sh
npm ci
npm run typecheck
npm test
npm run test:runtime
npm run test:browser
npm run demo
```

The demo serves video at `http://127.0.0.1:4173/`, Parquet at `/?item=parquet`, and two photo captions at `/?item=photo-1` and `/?item=photo-2`. It uses `.demo-store-artifacts` (schema version 7), separate from earlier stores. Old store formats are rejected; this prototype includes no migration. Browser/runtime checks need local listeners and Chromium. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` if needed; otherwise the browser config uses an available macOS Playwright cache.

Validated on 18 October 2026 (Pacific time): all three TypeScript configurations, **38 tests including actual Dynamic Worker processing**, and **4 Chromium tests** passed. The checks exercise plain acquisition/processing functions, HTML-and-image acquisition as an artifact array, direct capture bypass, explicit search text with opaque plugin files, complete multi-file ingestion, rollback and stream cleanup, per-artifact provenance, one-to-many publication, atomic validation/persistence, no reprocessing after completion, explicit artifact sharing and sibling isolation, revocation during processing, selective Parquet reads, and browser containment. [Core questions](evidence/experiments.md), [persisted-output observations](evidence/semantic-observed.json), [URL acquisition observations](evidence/acquisition-observed.json), [independent runtime probe](runtime/README.md).

## Evidence and limits

The [existing Stacks save trace](evidence/stacks-trace.md) shows why a wider return type alone is insufficient: handler selection, full `Env` access, reserved artifact names, indexing, and the reader all constrain extensibility. The [pinned prior-art review](evidence/prior-art.md) distinguishes host-rendered declarations, trusted native UI imports, and isolated arbitrary browser code. No production data or credentials were used.

This is a local filesystem and workerd experiment, not a production plugin platform. Temporary output is discarded on normal failure; there is no resumable work, service-effect ledger, automatic retry, or external-provider idempotency guarantee. It is a single-process store, not a multi-writer database or durable workflow engine.

URL acquisition has no public submission endpoint. Its fixture uses ordinary network requests to local HTTP servers. Browser automation, authenticated API integrations, and acquisition permission design are deferred; the core result is an array of stored artifacts. Browser capture can supply that same set directly.

The fixtures are tiny. Intake currently allows at most 16 MiB per original and implements no resumable HTTP upload endpoint. Publication accepts 1–100 manifests with at most 100 artifact references each, within the existing processing output quotas. The batch helper establishes the completed-input boundary, not a large-file transport. Browser media is buffered into a Blob; large-media delivery, full DuckDB/Wasm, CAD conversion/viewing, resource exhaustion, and production authentication remain untested. The existing [runtime investigation](evidence/runtime.md) separates documented platform limits from local observations. Blocks/Markdown rendering, recipe editing, agent-facing APIs, distribution, and migration can be designed after this flow is settled.

A host-rendered widget remains a valid simpler alternative to custom component code, including for synchronized video. The optional iframe explores whether plugins can supply domain interaction without each new viewer requiring a host UI change; it does not establish that arbitrary browser code is necessary.
