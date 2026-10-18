# Core questions and checks

The experiment now concentrates on one published result per item. These checks replace the broader lifecycle and editing experiments; the earlier implementation remains in Git history.

| Question | Smallest experiment | What would disprove it? |
| --- | --- | --- |
| Can a Dynamic Worker process one assigned item without ambient authority? | Load real plugin JavaScript in local workerd; grant scoped artifact/service operations; attempt foreign reads, secret access, and ambient HTTP/TCP. | Unauthorized bytes, credentials, or network access; failure to enforce capability revocation. |
| Can a processor publish one complete searchable result without exposing incomplete output? | Produce a video manifest and derivatives; inject invalid references and processing/storage failures; publish a valid result and reopen the store. | Partial output becomes readable/searchable, foreign artifacts become visible, publication replaces an existing result, or a successful result fails to persist. |
| Can a read-only browser boundary support useful domain interaction? | An opaque-origin iframe reads archived media and transcript JSON, seeks/plays the video, and attempts parent/foreign-artifact access, channel spoofing, and egress. | Interaction requires host DOM/session access or an unauthorized operation succeeds. |

A second processor parses a real Parquet fixture through selected byte ranges and emits a readable summary with deliberately selected search text. It uses the same contract and no transcription grant. Its tests assert which bytes were read, rather than merely checking that a range-shaped API was called.

A folder/gallery fixture supplies two image originals, including a nested relative path, to one processor invocation. Tests verify batch completion before item visibility, rollback on ingestion failure, host-issued identities, every-original MIME matching, and preservation of filenames/paths through an actual Dynamic Worker. Its manifest and readable list demonstrate collection input without adding a host hook.

There is no CAD locator challenge in this scope. The video component owns cue timing internally; the host search contract returns artifact references rather than universal locations.
