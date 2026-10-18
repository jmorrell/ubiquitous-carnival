# Browser boundary: a read-only component

The host displays a readable fallback and optionally loads component HTML into an opaque-origin iframe. The component receives `{ item, publication }` and one capability: `read(artifact, range?)`. The [boundary diagram](../docs/diagrams/authority-boundaries.png) shows how this differs from backend processing authority.

## Video interaction

The video processor writes transcript JSON and embeds its artifact ID in its component HTML. The component reads that JSON and the original video through the broker, then uses transcript timestamps to seek an actual `HTMLVideoElement` and follow playback. Cue interpretation is private to the processor/component pair. No target registry or generic host action is needed.

The host's fixed text view remains readable without synchronization controls. The same host displays the Parquet summary at `/?item=parquet` without loading any component.

## Checks

On 18 October 2026 (UTC), all **4 Playwright tests passed in 2.9 seconds** using cached Chromium **153.0.8010.12**. They exercise:

1. Actual media seeking, playback, and time display, plus the generic Parquet fallback.
2. Denied parent DOM access, a real foreign item's artifact read, a hostile sibling frame racing the ready handshake, and unsupported broker methods.
3. Two items published from the same image input: sibling-only descriptors are absent, sibling artifact reads fail in both the broker and server, and explicitly shared metadata is readable from both. The fixture uses readable captions; a test-injected protocol probe exercises the actual broker without adding a photo component.
4. CSP denial of direct fetch and cross-origin frame navigation, with zero requests reaching the test's egress canary.

The tests use the actual iframe, DOM, media element, and Dynamic Worker processing path. Transcription is controlled synthetic data. Each test run starts a fresh temporary store; it does not reuse stale component output.

## Enforcement and limits

- The host checks the ready message's exact `contentWindow` and opaque `origin === "null"`, then transfers a fresh MessagePort once. This identifies the intended frame; it is not user authentication.
- The broker accepts only reads and checks the artifact against `item.artifacts`, the publication's complete explicit set. The server independently enforces that membership. A viewer receives neither the full input batch nor sibling-only artifact descriptors. There is no mutation route in the component protocol or demo API.
- `sandbox="allow-scripts"` grants no same-origin, popup, top-navigation, or form permission. Parent/child CSP constrains fetches, frame navigation, workers, objects, and forms. Blob media and inline component scripts/styles are explicitly allowed.
- Every raw artifact response also carries a CSP sandbox, including active MIME types with parameters. Fetching bytes does not give the artifact host-origin script authority.
- Blocking a cross-origin navigation replaces the iframe with a browser error document. The host closes the old channel after navigation; the readable fallback survives.
- Media is buffered into an ArrayBuffer and Blob. Tiny-fixture playback is not a large-file streaming or memory result. Workers and WebAssembly compilation are not granted; full DuckDB/CAD viewers remain untested.
- Removing a processor prevents future component loads, but does not immediately terminate an already-loaded iframe or retract transferred bytes. This demo is a loopback server with no production authentication. The tests are specific attacks, not a complete browser security audit.

The initial video experiment revealed that `media-src blob:` was needed in both parent and child CSP. The current policy retains that correction. A host video widget could implement the same interaction; this experiment tests the optional isolated-code approach.

## Reproduce

```sh
npm run test:browser
npm run demo
# http://127.0.0.1:4173/ or http://127.0.0.1:4173/?item=parquet
```

The configuration uses `PLAYWRIGHT_CHROMIUM_EXECUTABLE` when set, otherwise a cached macOS Chromium. It requires permission to open local listeners and launch the browser. See the main report for the latest validation result.

`fixtures/video.webm` is a synthetic six-second, 160×90, 10 fps VP8 gradient with no audio. The transcript is independently authored, not extracted speech. `node browser/make-video-fixture.mjs` regenerates the fixture using macOS `sips` and cached Playwright ffmpeg (`FFMPEG` can override its path); ordinary tests use the committed WebM.

Screenshots of the current demo: [video viewer](browser-video.png) and [Parquet fallback](browser-parquet.png). They demonstrate presentation, not real transcription or a mobile visual audit.
