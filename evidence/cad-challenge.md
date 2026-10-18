# Held-out CAD challenge

CAD was held out until the video/Parquet contract and execution tests passed. The hypothesis challenged here is that `whole | time | text` is sufficient to identify every note target required by the five scenarios.

The smallest input is an immutable artifact labelled `model/step`, a readable fallback, and a synthetic face/UV locator: `{ kind: 'fragment', scheme: 'urn:magpie:cad:face-uv:v1', value: 'face=7;u=0.25;v=0.75' }`. The bytes are explicitly **not valid STEP**. No geometry parsing, topology stability, conversion or rendering is claimed. This isolates the ability to persist and resolve a location from the ability to interpret it geometrically.

Initial runtime experiment: bypass the TypeScript union, submit that JSON through `FileStore.publish`, and observe whether it becomes a published note target. Observable falsification is rejection as an unknown selector. `whole` would lose the point; `text` points at readable fallback bytes, not a model face; `time` is restricted to video and has no spatial meaning. Encoding the locator only in `TargetDraft.key` would make that key an undocumented geometry convention while leaving its declared selector `whole` false.

Observed before the amendment, on 2026-10-17: `vitest run tests/cad-challenge.test.ts` passed its single falsification assertion. `FileStore.publish` rejected the fragment with `unknown selector`, and `context(itemId)` still reported `item is not published`. Thus the original sufficiency hypothesis failed in runtime validation, not merely in TypeScript compilation. The baseline implementation allowed exactly `whole`, `time`, and `text` in `src/store.ts`.

The smallest justified amendment is one additional inert selector: `{ kind: 'fragment'; scheme: string; value: string }`. `scheme` identifies a versioned, namespaced locator interpretation; `value` contains only that locator. The host must bound and validate their representation and keep the existing artifact ownership/publication checks. A compatible viewer must validate geometry-specific syntax, reject absent/invalid faces, and show an unresolved target instead of silently substituting another face. A URI-like scheme is an identifier, not permission to fetch it or execute code. This earns a selector case, not an arbitrary metadata bag, new processing hook, CAD service, or event bus.

For unchanged original bytes, key and locator field values, the existing target identity should survive reprocessing and plugin upgrades. An annotation remains user-owned and the stored locator should survive plugin removal even when its interpretation becomes unavailable. Nothing here establishes correspondence after a model edit, tessellation change, or topology renumbering. Those cases require a new target or an explicit, separately validated mapping; preserving a string is not successful geometric re-anchoring.

The amendment was then implemented in `src/contract.ts` and `FileStore.publish`: a lowercase namespaced URN ending in `:vN` (`N >= 1`), at most 200 characters, plus a nonempty, non-whitespace locator of at most 4096 JavaScript string code units. The host still requires the target artifact to be visible and owned by the item. The host deliberately does not interpret `face=7;u=0.25;v=0.75` as valid geometry.

Final observed run: **2 tests passed** on 2026-10-17. The unchanged original/key/locator produced the same target ID after reprocessing with plugin version 2, keeping its user note current. Changing the locator to `face=8` produced a new target ID and made the old note historical. Plugin removal and reopening the persisted store retained the original bytes, readable fallback, old locator, and note. Invalid/unversioned namespaces, blank/oversized values, and a target on another item's original were rejected before publication. These are actual host persistence and validation results, with no CAD runtime/parser/viewer claim.

The challenge also exposed an implementation defect during source inspection: target hashes originally serialized the selector object directly, making field insertion order affect identity. The host now hashes a fixed field tuple for each selector kind. The existing regeneration test supplies the same fragment values in reversed property insertion order and still expects the same target ID. This preserves location identity across an encoding-only plugin change; it does not normalize or reinterpret the locator string. The challenge remains two tests, included in the final combined test run reported in the repository README.

Reproduce the final amended-contract test:

```sh
npx vitest run tests/cad-challenge.test.ts
```

The final test replaces the initial rejection assertion because the amendment intentionally changes that behavior. The initial failed sufficiency hypothesis is preserved above as an observed result, not re-created with a mock validator. This challenge justified exactly one selector case and no other extension point.
