# Core diagrams

| Diagram | Purpose | Editable canvas | Structural source |
| --- | --- | --- | --- |
| [Core flow](core-flow.png) | Original → processor → validated result → search and viewing | [tldraw](core-flow.tldraw) | [Mermaid](core-flow.mmd) |
| [Authority boundaries](authority-boundaries.png) | Scoped backend processing and a separate read-only browser component | [tldraw](authority-boundaries.tldraw) | [Mermaid](authority-boundaries.mmd) |

The `.tldraw` files contain editable shapes and bound connections. The `.mmd` files record their structure; the native canvases also contain layout and styling for readability. PNG exports are committed so Markdown readers need no rendering dependency.

Open a canvas in tldraw to edit it. Keep its Mermaid source aligned, save, then export the complete diagram as a PNG with a light background and padding. Inspect the image at document width and commit all three files together.

Implementation: [contract](../../src/contract.ts), [host store](../../src/store.ts), [Worker loader](../../runtime/dynamic-runtime.ts), [runner](../../src/runner.ts), and [browser broker](../../browser/host.js).
