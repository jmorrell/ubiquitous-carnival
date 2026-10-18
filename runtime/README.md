# Actual Dynamic Worker boundary probe

From the repository root:

```sh
npm ci
node runtime/probe.mjs
npx tsc -p runtime/tsconfig.json
```

The probe compiles the trusted TypeScript host, starts local workerd through Miniflare, loads `untrusted-probe.js` into a separate Dynamic Worker and asserts:

- A host-scoped range read and streamed write cross real RPC.
- An existing foreign object's bytes are denied.
- The credential remains host-side while a synthetic paid service accepts it.
- Direct reads of host environment/context do not reveal authority.
- Revocation denies subsequent reads through the existing binding.
- HTTP and TCP ambient egress fail; an inherited-egress positive control reaches a local canary.

`observed.json` is written only after all assertions pass. The synthetic object store and paid service are controlled fixtures. The Dynamic Worker, RPC transport and outbound policy use actual workerd. This does not benchmark large files, stress resource limits, establish Cloudflare production equivalence, or test an external provider.

`wrangler.jsonc` shows the Worker Loader configuration. The complete runnable harness is `probe.mjs`, which also supplies a trusted STORE binding and a synthetic host credential. Miniflare 5 uses a new constructor schema; the harness calls its exported `convertV4MiniflareOptions` adapter.

See [runtime evidence](../evidence/runtime.md) for the documented execution limits and contract implications.
