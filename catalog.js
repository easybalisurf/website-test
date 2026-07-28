// catalog.js — service catalog (disciplines / services / per-level prices / spots) stored in
// MySQL and managed by the super-admin from inside the bot. Two jobs:
//
//   1. Source of truth for pricing & spots. The website fetches GET /catalog (see index.js)
//      and rebuilds its window.SERVICES_DATA from it, so the Live Forecast and the booking
//      form always reflect what the super-admin configured — no redeploy to change a price
//      or add a spot. A static services-data.js stays in the site as an offline fallback.
//
//   2. Anti-fraud server-side price recompute. The booking webhook NEVER trusts the price the
//      browser sends: recomputeQuote() re-derives the coaching price + deposit from this
//      catalog and the order is rejected/flagged if the client-sent number disagrees.
//
// Design goal: adding a discipline / service / spot only ADDS rows — nothing about the existing
// surf flow changes, so the site can't break when the catalogue grows.

const LEVELS = ['first-timer', 'beginner', 'intermediate', 'advanced'];
const round5 = x => Math.round(x / 5) * 5;

// Pickup areas for transfer-fare estimates. These are client origins (towns), not surf spots,
// so they live here as a constant rather than in the editable spots table.
const TRANSFER_ORIGINS = {
  'Canggu': [-8.6478, 115.1385], 'Seminyak': [-8.6905, 115.1568], 'Kuta': [-8.7215, 115.1686],
  'Jimbaran': [-8.7909, 115.1573], 'Uluwatu': [-8.8291, 115.0849], 'Ubud': [-8.5069, 115.2625],
  'Sanur': [-8.6870, 115.2626], 'Nusa Dua': [-8.7961, 115.2280], 'Airport (DPS)': [-8.7467, 115.1670]
};

let poolRef = null;

