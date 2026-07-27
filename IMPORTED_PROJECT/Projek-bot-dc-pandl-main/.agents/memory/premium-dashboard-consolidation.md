---
name: Duplicate premium dashboard removed
description: Why there were two premium/limit monitoring panels and which one survived.
---

`features/monitoring/dashboard.js` (`mon:` custom-id namespace) and
`features/premium/statsDashboard.js` (`ps:` namespace, backing `/premstats`) were both wired
into the exact same six call sites (addprem, removeprem, resetlimit, setlimit, ready.js,
premium sweep) — every premium/limit change updated both panels, producing two live,
near-duplicate embeds in the channel simultaneously.

**Why:** `statsDashboard.js`'s own header comment called it the "modern replacement" for the
monitoring panel, but the migration was never finished — both were left running.

**How to apply:** `features/monitoring/` was deleted; `statsDashboard.js` is now the only
premium/limit panel. If you see a reference to `updateMonitoringDashboard` or a `mon:` custom-id
anywhere, it's stale — route through `updatePremStatsDashboard` / the `ps:` namespace instead.
Old `mon:` buttons on pre-existing Discord messages will no longer respond; that message should
be deleted manually.
