// outbox.js — durable side-effect queue. The booking webhook writes the order to MySQL and then
// ENQUEUES its side-effects (admin/instructor notifications, internal email) here instead of
// firing them inline. A background worker delivers them with exponential backoff, so a crash or a
// slow/failing Telegram/Resend call can never silently drop a notification. At-least-once
// delivery: handlers should be safe to re-run (they reload the order fresh).

const log = require('./logger');

async function enqueue(pool, kind, payload) {
  await pool.execute(
    "INSERT INTO outbox (kind, payload, next_attempt_at) VALUES (?, ?, NOW())",
    [kind, JSON.stringify(payload || {})]
  );
}

function startWorker(pool, handlers, opts = {}) {
  const intervalMs = opts.intervalMs || 3000;
  const maxAttempts = opts.maxAttempts || 8;
  const visibilityLockSec = opts.visibilityLockSec || 300; // if a claim dies mid-flight, retry after this
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const [rows] = await pool.execute(
        "SELECT * FROM outbox WHERE status='pending' AND next_attempt_at <= NOW() ORDER BY id LIMIT 10"
      );
      for (const row of rows) {
        // Claim atomically (push next_attempt_at forward) so a second instance can't grab it too.
        const [claim] = await pool.execute(
          "UPDATE outbox SET attempts = attempts + 1, next_attempt_at = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id = ? AND status = 'pending'",
          [visibilityLockSec, row.id]
        );
        if (!claim.affectedRows) continue;
        const attempts = row.attempts + 1;
        const handler = handlers[row.kind];
        const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {});
        try {
          if (!handler) throw new Error('no handler for outbox kind: ' + row.kind);
          await handler(payload);
          await pool.execute("UPDATE outbox SET status='done', last_error=NULL WHERE id=?", [row.id]);
        } catch (e) {
          if (attempts >= maxAttempts) {
            await pool.execute("UPDATE outbox SET status='failed', last_error=? WHERE id=?", [String(e.message).slice(0, 500), row.id]);
            log.captureError(e, { outbox: row.kind, id: row.id, gaveUp: true });
          } else {
            const backoff = Math.min(3600, Math.pow(2, attempts) * 5);
            await pool.execute(
              "UPDATE outbox SET next_attempt_at = DATE_ADD(NOW(), INTERVAL ? SECOND), last_error=? WHERE id=?",
              [backoff, String(e.message).slice(0, 500), row.id]
            );
            log.warn('outbox retry scheduled', { kind: row.kind, id: row.id, attempts, backoffSec: backoff });
          }
        }
      }
    } catch (e) {
      log.captureError(e, { where: 'outbox.tick' });
    } finally {
      running = false;
    }
  }

  const handle = setInterval(tick, intervalMs);
  handle.unref?.();
  return { tick, stop: () => clearInterval(handle) };
}

module.exports = { enqueue, startWorker };