async function init(pool) {
  poolRef = pool;
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS disciplines (
      id INT AUTO_INCREMENT PRIMARY KEY,
      dkey VARCHAR(30) UNIQUE NOT NULL,        -- surf | kite | wing | sup | ...
      label VARCHAR(100) NOT NULL,
      sort INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS services (
      id INT AUTO_INCREMENT PRIMARY KEY,
      discipline_id INT NOT NULL,
      skey VARCHAR(40) NOT NULL,               -- private2h | ...
      label VARCHAR(150) NOT NULL,
      duration_hours DECIMAL(4,2) NOT NULL DEFAULT 2,
      max_group INT NOT NULL DEFAULT 1,        -- max riders per session (adjustable per service)
      -- multi-session discount: per-session price = base * (1 - base_rate*(n-1)),
      -- extra-person price = extra * (1 - extra_rate*(n-1)); adv_* override for advanced level.
      base_rate DECIMAL(6,5) NOT NULL DEFAULT 0,
      extra_rate DECIMAL(6,5) NOT NULL DEFAULT 0,
      adv_base_rate DECIMAL(6,5) NOT NULL DEFAULT 0,
      adv_extra_rate DECIMAL(6,5) NOT NULL DEFAULT 0,
      -- Additional-rider price is a PERCENT of the (discounted) base, added per extra rider and
      -- rounded to the nearest $5 — not a flat dollar amount. adv_extra_pct overrides for advanced.
      extra_pct DECIMAL(6,3) NOT NULL DEFAULT 0,
      adv_extra_pct DECIMAL(6,3) NOT NULL DEFAULT 0,
      -- pricing_model leaves room for future service kinds without breaking this one:
      --   'private' (per-rider, current) | 'group' (fixed slots+spots, pool-filled) | 'tour' (multi-day)
      pricing_model VARCHAR(20) NOT NULL DEFAULT 'private',
      rental INT NOT NULL DEFAULT 0,           -- per person per session
      deposit INT NOT NULL DEFAULT 0,          -- refundable security deposit per rented set
      media INT NOT NULL DEFAULT 0,            -- photo+video+drone flat fee per shot session
      sort INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      UNIQUE KEY uq_service (discipline_id, skey),
      INDEX idx_disc (discipline_id)
    ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS service_prices (
      id INT AUTO_INCREMENT PRIMARY KEY,
      service_id INT NOT NULL,
      level VARCHAR(20) NOT NULL,              -- first-timer | beginner | intermediate | advanced
      base INT NOT NULL DEFAULT 0,             -- price for rider #1, single session
      extra_person INT NOT NULL DEFAULT 0,     -- added price per extra rider
      UNIQUE KEY uq_price (service_id, level),
      INDEX idx_service (service_id)
    ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS spots (
      id INT AUTO_INCREMENT PRIMARY KEY,
      discipline_id INT NOT NULL,
      level VARCHAR(20) NULL,                  -- surf splits by level; other disciplines use NULL (single pool)
      name VARCHAR(120) NOT NULL,
      lat DECIMAL(9,6) NOT NULL,
      lon DECIMAL(9,6) NOT NULL,
      shore INT NOT NULL DEFAULT 0,            -- shore-normal bearing (deg) for the forecast model
      region VARCHAR(80),
      rental_price INT NULL,                   -- per-spot rental override; NULL = use the service's default price
      sort INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      INDEX idx_disc_level (discipline_id, level)
    ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS languages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(10) UNIQUE NOT NULL,        -- en | ru | zh | ...
      label VARCHAR(60) NOT NULL,              -- English | Russian | ...
      sort INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1
    ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS blocked_periods (
      id INT AUTO_INCREMENT PRIMARY KEY,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      note VARCHAR(200),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS custom_addons (
      id INT AUTO_INCREMENT PRIMARY KEY,
      akey VARCHAR(40) UNIQUE NOT NULL,
      label_en VARCHAR(150) NOT NULL,
      label_ru VARCHAR(150) NOT NULL,
      price INT NOT NULL DEFAULT 0,
      discount_pct DECIMAL(5,2) NOT NULL DEFAULT 0,   -- % off per extra session/day, like media
      sort INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1
    ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  // Additive migrations for columns introduced after the initial CREATE TABLE (idempotent).
  const catMigrations = [
    'ALTER TABLE services ADD COLUMN extra_pct DECIMAL(6,3) NOT NULL DEFAULT 0',
    'ALTER TABLE services ADD COLUMN adv_extra_pct DECIMAL(6,3) NOT NULL DEFAULT 0',
    "ALTER TABLE services ADD COLUMN pricing_model VARCHAR(20) NOT NULL DEFAULT 'private'",
    'ALTER TABLE services ADD COLUMN max_group INT NOT NULL DEFAULT 1',
    'ALTER TABLE services ADD COLUMN rental_enabled TINYINT(1) NOT NULL DEFAULT 1',
    'ALTER TABLE services ADD COLUMN media_enabled TINYINT(1) NOT NULL DEFAULT 1',
    'ALTER TABLE services ADD COLUMN transfers_enabled TINYINT(1) NOT NULL DEFAULT 1',
    'ALTER TABLE services ADD COLUMN rental_discount_pct DECIMAL(5,2) NOT NULL DEFAULT 0',
    'ALTER TABLE services ADD COLUMN media_discount_pct DECIMAL(5,2) NOT NULL DEFAULT 0',
    // Backfill the seeded surf service if it predates the extra_pct column (was 0 → extra riders
    // would price at $0). 70/72% reproduce the previous $55/$65 extra. Only touches the untouched seed.
    "UPDATE services SET extra_pct = 70 WHERE skey = 'private2h' AND extra_pct = 0",
    "UPDATE services SET adv_extra_pct = 72 WHERE skey = 'private2h' AND adv_extra_pct = 0",
    'ALTER TABLE spots ADD COLUMN rental_price INT NULL'
  ];
  for (const mm of catMigrations) {
    try { await pool.execute(mm); } catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') console.log('⚠️ catalog migration:', e.message); }
  }
  // Seed the two existing languages once (English, Russian) — these are what the site & bot use today.
  const [[{ ln }]] = await pool.execute('SELECT COUNT(*) AS ln FROM languages');
  if (ln === 0) {
    await pool.execute("INSERT INTO languages (code, label, sort, is_active) VALUES ('en','English',0,1), ('ru','Russian',1,1)");
    console.log('✅ languages seeded (en, ru)');
  }
  await seedSurfIfEmpty();
}

// One-time seed of the current surf catalogue (mirrors the site's original services-data.js).
// Runs only when the disciplines table is empty, so re-deploys never clobber super-admin edits.
async function seedSurfIfEmpty() {
  const [[{ n }]] = await poolRef.execute('SELECT COUNT(*) AS n FROM disciplines');
  if (n > 0) return;

  const disc = [
    ['surf', 'Surf', 0, 1],
    ['kite', 'Kite', 1, 0],   // seeded but hidden until the super-admin activates them
    ['wing', 'Wing', 2, 0],
    ['sup',  'SUP',  3, 0]
  ];
  const discId = {};
  for (const [dkey, label, sort, active] of disc) {
    const [r] = await poolRef.execute(
      'INSERT INTO disciplines (dkey, label, sort, is_active) VALUES (?, ?, ?, ?)', [dkey, label, sort, active]);
    discId[dkey] = r.insertId;
  }

  // Surf: one 2h private service. base package discount carried over (standard 1/14, advanced
  // 0.0625). Extra-rider price is a PERCENT of base, rounded to $5 — 70% & 72% reproduce the
  // previous $55 / $65 extra ($80×70%≈55; $90×72%≈65).
  const [svc] = await poolRef.execute(
    `INSERT INTO services (discipline_id, skey, label, duration_hours, base_rate, extra_rate, adv_base_rate, adv_extra_rate, extra_pct, adv_extra_pct, rental, deposit, media, sort, is_active)
     VALUES (?, 'private2h', 'Single Private session (2h)', 2, ?, ?, ?, ?, 70, 72, 20, 100, 200, 0, 1)`,
    [discId.surf, (1/14).toFixed(5), (0.1).toFixed(5), (0.0625).toFixed(5), (1/12).toFixed(5)]);
  const surfSvc = svc.insertId;

  const prices = [
    ['first-timer', 80, 55], ['beginner', 80, 55], ['intermediate', 80, 55], ['advanced', 90, 65]
  ];
  for (const [lvl, base, extra] of prices)
    await poolRef.execute('INSERT INTO service_prices (service_id, level, base, extra_person) VALUES (?, ?, ?, ?)', [surfSvc, lvl, base, extra]);

  // Surf spots per level (from the original spots.surf pools)
  const surfSpots = {
    'first-timer': [
      ['Kuta Beach', -8.717, 115.168, 245, 'Kuta'], ['Batu Bolong', -8.657, 115.128, 250, 'Canggu'],
      ['Seminyak Beach', -8.690, 115.157, 250, 'Seminyak'], ['Sanur Beach', -8.687, 115.263, 95, 'Sanur']
    ],
    'beginner': [
      ['Batu Bolong', -8.657, 115.128, 250, 'Canggu'], ['Kuta Reef', -8.735, 115.160, 245, 'Kuta'], ['Balangan', -8.792, 115.122, 235, 'Bukit']
    ],
    'intermediate': [
      ['Balangan', -8.792, 115.122, 235, 'Bukit'], ['Berawa', -8.668, 115.135, 250, 'Canggu'], ['Medewi', -8.435, 114.803, 210, 'West Bali']
    ],
    'advanced': [
      ['Uluwatu', -8.815, 115.088, 225, 'Bukit'], ['Padang Padang', -8.808, 115.103, 225, 'Bukit'], ['Keramas', -8.596, 115.331, 110, 'East Bali']
    ]
  };
  for (const lvl of LEVELS) {
    let sort = 0;
    for (const [name, lat, lon, shore, region] of surfSpots[lvl])
      await poolRef.execute('INSERT INTO spots (discipline_id, level, name, lat, lon, shore, region, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [discId.surf, lvl, name, lat, lon, shore, region, sort++]);
  }
  console.log('✅ catalog seeded (surf)');
}

// Rebuild the site's window.SERVICES_DATA shape from the DB. Keeps every key the current site
// reads, so switching the site from the static file to this endpoint needs no shape changes.
async function toServicesData() {
  const p = poolRef;
  const [disc] = await p.execute('SELECT * FROM disciplines WHERE is_active = 1 ORDER BY sort, id');
  const [svcs] = await p.execute('SELECT * FROM services WHERE is_active = 1');
  const [prices] = await p.execute('SELECT * FROM service_prices');
  const [spotRows] = await p.execute('SELECT * FROM spots WHERE is_active = 1 ORDER BY sort, id');

  const priceBy = {}; for (const r of prices) (priceBy[r.service_id] ||= {})[r.level] = r;
  const svcByDisc = {}; for (const s of svcs) (svcByDisc[s.discipline_id] ||= []).push(s);

  const sessionPricing = {}, spots = {}, spotCoords = {};
  const disciplines = [];
  let pkgStd = { baseRate: 1/14, extraRate: 0.1 }, pkgAdv = { baseRate: 0.0625, extraRate: 1/12 };

  for (const d of disc) {
    disciplines.push({ key: d.dkey, label: d.label });
    const svc = (svcByDisc[d.id] || [])[0]; // primary service per discipline (private 2h)
    if (svc) {
      const pr = priceBy[svc.id] || {};
      const std = pr['first-timer'] || pr['beginner'] || Object.values(pr)[0] || { base: 0, extra_person: 0 };
      const adv = pr['advanced'] || std;
      if (d.dkey === 'surf') {
        sessionPricing.surf = {
          standard: { base: std.base, extraPerson: std.extra_person, extraPct: Number(svc.extra_pct), rental: svc.rental, deposit: svc.deposit, maxGroup: svc.max_group, rentalEnabled: !!svc.rental_enabled, mediaEnabled: !!svc.media_enabled, transfersEnabled: !!svc.transfers_enabled, rentalDiscountPct: Number(svc.rental_discount_pct), mediaDiscountPct: Number(svc.media_discount_pct) },
          advanced: { base: adv.base, extraPerson: adv.extra_person, extraPct: Number(svc.adv_extra_pct) },
          durationHours: Number(svc.duration_hours) || 2
        };
        pkgStd = { baseRate: Number(svc.base_rate), extraRate: Number(svc.extra_rate) };
        pkgAdv = { baseRate: Number(svc.adv_base_rate), extraRate: Number(svc.adv_extra_rate) };
      } else {
        sessionPricing[d.dkey] = { base: std.base, extraPerson: std.extra_person, extraPct: Number(svc.extra_pct), rental: svc.rental, deposit: svc.deposit, maxGroup: svc.max_group, rentalEnabled: !!svc.rental_enabled, mediaEnabled: !!svc.media_enabled, transfersEnabled: !!svc.transfers_enabled, rentalDiscountPct: Number(svc.rental_discount_pct), mediaDiscountPct: Number(svc.media_discount_pct), durationHours: Number(svc.duration_hours) || 2 };
      }
    }
    // spots grouped by level for surf, flat array otherwise
    const mine = spotRows.filter(s => s.discipline_id === d.id);
    if (d.dkey === 'surf') {
      const byLvl = { 0: [], 1: [], 2: [], 3: [] };
      for (const s of mine) {
        const li = LEVELS.indexOf(s.level); if (li < 0) continue;
        byLvl[li].push({ lat: Number(s.lat), lon: Number(s.lon), shore: s.shore, name: s.name, region: s.region, rentalOverride: s.rental_price == null ? null : Number(s.rental_price) });
        spotCoords[s.name] = [Number(s.lat), Number(s.lon)];
      }
      spots.surf = byLvl;
    } else {
      spots[d.dkey] = mine.map(s => {
        spotCoords[s.name] = [Number(s.lat), Number(s.lon)];
        return { lat: Number(s.lat), lon: Number(s.lon), shore: s.shore, name: s.name, region: s.region, rentalOverride: s.rental_price == null ? null : Number(s.rental_price) };
      });
    }
  }

  const [langRows] = await p.execute('SELECT code, label FROM languages WHERE is_active = 1 ORDER BY sort, id');
  const [periods] = await p.execute('SELECT start_date, end_date FROM blocked_periods');
  const blockedDates = { all: periods.map(r => [fmtDate(r.start_date), fmtDate(r.end_date)]) };
  const workHours = await getWorkHours();
  return {
    disciplines,
    sessionPricing,
    packageMultipliers: { standard: pkgStd, advanced: pkgAdv },
    addonPricing: { media: await getAddonMediaPrice(), transferMarkupPct: await getTransferMarkupPct() },
    customAddons: (await listCustomAddons(true)).map(a => ({ key: a.akey, labelEn: a.label_en, labelRu: a.label_ru, price: a.price, discountPct: Number(a.discount_pct) })),
    transferOrigins: TRANSFER_ORIGINS,
    spotCoords,
    languages: langRows.map(l => ({ code: l.code, label: l.label })),
    spots,
    blockedDates,
    workHours
  };
}
function fmtDate(d) { return (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10); }

// Server-side recompute of the fraud-sensitive numbers (coaching price + deposit) from the
// catalog — mirrors the site's own formula in Bali Surf Booking.dc.html exactly:
//   perSessionBase  = round(base  * (1 - baseRate  * (n-1)))
//   perSessionExtra = round(extra * (1 - extraRate * (n-1)))
//   coaching        = perSessionBase*n + perSessionExtra*n*(people-1)
//   deposit         = round(coaching * 0.20)
// Add-on amounts (media/rental/transfers) are pass-through: they don't feed the instructor's
// 80% cut, so we re-sum the total but don't re-derive their unit prices here.
async function recomputeQuote(payload) {
  const p = poolRef;
  const dkey = String(payload.sport || 'surf').toLowerCase();
  const [[disc]] = await p.execute('SELECT * FROM disciplines WHERE dkey = ? AND is_active = 1', [dkey]);
  if (!disc) return { ok: false, reason: 'unknown_discipline' };
  const [[svc]] = await p.execute('SELECT * FROM services WHERE discipline_id = ? AND is_active = 1 ORDER BY sort, id LIMIT 1', [disc.id]);
  if (!svc) return { ok: false, reason: 'no_service' };

  const level = normLevel(payload.skillLevel);
  const isAdvanced = dkey === 'surf' && level === 'advanced';
  const [[price]] = await p.execute('SELECT * FROM service_prices WHERE service_id = ? AND level = ?', [svc.id, level]);
  if (!price) return { ok: false, reason: 'no_price_for_level' };

  const n = Math.min(5, Math.max(1, parseInt(payload.sessionCount, 10) || (Array.isArray(payload.sessions) ? payload.sessions.length : 1) || 1));
  const people = Math.max(1, parseInt(payload.participants, 10) || 1);
  const baseRate = isAdvanced ? Number(svc.adv_base_rate) : Number(svc.base_rate);
  const extraRate = isAdvanced ? Number(svc.adv_extra_rate) : Number(svc.extra_rate);
  const extraPct = isAdvanced ? Number(svc.adv_extra_pct) : Number(svc.extra_pct);
  const perBase = Math.round(price.base * (1 - baseRate * (n - 1)));
  // Extra rider = percent of the discounted per-session base, rounded to $5. Fall back to the
  // legacy flat extra_person (with its session-discount) if the percent isn't set (>0) — mirrors the site.
  const perExtra = (Number.isFinite(extraPct) && extraPct > 0)
    ? round5(perBase * extraPct / 100)
    : Math.round((price.extra_person || 0) * (1 - extraRate * (n - 1)));
  const coaching = perBase * n + perExtra * n * (people - 1);
  const deposit = Math.round(coaching * 0.20);

  const addonsTotal = (payload.addonsBreakdown || payload.addons_breakdown || [])
    .reduce((s, a) => s + (Number(a.amount) || 0), 0);
  return {
    ok: true,
    sessionPrice: coaching,
    deposit,
    total: coaching + addonsTotal,
    discipline: dkey, level, sessions: n, people
  };
}

function normLevel(label) {
  if (!label) return 'first-timer';
  const k = String(label).trim().toLowerCase();
  const map = {
    'first timer': 'first-timer', 'first-timer': 'first-timer', 'beginner': 'beginner',
    'intermediate': 'intermediate', 'advanced': 'advanced',
    'новичок': 'first-timer', 'начинающий': 'beginner', 'средний': 'intermediate', 'продвинутый': 'advanced'
  };
  return map[k] || k;
}

// ---- Languages (shared by the bot's instructor editor and the /catalog site feed) ----
async function getLanguages() {
  const [rows] = await poolRef.execute('SELECT id, code, label FROM languages WHERE is_active = 1 ORDER BY sort, id');
  return rows;
}
async function addLanguage(code, label) {
  const c = String(code).trim().toLowerCase().replace(/[^a-z]/g, '').slice(0, 10);
  if (!c) throw new Error('bad code');
  const [[mx]] = await poolRef.execute('SELECT COALESCE(MAX(sort),-1) s FROM languages');
  await poolRef.execute('INSERT INTO languages (code, label, sort, is_active) VALUES (?, ?, ?, 1) ON DUPLICATE KEY UPDATE label = VALUES(label), is_active = 1',
    [c, String(label).trim() || c, mx.s + 1]);
  return c;
}
async function removeLanguage(id) {
  await poolRef.execute('DELETE FROM languages WHERE id = ?', [id]);
}

// ---- Blocked periods (super-admin, applies to every discipline) ----
// A period hides availability on the site and rejects new bookings for those dates; existing
// orders inside the range are left completely untouched (cancel/refund is a separate, explicit action).
async function listBlockedPeriods() {
  const [rows] = await poolRef.execute('SELECT * FROM blocked_periods ORDER BY start_date');
  return rows;
}
async function addBlockedPeriod(startDate, endDate, note) {
  const [r] = await poolRef.execute('INSERT INTO blocked_periods (start_date, end_date, note) VALUES (?, ?, ?)', [startDate, endDate, note || null]);
  return r.insertId;
}
async function removeBlockedPeriod(id) {
  await poolRef.execute('DELETE FROM blocked_periods WHERE id = ?', [id]);
}
async function isDateBlocked(dateStr) {
  const [[row]] = await poolRef.execute('SELECT COUNT(*) c FROM blocked_periods WHERE ? BETWEEN start_date AND end_date', [dateStr]);
  return row.c > 0;
}

// ---- Working hours (super-admin) — the day's first/last coaching slot start, 2h windows in between ----
// ---- Media add-on price (super-admin) — ONE price for all services, set once in Settings ----
async function getAddonMediaPrice() {
  const [[row]] = await poolRef.execute("SELECT v FROM settings WHERE k = 'addon_media_price'");
  if (!row) return 200;
  const v = Number(row.v);
  return Number.isFinite(v) ? v : 200;
}
async function setAddonMediaPrice(price) {
  await poolRef.execute('INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', ['addon_media_price', String(price)]);
}
async function getTransferMarkupPct() {
  const [[row]] = await poolRef.execute("SELECT v FROM settings WHERE k = 'transfer_markup_pct'");
  if (!row) return 20;
  const v = Number(row.v);
  return Number.isFinite(v) ? v : 20;
}
async function setTransferMarkupPct(pct) {
  await poolRef.execute('INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', ['transfer_markup_pct', String(pct)]);
}

// ---- Custom add-ons (super-admin CRUD) — extra flat-fee items beyond rental/media/transfers,
// shown on the form exactly like media: a checkbox with description + price, discounted per
// extra session/day the same way. akey is a stable slug used as the order-line `type`. ----
async function listCustomAddons(activeOnly) {
  const [rows] = await poolRef.execute('SELECT * FROM custom_addons' + (activeOnly ? ' WHERE is_active = 1' : '') + ' ORDER BY sort, id');
  return rows;
}
async function addCustomAddon(labelEn, labelRu, price, discountPct) {
  const akey = 'x' + Date.now().toString(36);
  const [[mx]] = await poolRef.execute('SELECT COALESCE(MAX(sort),-1) s FROM custom_addons');
  await poolRef.execute('INSERT INTO custom_addons (akey, label_en, label_ru, price, discount_pct, sort, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)',
    [akey, labelEn, labelRu, Math.round(price), discountPct, mx.s + 1]);
  return akey;
}
async function updateCustomAddon(id, fields) {
  const cols = [], vals = [];
  for (const [k, v] of Object.entries(fields)) { cols.push(`${k} = ?`); vals.push(v); }
  if (!cols.length) return;
  vals.push(id);
  await poolRef.execute(`UPDATE custom_addons SET ${cols.join(', ')} WHERE id = ?`, vals);
}
async function removeCustomAddon(id) {
  await poolRef.execute('DELETE FROM custom_addons WHERE id = ?', [id]);
}
async function setSpotRentalOverride(spotId, price) {
  await poolRef.execute('UPDATE spots SET rental_price = ? WHERE id = ?', [price, spotId]);
}
async function clearSpotRentalOverride(spotId) {
  await poolRef.execute('UPDATE spots SET rental_price = NULL WHERE id = ?', [spotId]);
}

async function getWorkHours() {
  const [[row]] = await poolRef.execute("SELECT v FROM settings WHERE k = 'work_hours'");
  if (!row) return { open: 8, close: 16 };
  try { return JSON.parse(row.v); } catch (e) { return { open: 8, close: 16 }; }
}
async function setWorkHours(open, close) {
  await poolRef.execute('INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', ['work_hours', JSON.stringify({ open, close })]);
}

// Slot windows for a discipline — mirrors the site's getSlotDefs() EXACTLY (same label format,
// same duration source: the discipline's primary service's duration_hours) so /availability keys
// always match what the booking form and forecast show. Any drift here silently breaks live
// availability display (the site fails open — shows everything bookable — rather than block a
// real order, so a mismatch here is invisible until someone notices slots never show as full).
async function getSlotWindows(dkey) {
  const wh = await getWorkHours();
  const [[disc]] = await poolRef.execute('SELECT * FROM disciplines WHERE dkey = ? AND is_active = 1', [dkey]);
  let durH = 2;
  if (disc) {
    const [[svc]] = await poolRef.execute('SELECT duration_hours FROM services WHERE discipline_id = ? AND is_active = 1 ORDER BY sort, id LIMIT 1', [disc.id]);
    if (svc) durH = Number(svc.duration_hours) || 2;
  }
  const stepMin = Math.round(durH * 60);
  const fmt = m => { const h = Math.floor(m / 60), mm = m % 60; return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0'); };
  const slots = [];
  for (let startMin = wh.open * 60; startMin + stepMin <= wh.close * 60; startMin += stepMin) {
    slots.push(`${fmt(startMin)} – ${fmt(startMin + stepMin)}`);
  }
  return slots;
}

module.exports = { init, toServicesData, recomputeQuote, LEVELS, TRANSFER_ORIGINS, getLanguages, addLanguage, removeLanguage, listBlockedPeriods, addBlockedPeriod, removeBlockedPeriod, isDateBlocked, getAddonMediaPrice, setAddonMediaPrice, getTransferMarkupPct, setTransferMarkupPct, getWorkHours, setWorkHours, getSlotWindows, listCustomAddons, addCustomAddon, updateCustomAddon, removeCustomAddon, setSpotRentalOverride, clearSpotRentalOverride };
