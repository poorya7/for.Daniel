// PM2 process tree, source-controlled.
//
// Run on the host:
//
//   pm2 startOrReload ecosystem.config.js
//   pm2 save
//
// Safe to re-run — `startOrReload` upserts each app and zero-downtime
// restarts the running ones.

module.exports = {
  apps: [
    {
      // FastAPI / uvicorn server. Single-worker is a hard launch
      // invariant — the in-process rate limiter and single-flight dedup
      // are not multi-process safe. Multi-worker would let each worker
      // independently exceed upstream vendor rate limits.
      name: 'recapshark',
      script: 'pipeline/start.sh',
      cwd: '/opt/recapshark',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      // Watch mode is intentionally OFF — deploys are explicit
      // (`pm2 restart` after `git pull && npm run build`). Watch would
      // cause restart storms during a multi-file `git pull`.
      watch: false,
    },
    {
      // Hourly ETL: pulls 2 days from BigQuery → upserts Supabase
      // sessions. `--no-autorestart` + `cron_restart` together = "only
      // fire on the cron tick, exit cleanly when done, do NOT relaunch
      // on exit." Status shows `stopped` between ticks — that's correct.
      name: 'etl-sessions',
      script: '/opt/recapshark/pipeline/venv/bin/python',
      args: ['-m', 'pipeline.etl_sessions', '2'],
      cwd: '/opt/recapshark',
      interpreter: 'none',          // script IS the interpreter
      autorestart: false,
      cron_restart: '5 * * * *',    // every hour at :05 UTC
    },
  ],
};
