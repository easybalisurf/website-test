// migrate.js — gated, run-once schema migrations, guarded by a MySQL advisory lock so two
// Railway instances can't race on deploy. Base tables + additive column ALTERs still live in
// db.createTables (idempotent CREATE/ALTER-if-not-exists); THIS runner owns new infra tables and
// records every migration in schema_migrations so it runs exactly once, not on every boot.

const log = require('./logger');

const MIGRATIONS = [
  {
    id: '001_outbox',
    sql: `CREATE TABLE IF NOT EXISTS outbox (
      id INT AUTO_INCREMENT PRIMARY KEY,
      kind VARCHAR(64) NOT NULL,
      payload JSON NOT NULL,
      status ENUM('pending','done','failed') NOT NULL DEFAULT 'pending',
      attempts INT NOT NULL DEFAULT 0,
      last_error TEXT NULL,
      next_attempt_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_due (status, next_attempt_at)
    ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  },
  {
    id: '002_pool_dm_msgs',
    sql: `ALTER TABLE orders ADD COLUMN pool_dm_msgs JSON NULL`
  },
  {
    id: '003_seed_reviews',
    // Seed a few published reviews so the site testimonials aren't empty at launch. They use
    // high synthetic order_ids (900001+) so they never collide with real bookings, and they're
    // ordinary rows in the bot's Reviews list — the super_admin can hide/delete any of them,
    // which instantly removes it from the site (proof the site is bot-managed).
    sql: `INSERT IGNORE INTO reviews (order_id, instructor_id, client_name, sport_type, spot, rating, text, status, created_at) VALUES
      (900001, NULL, 'Marta K.', 'surf', 'Batu Bolong', 5, 'Went from never standing up to riding green waves in three sessions. My coach read the ocean like a book.', 'published', NOW()),
      (900002, NULL, 'James R.', 'surf', 'Berawa', 5, 'Best spot pick every single day — never wasted a session on a flat morning. Booking took two minutes.', 'published', NOW()),
      (900003, NULL, 'Sofia L.', 'kite', 'Sanur', 5, 'Super patient instructor and spot-on wind timing. Felt safe the whole time and had a blast.', 'published', NOW()),
      (900004, NULL, 'Daniel P.', 'wing', 'Nusa Dua', 5, 'The forecast matching is legit — got glassy conditions exactly as promised. Highly recommend.', 'published', NOW()),
      (900005, NULL, 'Aiko T.', 'sup', 'Sanur', 4, 'Calm, beautiful paddle at sunrise. Great for a first-timer, would come back.', 'published', NOW())`
  },
  {
    id: '004_admin_bcast_msgs',
    sql: `ALTER TABLE orders ADD COLUMN admin_bcast_msgs JSON NULL`
  },
  {
    id: '005_places',
    sql: `CREATE TABLE IF NOT EXISTS places (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      sort INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  },
  {
    id: '006_places_seed',
    sql: `INSERT INTO places (name, sort, is_active) SELECT 'Bali', 0, 1 FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM places)`
  },
  {
    id: '007_spots_place_id',
    sql: `ALTER TABLE spots ADD COLUMN place_id INT NULL`
  },
  {
    id: '008_spots_place_backfill',
    sql: `UPDATE spots SET place_id = (SELECT id FROM places ORDER BY sort, id LIMIT 1) WHERE place_id IS NULL`
  },
  {
    id: '009_service_prices_place_id',
    // Nullable, additive only — existing reads (catalog.js, /catalog) are untouched this step.
    // NULL = "applies to every place" (today's behaviour, since there's one place). A future
    // per-place override is a second row for the same service_id with a specific place_id.
    sql: `ALTER TABLE service_prices ADD COLUMN place_id INT NULL`
  },
  {
    id: '010_place_lombok',
    sql: `INSERT INTO places (name, sort, is_active) SELECT 'Lombok', 1, 1 FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM places WHERE name = 'Lombok')`
  },
  {
    id: '011_price_place_sentinel',
    // place_id=0 is the sentinel for "all places" (MySQL treats NULLs as distinct in a UNIQUE
    // key, so NULL can't be the shared/global value — 0 can, since no real place has id 0).
    sql: `UPDATE service_prices SET place_id = 0 WHERE place_id IS NULL`
  },
  {
    id: '012_price_place_notnull',
    sql: `ALTER TABLE service_prices MODIFY COLUMN place_id INT NOT NULL DEFAULT 0`
  },
  {
    id: '013_price_place_unique',
    // Old uq_price(service_id, level) only allowed ONE row per service+level — no room for a
    // per-place override. New key adds place_id so a place-specific row (place_id = that place's
    // id) can coexist with the all-places row (place_id = 0).
    sql: `ALTER TABLE service_prices DROP INDEX uq_price, ADD UNIQUE KEY uq_price (service_id, level, place_id)`
  },
  {
    id: '014_orders_is_test',
    // Orders created while Sandbox mode is on get flagged so Danger Zone can purge exactly
    // the test batch without touching real bookings.
    sql: `ALTER TABLE orders ADD COLUMN is_test TINYINT NOT NULL DEFAULT 0`
  }
];

async function run(pool) {
  await pool.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      id VARCHAR(64) PRIMARY KEY,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`
  );
  const [[lock]] = await pool.execute("SELECT GET_LOCK('easybali_migrate', 30) AS ok");
  if (!lock || !lock.ok) { log.warn('migrate: lock not acquired, another instance is migrating'); return; }
  try {
    const [done] = await pool.execute('SELECT id FROM schema_migrations');
    const applied = new Set(done.map(r => r.id));
    for (const m of MIGRATIONS) {
      if (applied.has(m.id)) continue;
      try {
        await pool.execute(m.sql);
        await pool.execute('INSERT IGNORE INTO schema_migrations (id) VALUES (?)', [m.id]);
        log.info('migration applied', { id: m.id });
      } catch (e) {
        log.error('migration failed', { id: m.id, err: e.message });
        throw e;
      }
    }
  } finally {
    try { await pool.execute("SELECT RELEASE_LOCK('easybali_migrate')"); } catch (e) {}
  }
}

module.exports = { run, MIGRATIONS };
