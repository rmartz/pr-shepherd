---
type: Reference
title: PM2 ecosystem (optional)
description: Optional PM2 process file that supervises the headless `shepherd start` daemon with auto-restart and exponential backoff.
tags: [pm2, daemon, operations, supervision]
---

# PM2 ecosystem (optional)

[PM2](https://pm2.keymetrics.io/) is an optional convenience for operators who want OS-level process supervision around the daemon — automatic restart on crash, restart on host reboot, and aggregated logs. It is **not required**: the daemon already has its own crash recovery ([#71](https://github.com/rmartz/pr-shepherd/issues/71)), and `shepherd start` runs fine on its own. Reach for PM2 only when you want supervision _outside_ the daemon.

PM2 is an **operator tool, not a project dependency** — it is intentionally absent from `package.json`. Install it globally:

```bash
npm install -g pm2
```

## Usage

The process file lives at the repository root as [`ecosystem.config.cjs`](../../ecosystem.config.cjs):

```bash
pm2 start ecosystem.config.cjs   # start the supervised daemon
pm2 logs shepherd                # tail aggregated stdout/stderr
pm2 status                       # see uptime, restarts, memory
pm2 restart shepherd             # manual restart
pm2 stop shepherd                # stop without removing
pm2 delete shepherd              # remove from PM2
```

To make the daemon survive host reboots, persist the process list and install the boot hook:

```bash
pm2 save
pm2 startup
```

## What it runs

The file declares a single app, `shepherd`, that runs the [`shepherd start`](shepherd-cli.md) CLI — the headless daemon entrypoint ([#207](https://github.com/rmartz/pr-shepherd/issues/207)) that boots the engine and runs in the foreground. PM2 keeps that foreground process alive.

| Setting                     | Value      | Why                                                                                   |
| --------------------------- | ---------- | ------------------------------------------------------------------------------------- |
| `exec_mode` / `instances`   | `fork` / 1 | The daemon is one long-lived process, not a scalable web server — never cluster mode. |
| `autorestart`               | `true`     | Restart the daemon if it exits unexpectedly.                                          |
| `exp_backoff_restart_delay` | `1000`     | Back off exponentially (starting at 1s) so a broken config does not hot-loop.         |
| `max_restarts`              | `10`       | Give up after 10 rapid failures rather than restarting forever.                       |
| `min_uptime`                | `10s`      | An exit within 10s counts as a failed start; staying up longer resets the counter.    |
| `watch`                     | `false`    | The daemon manages its own state and hot-reloads workflow files itself.               |

## Why `.cjs`

The package is ESM (`"type": "module"` in `package.json`), but PM2 loads `ecosystem.config.*` through CommonJS `require`. The `.cjs` extension forces CommonJS regardless of the package type, so the file uses `module.exports`.

## Related

- [shepherd CLI](shepherd-cli.md) — the `shepherd start` command PM2 supervises.
- [Engine Bootstrap](../subsystems/engine-bootstrap.md) — what `shepherd start` boots.
- [Local Development](../local-development.md) — running the daemon against the Firebase Emulator.
