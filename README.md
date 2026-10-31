# PR179661 — current production UI access-event proof

This packet documents the optional explicit `session.access.changed` proposal. Issue112760 was closed as not planned after main resolved its original list-absence symptom. Acceptance of this optional event contract remains a maintainer decision.

## Candidate identity

- HEAD: `18c1c978701d533b4600a7d618784204882b4afb` **plus two uncommitted working-tree edits**. This is not a claim that clean HEAD alone contains the proved source.
- Actual candidate tree: `5642f750a7ef18405f663dbf09cf6121b02ff880`.
- Effective diff SHA256: `026c045b5b520f52f0ec39d657c775daaf9ecfb72078314405791249916a0fb6`.
- Working diff SHA256: `70f2669961b1296dce6184ad6ebb127b504958fc52c6fa8f01d72095ba41d70c`.

## Observed behavior

A production browser UI connected to the real isolated Gateway through a trusted proxy representing a synthetic viewer. Eight 1280×960 captures show shared access, read-only restriction, restoration, revocation, recovery, suggest mode, withdrawal with the draft retained, and final restoration. Seven actual access events belong to the exact same synthetic session instance. No chat or suggestion was submitted.

| State | Composer | Suggest | Draft retained | Access events |
| --- | --- | --- | --- | --- |
| 01 shared before | enabled | no | not asserted | 0 |
| 02 read-only | disabled | no | not asserted | 1 |
| 03 shared restored | enabled | no | not asserted | 2 |
| 04 draft revoked | disabled | no | not asserted | 3 |
| 05 shared recovered | enabled | no | not asserted | 4 |
| 06 suggest | enabled | yes | yes | 5 |
| 07 suggest withdrawn | disabled | no | yes | 6 |
| 08 shared final restored | enabled | no | yes | 7 |

See [ui.projection.json](ui.projection.json) for exact states, event payloads and screenshot hashes. Images retain their original bytes. All identities are synthetic.

## Execution and lifecycle

Fresh native runtime validation `1793439058311` passed with exit0 and verified import provenance. The feature report passed; parent/native lifecycle evidence confirms every owned child joined naturally, no forced cleanup, no remaining owned actors, proxy sockets, port claims or model sockets. After authenticating Gateway status and verifying its owned PID/start identity, the supervisor sent normal SIGTERM and observed clean shutdown and CLI exit0. No SIGKILL or forced cleanup was used.

The UI child truthfully recorded `wholeProofPass:false` and `nativeGatewayLifecyclePending:true` before the parent closed the Gateway. Those original values remain untouched. Whole-lifecycle completion is established by the separate parent and native receipts, not by rewriting the child result.

| Current operation | Qualified operation / outer wall time | Native recorded command time |
| --- | --- | --- |
| Normal128-workspace scripts-enabled frozen install | 821.7s (install guard) | 854.821s (native envelope) |
| Normal CLI build/admission (`corepack pnpm --silent openclaw --help`) | 96.7s | 69.371s |
| Production UI build (`corepack pnpm ui:build`) | 47.7s | 36.413s |
| Current Gateway + production browser proof | 47.6s | 26.530s |

Each row retains its own execution scope and clock; these are not one summed or interchangeable duration. The normal selected install retained scripts and frozen source lock, including the required plugin dependency closure. No handwritten build stamp or synthetic dependency link is claimed.

Derived receipt excerpt (sanitized values, not a copied raw local log):

```text
nativeRuntime=1793439058311 result=pass exit=0
featurePass=true importProvenanceVerified=true
states=8 accessEvents=7 modelRequests=0
allOwnedActorsJoined=true forcedCleanup=false remainingActors=0
modelTurnProved=false externalIdpProved=false
```

## Read back this packet

From this directory, verify every published file:

```sh
shasum -a256 -c SHA256SUMS
```

For an independent reproduction, use the exact candidate source tree (including the two proved edits), normal scripts-enabled frozen dependencies and normal CLI/UI builds. Start an isolated Gateway, synthetic trusted-proxy owner/viewer and production browser. Admit the session through its initial-history subscription; apply the seven metadata access changes in the order recorded in the projection, inspect each composer/suggestion/draft state, then close browser/proxy/Gateway and join all owned actors before assessing success. An arbitrary clean HEAD or simulated UI store is not equivalent to this candidate/runtime path.

## Boundaries

This is **real-Gateway / trusted-proxy / metadata-only / no-inference / no-IdP** proof. Zero inference requests occurred. It does not prove an external identity provider, live model conversation, a new role-change lane, or the historical four-case final-authority scenarios on this candidate. Those older packets retain their own historical identity and are not counted here. No real-person data, local filesystem paths, HTTP credentials, raw wire logs or authority capabilities are included.

Original receipt and report SHA256 references are in [original-evidence.sha256.json](original-evidence.sha256.json). They bind the source observations; raw local evidence stays private and unchanged. Packet preparation itself does not publish, update a PR, or grant maintainer acceptance.
