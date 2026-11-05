# Adapter TODO — ioBroker.snapmaker

Status: **v0.1 polling implemented** (connect + status). Live-tested IDLE on A350 + laser.

## Decision log

| Topic | Decision |
|-------|----------|
| Name | `iobroker.snapmaker` |
| Primary device | Snapmaker 2.0 A350 (laser module available for testing) |
| Protocol | Legacy HTTP API v1 on port `8080` |
| Not | Artisan/J1 (SACP), U1 (Moonraker) |
| Scaffold | `@iobroker/create-adapter` (done) |
| Author | skvarel / inventwo |
| Repo | `inventwo/ioBroker.snapmaker` |

## Phase 0 — validation (user)

- [x] Confirm machine reachable at configured IP (e.g. `192.168.150.150:8080`)
- [x] Luban `server.token` UUID works without touchscreen dialog
- [ ] Capture a real `/api/v1/status` JSON during a laser job (fileName, remainingTime, …)
- [ ] Note any missing datapoints for v1

## Phase 1 — core polling (v0.1)

- [x] Config: `host`, `pollInterval`, optional `apiToken`
- [x] `lib/snapmakerApi.js` — connect + status with token reuse
- [x] Persist token in expert state `info.apiToken`; re-auth on `401`
- [x] Poll loop via `setTimeout` chain
- [x] States: connection, series, toolHead, status, currentJob.*
- [x] Offline logging: one **info** on go-offline, one **info** on back online
- [x] README Configuration / Data Points keep in sync
- [x] Unit tests for helpers; package tests via CI

## Phase 2 — nice-to-have (after v0.1)

- [ ] Toolhead / head type (laser / CNC / print)
- [ ] Positions `x` / `y` / `z`
- [ ] Temperatures when print head attached
- [ ] Human-readable remaining time string (optional)
- [ ] Document A150 / A250 as community feedback

## Explicit non-goals (v1)

- File upload / start / pause / stop / remote control
- Artisan / J1 SACP protocol
- Snapmaker U1 / Moonraker
- Snapmaker Cloud account integration
- Multi-machine discovery beyond one host per instance (multi-instance OK)

## Logging (offline)

- Unreachable machine: one **info** log on transition offline, one **info** on back online
- Do not flood the log every poll cycle (`EHOSTUNREACH`, `ECONNREFUSED`, timeout, …)
