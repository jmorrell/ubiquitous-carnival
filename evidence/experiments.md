# Core questions and checks

The experiment concentrates on processing one stored input into an atomic set of published items. These checks replace the broader lifecycle and editing experiments; the earlier implementation remains in Git history.

| Question | Smallest experiment | What would disprove it? |
| --- | --- | --- |
| Can a Dynamic Worker process one assigned input without ambient authority? | Load real plugin JavaScript in local workerd; grant scoped artifact/service operations; attempt foreign reads, secret access, and ambient HTTP/TCP. | Unauthorized bytes, credentials, or network access; failure to enforce capability revocation. |
| Can a processor return multiple searchable items without exposing partial output? | Produce several manifests; make a later manifest invalid or fail the metadata commit; publish a valid set and reopen the store. | Any partial item/search entry appears, rollback deletes an existing shared blob, or result IDs/completion state fail to persist. |
| Does each resulting item expose only its selected artifacts? | Split an image batch into photo items with distinct originals/captions and shared metadata; inspect contexts and attempt sibling reads through storage, HTTP, and the browser broker. | Sibling-only descriptors or bytes leak; intentional sharing fails; search points outside its item's artifact set. |
| Can a read-only browser boundary support useful domain interaction? | An opaque-origin iframe reads archived media and transcript JSON, seeks/plays the video, and attempts parent/foreign-artifact access, channel spoofing, and egress. | Interaction requires host DOM/session access or an unauthorized operation succeeds. |

A second processor parses a real Parquet fixture through selected byte ranges and emits a readable summary with deliberately selected search text. It uses the same contract and no transcription grant. Its tests assert which bytes were read, rather than merely checking that a range-shaped API was called.

A folder/gallery fixture supplies two image originals, including a nested relative path, to one processor invocation. Tests verify batch completion before input visibility, rollback on ingestion failure, host-issued identities, every-original MIME matching, and preservation of required origin variants through an actual Dynamic Worker. Fresh inputs containing equivalent bytes demonstrate both one gallery and separate photo items. The processor chooses the output count; the host assigns item IDs and publishes the complete set once.

There is no CAD locator challenge in this scope. The video component owns cue timing internally; the host search contract returns artifact references rather than universal locations.
