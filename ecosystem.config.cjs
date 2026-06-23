// Optional PM2 process file for operators who want to supervise the
// headless PR Shepherd daemon outside its own crash recovery (#71).
//
// PM2 is NOT a project dependency — it is an operator tool installed
// globally (`npm i -g pm2`). This file is consumed only when an operator
// explicitly opts in:
//
//   pm2 start ecosystem.config.cjs
//   pm2 logs shepherd
//   pm2 save && pm2 startup    # survive host reboots
//
// It must be CommonJS (`.cjs`): the package is ESM (`"type": "module"`),
// but PM2 loads `ecosystem.config.*` through `require`. See
// docs/reference/pm2-ecosystem.md for the full operator note.
module.exports = {
  apps: [
    {
      name: "shepherd",
      // Run the `shepherd start` CLI (Epic 6 / #207), which boots the
      // engine and runs the daemon in the foreground — exactly the
      // long-lived process PM2 is meant to supervise.
      script: "shepherd",
      args: "start",
      // The daemon is a single long-lived process, not a web server, so
      // fork mode (one instance) is correct — never cluster mode.
      exec_mode: "fork",
      instances: 1,
      // Auto-restart on crash, but back off exponentially and give up
      // after repeated rapid failures so a hard-broken config does not
      // spin in a tight restart loop forever.
      autorestart: true,
      exp_backoff_restart_delay: 1000,
      max_restarts: 10,
      // Treat an exit within the first 10s as a failed start (counts
      // toward max_restarts); a process that stays up longer resets the
      // restart counter.
      min_uptime: "10s",
      // The daemon manages its own state and watches workflow files at
      // runtime; PM2's file watcher would fight that, so leave it off.
      watch: false,
    },
  ],
};
