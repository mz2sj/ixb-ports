# ISP upstream implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Preserve all VPN nodes and attach the two ISP nodes to a healthy, lowest-latency US upstream.

**Architecture:** Generate a native mihomo url-test group at the runtime-config boundary. Keep proxy identities and port assignment unchanged. Expose the current upstream in the existing status response and page.

**Tech Stack:** Node.js 18+, YAML, mihomo, node:test.

**Spec:** `docs/superpowers/specs/2026-11-18-isp-upstream-design.md`

## Global Constraints

- Only loopback listeners; no system proxy, TUN, or unrelated process changes.
- Preserve `data/ports.json` mappings, all VPN nodes and two ISP nodes.
- Probe every 30 seconds, timeout 3000ms, tolerance 0ms, lazy false.
- Keep credentials and subscription contents in ignored data only.

## Review Focus

- US city labels without country flags must qualify; Costa Rica San José must not.
- ISP and chained nodes must not become upstream candidates or cause loops.
- A colliding group name must not shadow a proxy.
- No US candidates must fail before replacing the old running config.
- Future imports and restarts must retain automatic upstream behavior and old ports.

### Task 1: Runtime group and regression tests

**Files:** `lib.mjs`, `test/lib.test.mjs`, `package.json`.

**Interfaces:** `ispUpstream(nodes)` returns null or `{ name, candidates }`; `buildRuntime(nodes)` continues returning YAML; `assignPorts(nodes, saved, previousNodes = [])` preserves the currently active port for unique names of the same type when subscription endpoints change.

- [x] Add failing tests for both ISP dialers, candidate filtering, group-name collisions, no candidates, and unchanged ports/proxies.
- [x] Run `node --test test/lib.test.mjs`; confirm missing-group failures.
- [x] Generate a collision-free US url-test group and point only chained ISP proxies to it. Reject unresolved other dialers clearly.
- [x] Run `npm test`; expect all regression cases passing.

### Task 2: Live operation and failover

**Files:** `server.mjs`, `public/index.html`, `README.md`, `test/failover.test.mjs`.

**Interfaces:** Persist upstream group metadata in node snapshot; return current selection/delay via `/api/state`. Reuse Task 1's `ispUpstream(nodes)`.

- [x] Add an isolated mihomo test with two controllable US SOCKS relays, two mock ISP exits, and a local HTTP probe; confirm selection and scheduled timeout failover.
- [x] Stage port-map changes until config validation passes, expose upstream selection and document reconnect behavior.
- [x] Run `npm test`; expect all cases passing, including the actual mihomo failover test.
- [x] Validate the real failed-import configuration before restarting only this repository's server; refresh the explicitly authorized saved subscription.
- [x] Verify all retained same-name/type nodes retain ports, all current listeners bind, and test both ISP exits end to end.

## Execution notes

The user explicitly requested direct repair and verification in this running checkout; execute inline here without another approval round. No commits or publication requested. Record verification below as work proceeds.

- Task 1: initial seven tests failed for six missing behaviors, then passed 7/7.
- Isolated real mihomo test: passed; fastest upstream timed out, automatic selection moved to backup and both ISP exits remained usable (41 seconds).
- Live preflight found that the provider changed 55 same-name endpoints. Added a failing regression and preserved their active ports by same name/type, persisting the updated identity mappings. Retired identities stay reserved.
- Independent read-only review found Costa Rica San Jose without an accent could be misclassified. Added both English and Chinese failing regressions and excluded explicit Costa Rica labels.
- Final full suite: `npm test` passed 9/9 with no skips; isolated timed-out-upstream failover passed in 41 seconds.
- Real subscription: mihomo configuration check passed; 266 current nodes, 35 US candidates, 136 retained same-name/type nodes, zero changed retained ports, zero missing listeners, no service error.
- Both real ISP local SOCKS ports successfully reached an HTTPS IP endpoint; egress matched each respective ISP. No outage was deliberately introduced on live user traffic.
- Native url-test selection changed after fresh measurements, confirming no manual pin was left in place.
- Frontend Browser plugin and cached Playwright were unavailable. Syntax and a DOM rendering harness verified the new upstream status line; full visual/browser QA was not performed. No browser dependency was installed.
