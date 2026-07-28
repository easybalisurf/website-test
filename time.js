// time.js — Bali is WITA (UTC+8), no DST. Same pattern as the reference
// SkiSchool bot's Georgia helpers, just a different fixed offset.

const BALI_OFFSET_MINUTES = 8 * 60;

// "YYYY-MM-DD HH:MM:SS" for the current moment in Bali wall-clock time,
// optionally shifted by offsetMinutes (e.g. +180 for "3 hours from now").
function nowBaliString(offsetMinutes = 0) {
  const shifted = new Date(Date.now() + (BALI_OFFSET_MINUTES + offsetMinutes) * 60000);
  return shifted.toISOString().slice(0, 19).replace('T', ' ');
}

function nowBaliDate(offsetMinutes = 0) {
  return new Date(Date.now() + offsetMinutes * 60000);
}

// Converts a naive Bali local date+time string into a real UTC Date.
function baliToUtcDate(dateStr, timeStr) {
  const [y, mo, da] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const asIfUtc = Date.UTC(y, mo - 1, da, hh, mm, 0);
  return new Date(asIfUtc - BALI_OFFSET_MINUTES * 60000);
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Formats a `created_at`-style value as "DD Mon YYYY, HH:MM" for order cards. With the
// MySQL pool configured `dateStrings: true` (see db.js), this arrives as a plain
// "YYYY-MM-DD HH:MM:SS" string — already Bali wall-clock time since every write uses
// nowBaliString() — so no Date object / timezone math is needed or wanted here.
function formatBaliDateTime(value) {
  if (!value) return '—';
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return String(value);
  const [, y, mo, da, hh, mi] = m;
  return `${da} ${MONTHS[Number(mo) - 1]} ${y}, ${hh}:${mi}`;
}

module.exports = { nowBaliString, nowBaliDate, baliToUtcDate, formatBaliDateTime, BALI_OFFSET_MINUTES };
