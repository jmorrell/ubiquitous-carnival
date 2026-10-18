# Browser boundary: observed results

On 2026-10-17, the three Playwright tests in `tests/browser.spec.ts` passed against the local demo server using the actual Dynamic Worker runner: **3 passed in 3.5 seconds**. No external service or production data was used. Chromium/local workerd required the approved execution environment outside the macOS process/network sandbox; the earlier sandbox launch failures were environment failures, not evidence for isolation.

Run from the repository root:

```sh
npm run test:browser
npm run demo
# Open http://127.0.0.1:4173/ or http://127.0.0.1:4173/?item=parquet
```

The test configuration starts its own server with a fresh temporary persistent store. It does not reuse a running demo or stale component artifact. Playwright is 1.64.1; its default expected Chromium cache was unavailable. The configuration used existing cached Chromium build 1243, **Chrome for Testing 153.0.8010.12**, without downloading anything. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` can select another executable. This is evidence for that browser/version, not all browsers.

## What passed

1. **Actual media interaction and a user-owned note.** Clicking the second transcript cue sets an actual `HTMLVideoElement.currentTime`; playing the local WebM advances playback and updates the component's time display. A note proposal alone creates no annotation. An explicit trusted host button click persists the note against the selected original-media time target. The component cannot replace the displayed proposal while confirmation is pending. The fixed host transcript has readable text but no synchronization controls. The same generic host displays the Parquet summary at `/?item=parquet` with no component.
2. **Separate browser authority.** The opaque sandbox cannot access `parent.document`, read a real original artifact belonging to the other Parquet item, or propose a forged target. A hostile sibling opaque frame races the legitimate ready handshake and receives no MessagePort; its direct action-shaped `postMessage` creates no proposal. A direct annotation POST without the fixture host-action header is rejected. For this one test only, the legitimate component's ready message is delayed by 500 ms through a local response override so the race is exercised; the browser sandbox and channel are real.
3. **Tested egress attempts.** The component's direct fetch and self-navigation to a different loopback origin are blocked. A Playwright route canary records zero attempted requests to that origin, preventing actual network traffic even if the boundary regresses. Chromium replaces a CSP-blocked iframe navigation with an error document; it does not preserve the old component document. The host's readable content remains available. The host closes its channel after frame navigation.

The three tests exercise behavior rather than substituting a fake iframe, DOM, media element, or Worker. The transcript/provider response is deliberately controlled and synthetic.

## Evidence that changed the implementation

The first real run could not load the video: allowing `media-src blob:` only in the child CSP was insufficient because the parent's inherited `default-src 'self'` also applied. Adding explicit `media-src blob:` to the parent fixed playback. This falsified an initially incomplete CSP assumption. A second run showed that blocked navigation produces a browser error document, so the test was corrected to check the security consequence—no canary request and an intact host—rather than an invented document-lifecycle behavior.

The Parquet presentation check removed video-specific host labels and propagated the item's query through the generic API calls. It required no new viewer hook or host interpretation of Parquet rows. Cue-to-transcript ordering remains private to the video processor/component pair; the host does not know it.

## Enforced boundary and limits

- The host creates an `iframe sandbox="allow-scripts"` without same-origin, popup, top-navigation or form permissions. Its CSP constrains frame navigation; the child CSP denies connections, nested frames, workers, objects and forms. Blob media and inline component code/styles are the narrowly enabled resources.
- The host accepts ready only from that frame's `contentWindow` with opaque `origin === "null"`, then transfers a fresh MessagePort. The child receives item and generation information, not existing annotations, credentials, bucket bindings, authenticated URLs or the host DOM.
- The host validates artifact membership and target identity on every broker request. It reads bytes itself and transfers the result. The component may propose a note; the host owns confirmation and persistence. Existing notes are rendered by the host, including an earlier-processing-revision label when applicable.
- The local demo's `x-host-action: demo-confirmed` header is a fixture guard, **not real authentication or a secret**. A general client can set it. The production boundary would need the existing authenticated user/tenant API, appropriate CSRF handling, and host-controlled actions. The demonstrated plugin cannot send that request directly because its browser network access is denied.
- This is not a complete browser security audit or an availability guarantee. Only the listed attacks were exercised. Same-origin navigation is allowed by the parent's frame policy, but remains opaque and sandboxed; not every browser exfiltration/side-channel mechanism was tested. Component removal prevents future component reads but does not immediately terminate an already-loaded iframe; reload closes that gap in this demo.
- Media is read wholly into an ArrayBuffer and Blob. These tiny fixtures establish no large-file, stream-backpressure, range-playback or memory claim. The backend Parquet experiment separately exercises selective object reads.
- Current CSP denies workers and WebAssembly compilation. Full DuckDB-Wasm, CAD/WebGL viewers, GPU/resource limits, and browser-code upgrade compatibility remain untested. Supporting those may require additional expressly tested capabilities.
- A purpose-built host video template could implement the same synchronization. This experiment establishes that optional isolated component code can support it under the tested constraints; it does not prove arbitrary code is necessary for every video or that fixed templates cannot work.

## Fixture provenance and screenshots

`fixtures/video.webm` is a synthetic six-second, 160×90, 10 fps VP8 gradient with no audio. The transcript is independently authored fixture data, not an observed transcription of the image. The file can be regenerated offline on this macOS environment with:

```sh
node browser/make-video-fixture.mjs
```

The generator uses `/usr/bin/sips` to encode one synthetic JPEG and the cached Playwright ffmpeg to encode 60 frames. `FFMPEG` can override the ffmpeg path. The checked-in WebM means ordinary test runs do not need either generator tool.

Desktop screenshots were captured and visually inspected from a fresh store with the actual Dynamic Worker processing path, cached Chromium and synthetic fixtures: [video with confirmed note](browser-video.png), [Parquet fallback](browser-parquet.png). They demonstrate presentation, not real service output or a mobile visual audit.

Final root verification after making every raw artifact response inert with a CSP sandbox: the same three browser tests passed again in 3.4 seconds. This serving policy also covers active MIME types with parameters; direct artifact navigation never intentionally grants host-origin script execution. No claim of a complete MIME/browser audit is added.
