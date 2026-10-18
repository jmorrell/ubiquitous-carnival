# Runtime boundary investigation

## Uncertainty recorded before implementation

Can a dynamic worker process only the assigned item through revocable capabilities with ambient egress disabled?

Smallest experiment: load an independent JavaScript module through the real Worker Loader; expose only an item-scoped RPC capability; request a byte range and a streamed derivative; attempt a foreign item read, a read after host revocation, ambient HTTP and TCP egress, and access to a synthetic host credential. An unauthorized byte or credential, or a successful ambient connection, disproves the proposed boundary. The storage and paid service may be synthetic, but the isolate and RPC transport must be real workerd.

## Pinned execution surface

The root lockfile pins Wrangler `4.151.1`, Miniflare `5.20261012.1-beta`, workerd `1.20261012.1`, `@cloudflare/workers-types` `5.20261016.1`, and esbuild `0.28.2`. Compatibility date is `2026-10-01`. TypeScript is compiled before code enters the loader. No deployment, credentials, or internet requests are required by the probe.

The public API is `LOADER.load({mainModule, modules, compatibilityDate, env, globalOutbound:null})`. The name is **globalOutbound**, not `outbound`. If omitted, network authority is inherited. A `ctx.exports.ScopedHost({props:{runId}})` service binding carries host-selected scope. `get(id, callback)` caches code/configuration, so a plugin-only cache key must not accidentally reuse per-run authority. The experiment uses `load()` instead. These are documented semantics from the [API reference](https://developers.cloudflare.com/dynamic-workers/api-reference/); the [workerd 1.20261012.1 loader declaration](https://github.com/cloudflare/workerd/blob/v1.20261012.1/src/workerd/api/worker-loader.h) is the pinned runtime source reference.

Installed source inspection confirms the test is wired to the runtime binding: Miniflare's pinned `dist/src/index.js:132950` translates `workerLoaders` to bindings with type `worker-loader`; its handler at `128188` emits the workerd `workerLoader: {}` binding. The pinned Workers type package declares `WorkerLoaderWorkerCode.globalOutbound?: Fetcher | null`. These checks establish the configuration path; the executable adversarial probes below establish its observed behavior. Miniflare 5's constructor schema changed, so the harness uses its exported `convertV4MiniflareOptions` adapter.

## Boundary and the minimum authority

The child receives exactly `HOST`. It receives no bucket, store, loader, general fetch service, credential or user session. The trusted host implements `read(objectId, range)`, `write(byteStream)`, and `derive(objectId)` for this probe. Each store operation resolves the host-supplied run, rejects revoked runs, checks object ownership, validates ranges, and enforces a write byte limit. Plugin-supplied object IDs are untrusted data. This is runtime policy in the trusted store, not TypeScript enforcement.

The credential is a synthetic canary, added only by `ScopedHost.derive` after the call crosses into trusted code. The fake paid service verifies that credential. A real service would need its own input allowlist, budget, and failure/recovery policy; the core prototype implements no service-effect ledger. No generic external-request capability is earned by this experiment.

Workers RPC can transfer Response bodies and byte ReadableStreams with flow control; ordinary serialized RPC messages have a 32 MiB limit. Returning object references plus streams avoids making inline byte arrays the contract. This is [documented transport behavior](https://developers.cloudflare.com/workers/runtime-apis/rpc/), distinct from the small payload exercised here. R2's documented [range reads](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#ranged-reads) fit the host method, but this probe does not contact R2.

Revocation checks deny **subsequent operations**. They do not retract bytes already given to a child, automatically cancel existing streams, or reverse completed paid requests. A production host needs checks at commit and service dispatch, stream cancellation where required, and durable policy rather than in-isolate mutable variables. The synthetic backing store lives outside the Worker and is authoritative across RPC calls.

## What fits this runtime

| Work | Placement and limit |
| --- | --- |
| Recognition, structured extraction, manifest production | JavaScript/TypeScript compiled to JS in the dynamic isolate; no raw storage or credentials. |
| Streaming archive and selective Parquet reads | Host-mediated streamed object access. A range-capable byte contract does not prove that DuckDB or any particular query engine fits. |
| ffmpeg, native CAD conversion, native DuckDB | Host-provided service/container. Dynamic Workers accept JS/Python/Wasm modules, not arbitrary operating-system executables. Wasm ports remain candidates subject to memory/CPU/library tests. |
| Browser capture/automation | Host-provided browser service; a Worker isolate is not a browser with DOM or installed Chromium. |
| Long transcriptions/large conversions | Host durable job/service with stable operation identity; the plugin composes results. A synchronous hook does not imply a durable execution guarantee. |
| Frontend code | A separate browser boundary. Backend isolate results say nothing about iframe/CSP/postMessage containment. |

Documented Workers limits include 128 MiB isolate memory and up to five minutes CPU on the paid plan; a request's elapsed time is not a durable job guarantee. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/#limits) state that configured CPU limits are not enforced in local development. The Dynamic Workers [concurrency limits](https://developers.cloudflare.com/dynamic-workers/platform/limits/) are four distinct active dynamic workers per request, ten per Durable Object. These are documentation constraints, not benchmark observations here. We have not measured memory ceilings, CPU termination, billing, provider idempotency, large files, native tools, or browser capture.

## Reproduction and observations

From the repository root after `npm ci`:

```sh
node runtime/probe.mjs
npx tsc -p runtime/tsconfig.json
```

`runtime/probe.mjs` starts local Miniflare/workerd, compiles `worker.ts`, and loads the separate untrusted module through the Worker Loader. The backing store and derivation response are explicitly synthetic. An in-process egress canary establishes a positive control with inherited outbound authority; the null-outbound run must never reach that canary. This avoids mistaking DNS/network failure for containment. The actual isolate, RPC and egress enforcement remain workerd behavior.

Observed on 2026-10-17 (Vancouver; machine timestamp `2026-10-18T00:33:13Z`): all runtime assertions passed. The range read returned `2345`, status 206 and `bytes 2-5/10`. A 16-byte artifact crossed the child-to-host stream boundary. The synthetic derivation verified its credential host-side. Foreign-object read and derivation failed with `object outside capability`; the next read after host revocation failed with `run revoked`. HTTP and TCP threw workerd's explicit internet-permission error, and zero isolated requests reached the egress canary; the inherited-authority positive control did reach it. Attempts to traverse the host's `env` and `ctx` failed at RPC dispatch. See [the complete recorded report](../runtime/observed.json).

The scenario integration uses [dynamic-runtime.ts](../runtime/dynamic-runtime.ts): `createDynamicRuntime(storeFetch)` returns `execute(source, {runId, input})` and `dispose()`. It injects only a scoped `HOST.fetch` binding and uses the same null-outbound loader policy. A separate actual-workerd smoke check confirmed that a child-supplied `x-run: forged` header is overwritten with the trusted run identity while its request body survives the proxy. Store operations must still validate routes, object ownership, run state and quotas; a generic transport method does not grant a generic storage API. Both the Worker source and Node helper passed strict TypeScript checks.

One assumption was disproved: `globalThis.process` **exists** in this runtime even though the child does not request Node compatibility. Its `env` was empty, and neither it nor the child's explicit/global Cloudflare env exposed the host credential. Therefore the security assertion is withheld authority, not the absence of a familiar global name. Both child env access paths contained only `HOST`.

The initial restricted runner failed with `listen EPERM 127.0.0.1` before any assertions ran. The successful run used permission for local workerd listeners; it made no external request. The small artifact tests transport semantics, not bounded memory under multi-gigabyte input. The standalone Wrangler file documents the loader binding; the runnable probe supplies STORE and the synthetic host credential through Miniflare, so `wrangler dev` with that file alone is not the complete test harness.
