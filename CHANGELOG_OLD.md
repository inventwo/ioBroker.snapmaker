# Older changes
## 0.2.0 (2026-11-06)
- (skvarel) Added `currentJob.finishAt` (local `YYYY-MM-DD HH:MM`)

## 0.1.1 (2026-11-05)
- (skvarel) Added missing translations

## 0.1.0 (2026-11-05)
- (skvarel) First public release for Snapmaker 2.0 (A350 and compatible)
- (skvarel) Added status polling for job file name, progress, remaining/elapsed time
- (skvarel) Added laser power and work speed (`laser.power`, `laser.powerRaw`, `laser.on`, `laser.workSpeed`)
- (skvarel) Added optional Luban API token setting with `machine.json` path help
- (skvarel) Fixed connection/session handling (token validation, less aggressive reconnect)
- (skvarel) Fixed adapter-checker findings (keywords, admin dependency, encrypted apiToken, workflows, i18n)

## 0.0.1
- (skvarel) initial scaffold