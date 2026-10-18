# Questions recorded before implementation

Video is the first slice; Parquet is the second. CAD is withheld until the initial contract is implemented. All processing fixtures will be explicitly synthetic. No production access is assumed.

| Architectural uncertainty | Smallest experiment | Observation that disproves the proposal |
| --- | --- | --- |
| A Dynamic Worker can operate on one assigned item without ambient authority. | Load actual plugin JavaScript in local workerd, grant scoped artifact and service capabilities, and attempt foreign reads, writes, raw network access, and secret access. | Any unauthorized bytes, secret, or successful ambient network request; inability to enforce revocation at the host. |
| Immutable artifacts plus an atomic published generation can preserve durable user data through retries and reprocessing. | A synthetic video yields a transcript and thumbnail; inject failure after a paid-service result and before publication; retry; reprocess with changed transcription; remove plugin. | Partial results become searchable, an acknowledged paid result is bought twice, a stale target silently moves, or removal destroys original/note data. |
| A small view boundary can support domain interaction without trusting frontend code. | Compare a fixed transcript template with an opaque-origin iframe implementing transcript/playback synchronization; broker artifact reads and explicit annotation proposals; attack parent DOM and messages. | Required interaction needs access to parent DOM/credentials, or another frame/forged target can invoke a host action. |

The second scenario tests a real Parquet file with bounded range reads and deliberately selected search text, using the same processing contract. It does not promise a full DuckDB integration. The CAD challenge will be documented only after this contract settles; any new requirement will be recorded rather than silently added.
