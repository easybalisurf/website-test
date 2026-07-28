// logger.js — structured JSON logging + optional Sentry error capture.
// Sentry is a SOFT dependency: enabled only if SENTRY_DSN is set AND @sentry/node is installed,
// so the bot runs fine without it. All logs are single-line JSON for easy ingestion by Railway
// log drains / any aggregator.

let Sentry = null;
try {
  if (process.env.SENTRY_DSN) {
    Sentry = require('@sentry/node');
    Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV || 'production', tracesSampleRate: 0 });
  }
} catch (e) { Sentry = null; }

function line(level, msg, meta) {
  const rec = { t: new Date().toISOString(), level, msg, ...(meta || {}) };
  let s;
  try { s = JSON.stringify(rec); } catch (e) { s = JSON.stringify({ t: rec.t, level, msg }); }
  if (level === 'error') console.error(s);
  else if (level === 'warn') console.warn(s);
  else console.log(s);
}

module.exports = {
  info: (msg, meta) => line('info', msg, meta),
  warn: (msg, meta) => line('warn', msg, meta),
  error: (msg, meta) => line('error', msg, meta),
  captureError(err, ctx) {
    const e = err instanceof Error ? err : new Error(String(err));
    line('error', e.message, { stack: e.stack, ...(ctx || {}) });
    if (Sentry) { try { Sentry.captureException(e, { extra: ctx || {} }); } catch (x) {} }
  },
  sentryEnabled: () => !!Sentry
};
