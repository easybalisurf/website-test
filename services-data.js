// services-data.js — pricing & locations. Edit here to add service packages, change prices, or add surf spots — no other file needs to change.

window.SERVICES_DATA = {
  // The Place = the destination that contains all the spots (a region/island). Our case: Bali.
  // Multi-place FUTURE: each place gets its own site; `url` is this place's own site (used only
  // when there's more than one place — clicking another place then navigates there instead of
  // switching in-page state, since each place is a separate deployment).
  place: 'Bali',
  places: [ { name: 'Bali', url: 'https://easybali.surf' } ],
  // Dates on which sessions CANNOT be booked (holidays, sold-out blocks, closed days).
  // Add a single date '2026-08-17', or an inclusive range ['2026-08-01','2026-08-05'].
  //   all  → blocks every discipline
  //   surf/kite/wing/sup → blocks only that discipline
  // Edit here only — the booking form and Live Forecast both read this automatically.
  // (For calendar-driven availability instead of a manual list, the site would need the
  //  bot backend to expose easybalisurf@gmail.com's per-discipline calendars — client-side
  //  Google Calendar access can't be done securely without that server piece.)
  blockedDates: {
    all:  [],   // e.g. '2026-08-17', ['2026-12-24','2026-12-26']
    surf: [], kite: [], wing: [], sup: []
  },
  // Private lesson pricing — a 2-hour session for 1 person is the reference unit.
  // base = price for rider #1; extraPerson = added price per additional rider in the same session/package.
  // Surf has its own level-based tier (levelOpts index 3 = "Advanced") since advanced coaching costs more;
  // other disciplines don't split by level so use a single tier.
  // rental is per person per rental day; deposit = approx. refundable security deposit per rented set (not charged upfront).
  sessionPricing: {
    surf: {
      standard: { base: 80, extraPerson: 55, extraPct: 70, rental: 20, deposit: 100, rentalEnabled: true, mediaEnabled: true, transfersEnabled: true, rentalDiscountPct: 0, mediaDiscountPct: 0 },
      advanced: { base: 90, extraPerson: 65, extraPct: 72 },
      durationHours: 2
    },
    kite: { base: 140, extraPerson: 100, extraPct: 70, rental: 45, deposit: 400, durationHours: 2 },
    wing: { base: 160, extraPerson: 115, extraPct: 72, rental: 40, deposit: 350, durationHours: 2 },
    sup:  { base: 70,  extraPerson: 50,  extraPct: 70, rental: 15, deposit: 80, durationHours: 2 }
  },
  // Multi-session discount: price per session decreases linearly with each additional session (1–5 sessions).
  // "standard" applies to every non-advanced booking (all disciplines); "advanced" is surf-only (levelOpts index 3).
  // multiplier(n) = 1 - rate * (n - 1), applied to the single-session base/extraPerson price. Rates carried over
  // unchanged from the previous $70/$80 pricing — they're proportional discounts, not tied to the absolute price.
  packageMultipliers: {
    standard: { baseRate: 1/14, extraRate: 0.1 },
    advanced: { baseRate: 0.0625, extraRate: 1/12 }
  },
  // Flat add-on fee per 2h session (not scaled by headcount) — combined photo + video + drone footage & edit.
  // transferMarkupPct = % added on top of the average Grab fare estimate for transfers.
  addonPricing: {
    media: 200,
    transferMarkupPct: 20
  },
  // Pick-up areas for transfers, with rough [lat, lon] — used to estimate transfer price vs. a destination spot
  transferOrigins: {
    'Canggu': [-8.6478, 115.1385], 'Seminyak': [-8.6905, 115.1568], 'Kuta': [-8.7215, 115.1686],
    'Jimbaran': [-8.7909, 115.1573], 'Uluwatu': [-8.8291, 115.0849], 'Ubud': [-8.5069, 115.2625],
    'Sanur': [-8.6870, 115.2626], 'Nusa Dua': [-8.7961, 115.2280], 'Airport (DPS)': [-8.7467, 115.1670]
  },
  // [lat, lon] for each named surf spot (used for the same transfer-distance estimate)
  spotCoords: {
    'Kuta Beach': [-8.717, 115.168], 'Batu Bolong': [-8.657, 115.128], 'Seminyak Beach': [-8.690, 115.157],
    'Kuta Reef': [-8.735, 115.160], 'Balangan': [-8.792, 115.122], 'Berawa': [-8.668, 115.135],
    'Medewi': [-8.435, 114.803], 'Uluwatu': [-8.815, 115.088], 'Padang Padang': [-8.808, 115.103],
    'Keramas': [-8.596, 115.331], 'Sanur Lagoon': [-8.703, 115.262], 'Nusa Lembongan': [-8.681, 115.447],
    'Sanur Reef': [-8.712, 115.268], 'Tanjung Benoa': [-8.760, 115.222], 'Mushroom Bay': [-8.681, 115.446],
    'Sanur Beach': [-8.687, 115.263], 'Legian Beach': [-8.706, 115.167], 'Echo Beach': [-8.661, 115.125],
    "Old Man's": [-8.658, 115.130], 'Nusa Dua': [-8.799, 115.227], 'Pererenan': [-8.645, 115.117],
    'Dreamland': [-8.799, 115.128], 'Bingin': [-8.795, 115.116], 'Impossibles': [-8.804, 115.106],
    'Green Bowl': [-8.854, 115.176], 'Balian': [-8.404, 114.925]
  },
  // Spot pools per discipline. Surf is further split by level (0=first timer .. 3=advanced) since
  // beginner-friendly breaks differ from advanced reef breaks. Each entry: { lat, lon, shore, name, region }.
  spots: {
    surf: {
      0: [
        { lat:-8.717, lon:115.168, shore:245, name:'Kuta Beach',     region:'Kuta' },
        { lat:-8.657, lon:115.128, shore:250, name:'Batu Bolong',    region:'Canggu' },
        { lat:-8.690, lon:115.157, shore:250, name:'Seminyak Beach', region:'Seminyak' },
        { lat:-8.687, lon:115.263, shore:95,  name:'Sanur Beach',    region:'Sanur' },
        { lat:-8.706, lon:115.167, shore:245, name:'Legian Beach',   region:'Legian' }
      ],
      1: [
        { lat:-8.657, lon:115.128, shore:250, name:'Batu Bolong', region:'Canggu' },
        { lat:-8.735, lon:115.160, shore:245, name:'Kuta Reef',   region:'Kuta' },
        { lat:-8.792, lon:115.122, shore:235, name:'Balangan',    region:'Bukit' },
        { lat:-8.661, lon:115.125, shore:250, name:'Echo Beach',  region:'Canggu' },
        { lat:-8.658, lon:115.130, shore:250, name:"Old Man's",   region:'Canggu' },
        { lat:-8.799, lon:115.227, shore:140, name:'Nusa Dua',    region:'Nusa Dua' }
      ],
      2: [
        { lat:-8.792, lon:115.122, shore:235, name:'Balangan',   region:'Bukit' },
        { lat:-8.668, lon:115.135, shore:250, name:'Berawa',     region:'Canggu' },
        { lat:-8.435, lon:114.803, shore:210, name:'Medewi',     region:'West Bali' },
        { lat:-8.645, lon:115.117, shore:250, name:'Pererenan',  region:'Canggu' },
        { lat:-8.799, lon:115.128, shore:225, name:'Dreamland',  region:'Bukit' }
      ],
      3: [
        { lat:-8.815, lon:115.088, shore:225, name:'Uluwatu',      region:'Bukit' },
        { lat:-8.808, lon:115.103, shore:225, name:'Padang Padang', region:'Bukit' },
        { lat:-8.596, lon:115.331, shore:110, name:'Keramas',      region:'East Bali' },
        { lat:-8.795, lon:115.116, shore:225, name:'Bingin',       region:'Bukit' },
        { lat:-8.804, lon:115.106, shore:225, name:'Impossibles',  region:'Bukit' },
        { lat:-8.854, lon:115.176, shore:180, name:'Green Bowl',   region:'Bukit' },
        { lat:-8.404, lon:114.925, shore:210, name:'Balian',       region:'West Bali' }
      ]
    },
    kite: [
      { lat:-8.703, lon:115.262, shore:95,  name:'Sanur Lagoon',    region:'Sanur' },
      { lat:-8.681, lon:115.447, shore:150, name:'Nusa Lembongan',  region:'Nusa' }
    ],
    wing: [
      { lat:-8.712, lon:115.268, shore:95,  name:'Sanur Reef',      region:'Sanur' },
      { lat:-8.681, lon:115.447, shore:150, name:'Nusa Lembongan',  region:'Nusa' }
    ],
    sup: [
      { lat:-8.703, lon:115.262, shore:95,  name:'Sanur Lagoon',    region:'Sanur' },
      { lat:-8.760, lon:115.222, shore:100, name:'Tanjung Benoa',   region:'Benoa' },
      { lat:-8.681, lon:115.446, shore:150, name:'Mushroom Bay',    region:'Nusa' }
    ]
  }
};

// True if `dateStr` (YYYY-MM-DD) is unavailable for the given discipline key (surf/kite/wing/sup).
window.SERVICES_DATA.isDateBlocked = function (sportKey, dateStr) {
  if (!dateStr) return false;
  const B = window.SERVICES_DATA.blockedDates || {};
  const hit = list => (list || []).some(e => Array.isArray(e) ? (dateStr >= e[0] && dateStr <= e[1]) : dateStr === e);
  return hit(B.all) || hit(B[sportKey]);
};
