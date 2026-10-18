# Diagrams

These diagrams describe the implemented experiment. They separate who can execute code, who owns data, and when a result becomes visible. The captions in the main report and browser evidence retain the limits that do not fit inside the drawings.

| Diagram | Read it with | Editable canvas | Structural source |
| --- | --- | --- | --- |
| [Authority boundaries](authority-boundaries.png) | [Contract and enforcement](../../README.md#the-boundaries-and-why-each-exists) | [tldraw](authority-boundaries.tldraw) | [Mermaid](authority-boundaries.mmd) |
| [Publication lifecycle](publication-lifecycle.png) | [Ownership and lifecycle](../../README.md#ownership-identity-and-lifecycle) | [tldraw](publication-lifecycle.tldraw) | [Mermaid](publication-lifecycle.mmd) |
| [Annotation identity](annotation-identity.png) | [Stable and historical notes](../../README.md#ownership-identity-and-lifecycle) | [tldraw](annotation-identity.tldraw) | [Mermaid](annotation-identity.mmd) |
| [Browser annotation flow](browser-annotation.png) | [Browser boundary](../../evidence/browser.md#how-a-proposal-becomes-a-note) | [tldraw](browser-annotation.tldraw) | [Mermaid](browser-annotation.mmd) |

The `.tldraw` files contain editable shapes and connections. The `.mmd` files record the diagram structure; the canvases also contain layout and styling for document readability. The PNG exports are committed so GitHub and local Markdown readers display the same images without a rendering dependency.

To update a diagram:

1. Open its `.tldraw` file in the local tldraw app and edit the shapes and bound connections. Update the corresponding `.mmd` if the relationships or labels change.
2. Save the canvas and export the complete diagram as a PNG with a white background and padding, replacing the matching image here.
3. Inspect it at normal document width, then check its caption against the implementation. Keep the canvas, structural source, and export in the same commit.

Implementation references: [host capabilities and target identity](../../src/store.ts), [Worker loader](../../runtime/dynamic-runtime.ts), [host publication runner](../../src/runner.ts), and [browser broker and confirmation](../../browser/host.js).
