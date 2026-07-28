// redisState.js — OPTIONAL Redis connection, used to persist state that must survive restarts
// (rate-limit buckets, distributed locks). Entirely optional: with no REDIS_URL, get() returns
// null and callers fall back to in-memory behaviour. `redis` is a soft dependency.
//
// NOTE: the ephemeral per-chat viewer/calendar/conversation Maps in index.js are intentionally
// left in memory — losing them on a redeploy only means a user re-opens a menu, which is
// harmless. Durable data (orders, audit, outbox) already lives in MySQL. Wire Redis here as the
// project grows to multiple instances.

let client = null;
let connecting = null;

async function get() {
  if (!process.env.REDIS_URL) return null;
  if (client) return client;
  if (!connecting) {
    connecting = (async () => {
      try {
        const { createClient } = require('redis');
        const c = createClient({ url: process.env.REDIS_URL });
        c.on('error', () => {}); // never let a redis blip crash the bot
        await c.connect();
        client = c;
        return c;
      } catch (e) {
        return null;
      }
    })();
  }
  return connecting;
}

module.exports = { get, enabled: () => !!process.env.REDIS_URL };
