// index.js — EasyBali.surf admin/instructor bot.
// Talks Telegram (Telegraf) to admins/instructors, and HTTP (Express) to the
// booking form / client-bot backend for order intake + WhatsApp-click tracking.

const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const db = require('./db');
const { t } = require('./i18n');
const time = require('./time');
const { processDepositRefund } = require('./refunds');
const refunds = require('./refunds');
const log = require('./logger');
const outbox = require('./outbox');
const migrate = require('./migrate');
let outboxWorker = null;
const email = require('./email');
const catalog = require('./catalog');
const { registerCatalogAdmin } = require('./catalog-admin');

function requireEnv(name) {
  const v = process.env[name];
  if (!v) { console.error(`✗ Missing required env var: ${name}`); process.exit(1); }
  return v;
}

const BOT_TOKEN = requireEnv('ADMIN_BOT_TOKEN');
const INSTRUCTORS_GROUP_ID = requireEnv('INSTRUCTORS_GROUP_ID');
const BOOKING_WEBHOOK_SECRET = requireEnv('BOOKING_WEBHOOK_SECRET');
const PUBLIC_BASE_URL = requireEnv('PUBLIC_BASE_URL');
const SITE_URL = process.env.SITE_URL || 'https://easybali.surf';

// ---- Cancel / reschedule policy (Bali wall-clock). Tunable via env. ----
// Free cancellation only if the first session is more than FREE_CANCEL_H away; inside that
// window the deposit is forfeited. Each order may be rescheduled RESCHEDULE_MAX time(s). A
// reschedule request needing a coach waits COACH_CONFIRM_H hours, but never past MIN_LEAD_H
// before the ORIGINAL session (so a stalled request can't leave the client without a session).
const FREE_CANCEL_H = Number(process.env.FREE_CANCEL_H || 24);
const RESCHEDULE_MAX = Number(process.env.RESCHEDULE_MAX || 1);
const COACH_CONFIRM_H = Number(process.env.COACH_CONFIRM_H || 8);
const MIN_LEAD_H = Number(process.env.MIN_LEAD_H || 12);

const bot = new Telegraf(BOT_TOKEN);
bot.catch((err) => console.error('✗ Bot error:', err));

const conversationState = new Map(); // per-admin multi-step flows (add instructor, edit order, etc.)

// ============================================================
// HELPERS
// ============================================================

const SPORT_EMOJI = { surf: '', kite: '', wing: '', sup: '' };
const SPORT_SHORT = { surf: 'Surf', kite: 'Kite', wing: 'Wing', sup: 'SUP' };
function sportShort(t) { return SPORT_SHORT[String(t).toLowerCase()] || (String(t).charAt(0).toUpperCase() + String(t).slice(1, 4)); }
const POOL_WINDOW_MIN = 3 * 60;   // 3h unclaimed in the group → refund path
const WHATSAPP_WINDOW_MIN = 5;    // 5min to message the client after taking
const MAX_BOUNCES = 3;            // after this many kicks-back, escalate instead of resending

function instructorEarnings(order) { return Math.round(order.session_price * 0.8); }

// Order-card body copy — translated by the VIEWER's language, passed in explicitly since
// an order has no language of its own (client-facing labels like "Sessions"/"Status" are
// chrome around the data, same idea as the menu/button strings in i18n.js).
const CARD = {
  en: { sessions: 'Sessions', addons: 'Add-ons', addonsClientPaid: 'Add-ons (client-paid, not part of your cut)', addonsSubtotal: 'add-ons subtotal', mediaDates: 'Shoot days', clientPrefers: 'Client prefers', level: 'Level', language: 'Language', requested: 'Requested', yourEarnings: 'Your earnings', yourEarnings80: 'Your earnings (80% of session price)', yourEarnings80Only: 'Your earnings (80% of session price only)', sessionPrice: 'Session price', total: 'Total (incl. add-ons)', deposit: 'Deposit', paid: 'paid', unpaid: 'UNPAID', status: 'Status', instructor: 'Instructor', messageClientReminder: 'Message the client on WhatsApp within 5 minutes.' },
  ru: { sessions: 'Занятия', addons: 'Допы', addonsClientPaid: 'Допы (оплачивает клиент, не входит в ваш %)', addonsSubtotal: 'итого по допам', mediaDates: 'Дни съёмки', clientPrefers: 'Клиент предпочитает', level: 'Уровень', language: 'Язык', requested: 'Заявка от', yourEarnings: 'Ваш заработок', yourEarnings80: 'Ваш заработок (80% от цены занятия)', yourEarnings80Only: 'Ваш заработок (только 80% от цены занятия)', sessionPrice: 'Цена занятия', total: 'Итого (с допами)', deposit: 'Депозит', paid: 'оплачен', unpaid: 'НЕ ОПЛАЧЕН', status: 'Статус', instructor: 'Инструктор', messageClientReminder: 'Напишите клиенту в WhatsApp в течение 5 минут.' }
};
function c(lang, key) { return (CARD[lang] && CARD[lang][key]) || CARD.en[key]; }

// Small extra strings not worth a full i18n.js entry — admin/super_admin management
// screens (Admins/Instructors CRUD) stay English-only since that's internal ops tooling;
// anything an instructor sees (Pending/All/My orders empty states) is translated here.
const MISC = {
  en: {
    nothing_pending: 'Nothing pending.', no_orders: 'No orders yet.', no_my_orders: 'You have no orders yet.',
    viewer_loading: 'Loading…', empty_current: 'All clear — no active orders right now.', empty_all: 'No orders yet.', empty_refunds: 'All refunds settled.', empty_my_current: 'No active sessions right now.', empty_my_all: 'No sessions yet.',
    finances_title: 'Finances', active_orders: 'Orders', gross_revenue: 'Gross revenue', deposits_collected: 'Deposits collected', refunded_pending: 'Refunded',
    your_earnings_title: 'Your earnings', orders_word: 'Orders', earnings_total: 'Total (excl. add-ons)',
    instructor_earnings_title: 'Instructor earnings', no_instructor_activity: 'No instructor activity yet.', orders_suffix: 'orders',
    period_all: 'All Time', period_week: 'Week', period_month: 'Month',
    sessions_revenue: 'Sessions revenue', addons_revenue: 'Add-ons revenue', deposits_income: 'Deposits',
    top_instructors: 'Top instructors', no_data: 'No data for this period.',
    no_admins: 'No admins yet.', add_new_admin: 'Add a new admin:', add_admin_btn: '+ Add admin', send_admin_username: 'Send the new admin\'s @telegram_username:', added_as_admin: 'added as admin. Ask them to send /start to this bot.', remove_btn: 'Remove', removed: '✓ Removed',
    no_instructors: 'No instructors yet.', add_new_instructor: 'Add a new instructor:', add_instructor_btn: '+ Add instructor', send_instructor_username: 'Send the instructor\'s @telegram_username:', added_as_instructor: 'added. Ask them to send /start to this bot.',
    gear_label: 'Gear', level_label: 'Level', languages_label: 'Langs', strikes_label: 'Strikes',
    deactivate_btn: 'Deactivate', activate_btn: '✓ Activate', reset_strikes_btn: 'Reset strikes', updated: '✓ Updated', strikes_reset: '✓ Strikes reset, reactivated',
    ask_name: 'Name:', ask_gear: 'Pick gear:', ask_levels: 'Levels taught:', ask_level_min: 'Minimum level:', ask_level_max: 'Maximum level:', ask_langs: 'Spoken languages:'
  },
  ru: {
    nothing_pending: 'Ничего не ожидает.', no_orders: 'Пока нет заказов.', no_my_orders: 'У вас пока нет заказов.',
    viewer_loading: 'Загрузка…', empty_current: 'Всё чисто — активных заказов сейчас нет.', empty_all: 'Пока нет заказов.', empty_refunds: 'Все возвраты обработаны.', empty_my_current: 'Сейчас нет активных занятий.', empty_my_all: 'Пока нет занятий.',
    finances_title: 'Финансы', active_orders: 'Заказы', gross_revenue: 'Валовая выручка', deposits_collected: 'Собрано депозитов', refunded_pending: 'Возвращено',
    your_earnings_title: 'Ваш заработок', orders_word: 'Заказы', earnings_total: 'Итого (без допов)',
    instructor_earnings_title: 'Заработок инструкторов', no_instructor_activity: 'Пока нет активности инструкторов.', orders_suffix: 'заказов',
    period_all: 'Всё время', period_week: 'Неделя', period_month: 'Месяц',
    sessions_revenue: 'Выручка по занятиям', addons_revenue: 'Выручка по допам', deposits_income: 'Депозиты',
    top_instructors: 'Топ инструкторов', no_data: 'Нет данных за этот период.',
    no_admins: 'Пока нет админов.', add_new_admin: 'Добавить нового админа:', add_admin_btn: '+ Добавить админа', send_admin_username: 'Пришлите @username нового админа:', added_as_admin: 'добавлен как админ. Попросите его нажать /start в этом боте.', remove_btn: 'Удалить', removed: '✓ Удалён',
    no_instructors: 'Пока нет инструкторов.', add_new_instructor: 'Добавить нового инструктора:', add_instructor_btn: '+ Добавить инструктора', send_instructor_username: 'Пришлите @username инструктора:', added_as_instructor: 'добавлен. Попросите его нажать /start в этом боте.',
    gear_label: 'Снаряд', level_label: 'Уровень', languages_label: 'Языки', strikes_label: 'Страйки',
    deactivate_btn: 'Деактивировать', activate_btn: '✓ Активировать', reset_strikes_btn: 'Сбросить страйки', updated: '✓ Обновлено', strikes_reset: '✓ Страйки сброшены, доступ восстановлен',
    ask_name: 'Имя:', ask_gear: 'Выберите снаряд:', ask_levels: 'Уровни, которые ведёт:', ask_level_min: 'Минимальный уровень:', ask_level_max: 'Максимальный уровень:', ask_langs: 'Языки:'
  }
};
function m(lang, key) { return (MISC[lang] && MISC[lang][key]) || MISC.en[key]; }

function addonsSubtotal(addonsBreakdown) { return addonsBreakdown.reduce((sum, a) => sum + (Number(a.amount) || 0), 0); }

// Everything a super_admin needs to action a manual deposit refund, in one place: who to
// send it to, how much, and via which rail (PayPal email vs a crypto address/txid) — so
// there's no need to dig back through the original order card to find the payment ref.
function refundTaskMessage(order) {
  const via = order.deposit_payment_method === 'paypal'
    ? `PayPal — ${order.deposit_payment_ref || order.client_email}`
    : `Crypto — ${order.deposit_payment_ref || '(no ref on file, contact client)'}`;
  return `<b>Refund needed — Order #${order.id}</b>\n` +
    `👤 ${order.client_name} · ${order.client_email}\n` +
    `────────────\n` +
    `💰 Amount: $${order.deposit_price}\n` +
    `🔹 Send via: ${via}`;
}

function parseJson(v, fallback) { try { return typeof v === 'string' ? JSON.parse(v) : (v || fallback); } catch (e) { return fallback; } }

const TRAVEL_BUFFER_MIN = 60; // min gap needed between two sessions at DIFFERENT spots the same day
function parseWindow(tw) {
  const m2 = String(tw || '').match(/(\d{1,2}):(\d{2})\D+(\d{1,2}):(\d{2})/);
  if (!m2) return null;
  return { start: +m2[1] * 60 + +m2[2], end: +m2[3] * 60 + +m2[4] };
}
// True if a new set of sessions clashes with existing ones: an overlap, OR (at a DIFFERENT spot
// the same day) too little time to physically travel between the two spots.
function scheduleConflict(newSessions, existingSessions, buffer = TRAVEL_BUFFER_MIN) {
  for (const ns of newSessions) {
    const nw = parseWindow(ns.timeWindow);
    for (const es of existingSessions) {
      if (es.date !== ns.date) continue;
      const ew = parseWindow(es.timeWindow);
      if (!nw || !ew) { if (ns.timeWindow === es.timeWindow) return true; continue; }
      if (nw.start < ew.end && ew.start < nw.end) return true; // time overlap
      if ((ns.spot || '') !== (es.spot || '')) {
        const gap = nw.start >= ew.end ? nw.start - ew.end : ew.start - nw.end;
        if (gap < buffer) return true; // can't make it across town in time
      }
    }
  }
  return false;
}

function isEligible(instructor, order) {
  // Normalize every side (trim + lowercase) so a case/whitespace/locale-label drift between what
  // the site stores and the instructor's saved slugs can't silently make a matching instructor
  // look ineligible (the usual cause of "instructor fits but can't take / can't be assigned").
  const norm = x => String(x == null ? '' : x).trim().toLowerCase();
  const gear = parseJson(instructor.gear, []).map(norm);
  const langs = parseJson(instructor.spoken_languages, []).map(norm);
  const reqLangs = parseJson(order.required_languages, []).map(norm).filter(Boolean);
  const levels = ['first-timer', 'beginner', 'intermediate', 'advanced'];
  const orderLevelIdx = levels.indexOf(norm(order.skill_level));
  // Preferred model: explicit set of levels the instructor teaches (checkbox multi-select).
  // Falls back to the legacy level_min/level_max range for instructors saved before the switch.
  const teach = parseJson(instructor.teach_levels, null);
  let levelOk;
  if (Array.isArray(teach) && teach.length) {
    levelOk = orderLevelIdx < 0 ? true : teach.map(norm).includes(norm(order.skill_level));
  } else {
    const minRaw = levels.indexOf(norm(instructor.level_min));
    const maxRaw = levels.indexOf(norm(instructor.level_max));
    const minIdx = minRaw < 0 ? 0 : minRaw;                 // unset/unknown → no lower bound
    const maxIdx = maxRaw < 0 ? levels.length - 1 : maxRaw; // unset/unknown → no upper bound
    levelOk = orderLevelIdx < 0 ? true : (orderLevelIdx >= minIdx && orderLevelIdx <= maxIdx);
  }
  const gearOk = gear.includes(norm(order.sport_type));
  const langOk = reqLangs.length === 0 || reqLangs.some(l => langs.includes(l));
  return gearOk && levelOk && langOk;
}

// Add-on icon by structural TYPE (media/rental), set by the site's booking-wizard when it
// builds addonsBreakdown — NOT by matching label text, since labels are localized (en/ru)
// and free-form. Transfers are rendered separately (see addonGroupLines) under one shared
// "Transfer" header rather than an icon per line.
const ADDON_ICON = { media: '📸', rental: '🏄' };
// The site sends the full media label ("Photo + video + drone + edit"); the bot shows it
// shortened (drop the "+ edit"/"+ обработка" tail) to keep the line compact.
function shortLabel(a) {
  if (a.type !== 'media') return a.label;
  return String(a.label).replace(/\s*[+&]\s*(edit|обработка|editing)\b.*$/i, '').trim();
}
function addonLine(a) { return `${ADDON_ICON[a.type] || ''}${ADDON_ICON[a.type] ? ' ' : ''}${shortLabel(a)} — $${a.amount}`; }

// Renders a set of addon lines with both transfer directions grouped under a single
// "Transfer" header (their route labels already read "A → B" on their own, so repeating
// the taxi icon per line was redundant) — matches the reference mockup layout exactly.
function addonGroupLines(items) {
  const transfers = items.filter(a => a.type === 'transferTo' || a.type === 'transferBack');
  const media = items.filter(a => a.type === 'media');
  const rest = items.filter(a => a.type !== 'transferTo' && a.type !== 'transferBack' && a.type !== 'media');
  const lines = rest.map(addonLine);
  if (transfers.length) {
    lines.push('🚕 Transfers:');
    for (const tr of transfers) lines.push(`${tr.label} — $${tr.amount}`);
  }
  // Photo+video+drone always LAST in the add-ons list.
  for (const md of media) lines.push(addonLine(md));
  return lines.join('\n');
}

// Renders "Sessions:" with each session's own addon lines nested directly beneath it
// (rental/transfers/media that apply to THAT date), separated by a blank line between
// sessions — matches the reference mockup rather than one flat aggregated addons list.
// The date+time and spot are on two bold lines (narrower than one long line, which was
// wrapping awkwardly at the group chat's reduced width from the bot's avatar column).
// Falls back to the flat list (no nesting) for older orders whose sessions have no
// per-session `addons` array yet.
function sessionHeader(s, i, mediaIcon, plain) {
  if (plain) {
    return `${i + 1}. ${formatSessionDate(s.date)}  ${s.spot || '—'}\n ${s.timeWindow}${mediaIcon || ''}`;
  }
  return `${i + 1}. ${formatSessionDate(s.date)} · ${s.timeWindow}\n${s.spot || '—'}${mediaIcon || ''}`;
}
function sessionsBlock(sessions, mediaDates, flatAddonsBreakdown, plain) {
  const hasPerSessionAddons = sessions.some(s => Array.isArray(s.addons) && s.addons.length);
  if (hasPerSessionAddons) {
    return sessions.map((s, i) => {
      const header = sessionHeader(s, i, '', plain);
      const lines = addonGroupLines(s.addons || []);
      return lines ? `${header}\n${lines}` : header;
    }).join('\n\n');
  }
  return sessions.map((s, i) => sessionHeader(s, i, mediaDates.includes(s.date) ? ' 📸' : '', plain)).join('\n') +
    (flatAddonsBreakdown.length ? `\n${addonGroupLines(flatAddonsBreakdown)}` : '');
}

function groupCardMessage(order, lang) {
  // NEVER include client name/phone/email here — group card is anonymized to just the order number.
  const sessions = parseJson(order.sessions, []);
  const addonsBreakdown = parseJson(order.addons, []);
  const mediaDates = parseJson(order.media_dates, []);
  return `🆕 <b>Order #${order.id}</b>\n` +
    `<b>${sportShort(order.sport_type)}</b> · ${order.skill_level}${order.instructor_lang_pref ? ' · ' + order.instructor_lang_pref.toLowerCase() : ''}\n` +
    `────────────\n` +
    `👥 ${order.participants} rider(s)\n` +
    `📅 Sessions:\n${sessionsBlock(sessions, mediaDates, addonsBreakdown)}\n\n` +
    `Sessions total: $${instructorEarnings(order)}\n` +
    `Add-ons total: $${addonsSubtotal(addonsBreakdown)}\n` +
    `Total: $${instructorEarnings(order) + addonsSubtotal(addonsBreakdown)}`;
}

function fullOrderMessage(order, opts = {}) {
  const sessions = parseJson(order.sessions, []);
  const addonsBreakdown = parseJson(order.addons, []);
  const mediaDates = parseJson(order.media_dates, []);
  const isAdminView = opts.admin;
  const total = instructorEarnings(order) + addonsSubtotal(addonsBreakdown);
  return (isAdminView ? `<b>Order #${order.id}</b>\n${time.formatBaliDateTime(order.created_at)}  ${statusDot(order.status)} ${order.status}\n` : `<b>Order #${order.id}</b>\n${statusDot(order.status, true)} ${order.status}\n`) +
    (opts.instructorName ? `coach: ${opts.instructorName}\n` : '') +
    `\n────────────────\n` +
    `👤 <b>${order.client_name}</b>${order.age ? ' (' + order.age + 'y)' : ''}\n` +
    (isAdminView ? `📞 ${order.client_phone}\n📧 ${order.client_email}\n` : '') +
    `<b>${sportShort(order.sport_type)}</b> · ${order.skill_level}${order.instructor_lang_pref ? ' · ' + order.instructor_lang_pref : ''}\n` +
    `👥 ${order.participants} rider(s)\n` +
    (order.additional_info ? `💬 ${order.additional_info}\n` : '') +
    `\n📅 Sessions:\n${sessionsBlock(sessions, mediaDates, addonsBreakdown, !isAdminView)}\n` +
    (isAdminView ? `────────────────\n\n` : '\n') +
    (isAdminView ? `💳 Deposit $${order.deposit_price} (${order.deposit_payment_method})\n\n` : '') +
    `Session(s) price: $${instructorEarnings(order)}\n` +
    `Add-ons total: $${addonsSubtotal(addonsBreakdown)}\n` +
    `Total: $${isAdminView ? (order.total_price ?? total) : total}`;
}

// One line per order — used by the paginated "All orders"/"My orders" list. Format and
// vocabulary mirror the reference bot's getCompactOrderMessage exactly (separator rule,
// "#id emoji| people×days | date time" then "statusIcon label | $price"), showing the
// INSTRUCTOR'S CUT ($, 80% of session price) rather than the client-facing total — same as
// the reference always showing instructorPrice here, even to admins.
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatSessionDate(dateStr) {
  if (!dateStr) return '?';
  const [y, mo, da] = dateStr.split('-').map(Number);
  if (!y || !mo || !da) return dateStr;
  return `${String(da).padStart(2, '0')} ${MONTHS_SHORT[mo - 1]} ${y}`;
}
const COMPACT_STATUS_ICON = { pending_review: '·', in_group: '»', taken: '~', confirmed: '✓', completed: '✓', cancelled: '✗', deposit_refund_pending: '‹', deposit_refunded: '‹', needs_admin_assignment: '' };
const STATUS_DOT = { pending_review: '🟠', in_group: '🟡', taken: '🟡', confirmed: '🟡', completed: '🟢', cancelled: '⚪️', deposit_refund_pending: '🟠', deposit_refunded: '⚫️', needs_admin_assignment: '🔴' };
function statusDot(s, forInstructor) { if (forInstructor && (s === 'taken' || s === 'confirmed')) return '✓'; return STATUS_DOT[s] || '⚪️'; }
const COMPACT_STATUS_KEY = { pending_review: 'pending', in_group: 'in_group', taken: 'taken', confirmed: 'confirmed', completed: 'completed', cancelled: 'cancelled', deposit_refund_pending: 'refund_pending', deposit_refunded: 'refunded' };
function compactOrderLine(order, lang, showPin) {
  const sessions = parseJson(order.sessions, []);
  const addonsBreakdown = parseJson(order.addons, []);
  const first = sessions[0] || {};
  const days = sessions.length || 1;
  const statusIcon = COMPACT_STATUS_ICON[order.status] || '';
  const statusKey = COMPACT_STATUS_KEY[order.status];
  const statusLabel = statusKey ? sl(lang, statusKey) : order.status;
  const timeStr = (first.timeWindow || '').split(' – ')[0].trim();
  const addonsTotal = addonsSubtotal(addonsBreakdown);
  const pin = (showPin && order.pinned) ? '📌 ' : '';
  const spot = (parseJson(order.sessions, [])[0] || {}).spot || 'TBD';
  const instrNick = order.instructor_username ? '@' + String(order.instructor_username).replace(/^@/, '') : (order.instructor_name || '');
  const line3 = `${order.client_name || '—'}${instrNick ? ' | ' + instrNick : ''}`;
  // At-a-glance add-on icons + total so the list line carries the useful bits without opening the card.
  const addonIcons = [];
  if (addonsBreakdown.some(a => a.type === 'rental')) addonIcons.push('🏄');
  if (addonsBreakdown.some(a => a.type === 'transferTo' || a.type === 'transferBack')) addonIcons.push('🚕');
  if (addonsBreakdown.some(a => a.type === 'media') || parseJson(order.media_dates, []).length) addonIcons.push('📸');
  const iconStr = addonIcons.length ? '  ' + addonIcons.join(' ') : '';
  const priceStr = order.total_price != null ? ' · $' + order.total_price : '';
  return `\n─────────────────\n${pin}#${order.id} ${sportShort(order.sport_type)} | ${order.participants}×${days}d. | ${statusDot(order.status, !showPin)} ${statusLabel}${priceStr}\n${formatSessionDate(first.date)} | ${spot}${iconStr}\n${line3}`;
}

function whatsappDeepLink(order, instructorName) {
  const sessions = parseJson(order.sessions, []);
  const mediaDates = parseJson(order.media_dates, []);
  // Full booking recap: every session with its own add-ons beneath it — mirrors the site's
  // order summary so the client instantly recognizes their order.
  const lines = sessions.map((s, i) => {
    const extras = (Array.isArray(s.addons) ? s.addons : [])
      .map(a => `   • ${a.label}`);
    if (!s.addons && mediaDates.includes(s.date)) extras.push('   • Photo + video + drone');
    return `${i + 1}. ${formatSessionDate(s.date)} · ${s.timeWindow} · ${s.spot || 'TBD'}` + (extras.length ? '\n' + extras.join('\n') : '');
  });
  const msg = `Hi ${order.client_name}! This is ${instructorName} from EasyBali.surf — I'll be your ${order.sport_type} coach.\n\n` +
    `Your booking:\n${lines.join('\n')}\n\n` +
    `Let's confirm the details — where are you staying / where should we meet or pick you up from?`;
  const cleanPhone = (order.client_phone || '').replace(/[^0-9]/g, '');
  return { text: msg, waUrl: `https://wa.me/${cleanPhone}?text=${encodeURIComponent(msg)}` };
}

// Where the "contact client" button should point, by order source. Today every order is a
// website booking → WhatsApp. FUTURE-COMPAT: a crypto-paid order from the (not-yet-built)
// client Telegram bot carries order_source='client_bot' + client_telegram, so we hand back a
// Telegram deep link with the same prefilled message instead. Adding that channel later needs
// no change to the take/confirm flow — only these two fields populated at intake.
function contactDeepLink(order, instructorName) {
  const built = buildContactMessage(order, instructorName);
  if (order.order_source === 'client_bot' && order.client_telegram) {
    const handle = String(order.client_telegram).replace(/^@/, '');
    return `https://t.me/${handle}?text=${encodeURIComponent(built.text)}`;
  }
  return built.waUrl;
}
function whatsappDeepLink(order, instructorName) { return buildContactMessage(order, instructorName).waUrl; }

function trackedWhatsappUrl(order) {
  // Routes through our own redirect so we can record the click, then bounces to wa.me.
  return `${PUBLIC_BASE_URL}/wa/${order.id}`;
}

// ============================================================
// SCREEN MESSAGE TRACKING — auto-delete previous menu output when a new
// menu screen opens, so the chat doesn't fill up with stale order lists.
// Only used for browse/menu screens (Pending, Instructors, Finances, All
// orders, etc) — NEVER for order-flow messages (group cards, WhatsApp DMs,
// cron alerts), which must persist.
// ============================================================
const screenMessages = new Map(); // chatId -> message_id[]


async function clearScreen(chatId) {
  const ids = screenMessages.get(chatId) || [];
  for (const id of ids) {
    try { await bot.telegram.deleteMessage(chatId, id); } catch (e) { /* already gone / too old to delete */ }
  }
  screenMessages.set(chatId, []);
}

async function trackReply(ctx, text, extra) {
  const sent = await ctx.reply(text, extra);
  const arr = screenMessages.get(ctx.chat.id) || [];
  arr.push(sent.message_id);
  screenMessages.set(ctx.chat.id, arr);
  return sent;
}

// Also delete the user's own previous command message (e.g. tapping a reply-keyboard
// button) once a newer one arrives — keeps the chat down to just the latest request +
// its answer, same as clearing bot screens. Call once at the top of each menu handler
// (right after clearScreen, which removes anything left from BEFORE this request),
// then this stashes the CURRENT user message so the next request clears it in turn.
function trackUserMessage(ctx) {
  if (!ctx.message) return;
  const arr = screenMessages.get(ctx.chat.id) || [];
  arr.push(ctx.message.message_id);
  screenMessages.set(ctx.chat.id, arr);
}

function calendarUrl(order) {
  const sessions = parseJson(order.sessions, []);
  const first = sessions[0]; if (!first) return 'https://calendar.google.com/calendar/';
  try {
    const start = time.baliToUtcDate(first.date, first.timeWindow.split(' – ')[0].trim());
    const end = new Date(start.getTime() + 2 * 60 * 60000);
    const fmt = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const params = new URLSearchParams({
      action: 'TEMPLATE',
      text: `${order.sport_type} session — ${order.client_name}`,
      dates: `${fmt(start)}/${fmt(end)}`,
      location: first.spot || 'Bali',
      ctz: 'Asia/Makassar'
    });
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  } catch (e) { return 'https://calendar.google.com/calendar/'; }
}

async function notifyRole(role, messageOrFn, extraOrFn, trackOrderId) {
  const pool = db.getPool();
  const [rows] = await pool.execute('SELECT * FROM users WHERE role = ? AND is_active = 1 AND telegram_chat_id IS NOT NULL', [role]);
  const tracked = [];
  for (const u of rows) {
    const msg = typeof messageOrFn === 'function' ? messageOrFn(u) : messageOrFn;
    const extra = typeof extraOrFn === 'function' ? extraOrFn(u) : extraOrFn;
    try { await clearScreen(u.telegram_chat_id); } catch (e) {}
    try { const sent = await bot.telegram.sendMessage(u.telegram_chat_id, msg, { parse_mode: 'HTML', ...extra }); if (trackOrderId && sent) tracked.push({ c: String(u.telegram_chat_id), m: sent.message_id }); } catch (e) { /* user hasn't /start'd yet */ }
  }
  if (trackOrderId && tracked.length) {
    try {
      const [[o]] = await pool.execute('SELECT admin_bcast_msgs FROM orders WHERE id = ?', [trackOrderId]);
      const prev = o ? parseJson(o.admin_bcast_msgs, []) : [];
      await pool.execute('UPDATE orders SET admin_bcast_msgs = ? WHERE id = ?', [JSON.stringify(prev.concat(tracked)), trackOrderId]);
    } catch (e) {}
  }
}
// Remove the pending-review broadcast cards from every admin's chat once the order is handled.
async function clearAdminBcasts(order) {
  if (!order) return;
  const list = parseJson(order.admin_bcast_msgs, []);
  for (const d of list) { try { await bot.telegram.deleteMessage(d.c, d.m); } catch (e) {} }
  try { await db.getPool().execute('UPDATE orders SET admin_bcast_msgs = NULL WHERE id = ?', [order.id]); } catch (e) {}
}

// Push an unsolicited alert to a specific chat, clearing its stale submenu messages first.
async function pushAlert(chatId, text, extra) {
  if (!chatId) return;
  try { await clearScreen(chatId); } catch (e) {}
  try { await bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', ...(extra || {}) }); } catch (e) {}
}

function adminReviewKeyboard(orderId, role, lang) {
  const rows = [[Markup.button.callback(t(lang, 'send_to_group_btn'), `admin_send_${orderId}`)]];
  rows.push([Markup.button.callback('Assign to instructor', `admin_assign_${orderId}`)]);
  if (role === 'super_admin') {
    rows.push([Markup.button.callback(t(lang, 'cancel_refund_btn'), `cfm:admin_cancelrefund_${orderId}`)]);
  }
  rows.push([Markup.button.callback(t(lang, 'delete_btn'), `admin_delete_${orderId}`)]);
  return Markup.inlineKeyboard(rows);
}

// Shared button shown inside the instructors GROUP chat, where members may have different
// languages set individually — so it's bilingual rather than picked per-viewer.
const TAKE_BTN_GROUP_LABEL = '✓ TAKE';

// ============================================================
// POOL DM MIRROR — every order that enters the group pool is ALSO broadcast as a private
// message to each active instructor (so the system works without the group; the group + its
// TAKE button stay as a fallback that does exactly the same thing). Eligibility is still
// enforced in the take handler, so non-matching instructors simply can't claim it.
// pool_dm_msgs (JSON on orders) records every {c:chatId, m:messageId} we sent, so the moment
// the order leaves the pool (taken / assigned / cancelled / expired) we delete it from every
// other instructor's chat — preventing double-take, same as removing the group card.
// ============================================================
async function broadcastPoolDMs(order) {
  const pool = db.getPool();
  const [insts] = await pool.execute("SELECT id, telegram_chat_id FROM users WHERE role='instructor' AND is_active=1 AND telegram_chat_id IS NOT NULL");
  const sent = [];
  for (const i of insts) {
    try {
      const msg = await bot.telegram.sendMessage(i.telegram_chat_id, groupCardMessage(order), {
        parse_mode: 'HTML', protect_content: true,
        ...Markup.inlineKeyboard([[Markup.button.callback(TAKE_BTN_GROUP_LABEL, `take_${order.id}`)]])
      });
      sent.push({ c: String(i.telegram_chat_id), m: msg.message_id });
    } catch (e) {}
  }
  try { await pool.execute('UPDATE orders SET pool_dm_msgs = ? WHERE id = ?', [JSON.stringify(sent), order.id]); } catch (e) {}
}
async function clearPoolDMs(order) {
  const list = parseJson(order.pool_dm_msgs, []);
  for (const d of list) { try { await bot.telegram.deleteMessage(d.c, d.m); } catch (e) {} }
  try { await db.getPool().execute('UPDATE orders SET pool_dm_msgs = NULL WHERE id = ?', [order.id]); } catch (e) {}
}

// ============================================================
// AUTH MIDDLEWARE-ish HELPERS
// ============================================================

async function requireUser(ctx) {
  // The menu commands (/start, reply-keyboard buttons) are 1:1 only — if someone types them
  // inside the shared instructors group, silently ignore instead of opening their panel there
  // for everyone to see. Inline-button clicks (callback_query) are exempt: those are buttons
  // the bot itself posted into the group on purpose (e.g. the TAKE button on an order card)
  // and must keep working there.
  if (ctx.updateType === 'message' && ctx.chat && ctx.chat.type !== 'private') return null;
  // Auth by the STABLE numeric Telegram user id (bound to telegram_chat_id on /start), not
  // the mutable @username — a username can be dropped and re-registered by someone else, so
  // trusting it for authorization is spoofable. The username lookup remains only as a
  // first-contact fallback, before the id has ever been bound on /start.
  let user = await db.getUserByChatId(ctx.from.id);
  if (!user) {
    const u = ctx.from.username;
    if (!u) { await ctx.reply('✗ Set a Telegram @username first.'); return null; }
    user = await db.getUserByUsername(u);
  }
  if (!user || !user.is_active) { await ctx.reply('✗ You are not authorized. Contact the super admin.'); return null; }
  // The bot UI is English-only for now (no language picker — see mainKeyboard). i18n.js/the
  // CARD/MISC dictionaries in this file still carry full ru translations so a language
  // switcher can be reintroduced later without re-translating anything; this override is the
  // only thing actually disabling it, and only for the bot's OWN chrome — it has no bearing
  // on order.instructor_lang_pref/required_languages (the CLIENT's language choice on the
  // site) or an instructor's spoken_languages, both of which are unrelated data fields.
  user.language = 'en';
  return user;
}

async function mainKeyboard(user) {
  const lang = user.language || 'en';
  const pendLabel = t(lang, 'menu_pending');
  const currLabel = t(lang, 'menu_current_orders');
  if (user.role === 'super_admin') {
    return Markup.keyboard([
      [t(lang, 'menu_pending'), '↩️ Refunds'],
      [t(lang, 'menu_orders'), t(lang, 'menu_finances')],
      [t(lang, 'menu_team'), '🌊 Disciplines'],
      ['🎒 Add-ons', '⭐ Reviews'],
      ['⚙️ Settings']
    ]).resize();
  }
  if (user.role === 'admin') {
    return Markup.keyboard([
      [t(lang, 'menu_pending'), t(lang, 'menu_orders')],
      [t(lang, 'menu_finances'), t(lang, 'menu_team')],
      ['❓ Help']
    ]).resize();
  }
  return Markup.keyboard([
    ['✓ To confirm'],
    ['🟡 Current sessions', '📆 Calendar'],
    ['📋 All sessions', t(lang, 'menu_finances')],
    ['❓ Help']
  ]).resize();
}

// Every menu screen replaces whatever the PREVIOUS one left behind (see clearScreen below).
// Navigation between screens is entirely inline-button based (like Pending/Instructors/
// Statistics) rather than swapping the bottom reply-keyboard — the persistent keyboard is set
// once at /start and left alone from then on, which avoids repeatedly resending a
// ReplyKeyboardMarkup (some Telegram clients render that oddly — the OS keyboard panel
// popping open, or the custom keyboard flickering/disappearing).

// ============================================================
// LIVE STATUS PANEL — one inline dashboard message per admin/super_admin, updated IN PLACE (no
// duplicate messages, no reply-keyboard resend → no Android OS-keyboard overlap). Posted once at
// /start (deduped) and refreshed on every count-changing event + a button.
// ============================================================
const statusPanels = new Map(); // chatId -> panel message_id
const welcomeAnchors = new Map(); // chatId -> welcome-anchor message_id (deduped on repeated /start)

async function liveCounts() {
  const pool = db.getPool();
  const [[r]] = await pool.execute(
    "SELECT " +
    "SUM(status='pending_review') pending, " +
    "SUM(status='in_group') inGroup, " +
    "SUM(status='taken') taken, " +
    "SUM(status='confirmed') confirmed, " +
    "SUM(status='completed') completed, " +
    "SUM(status='cancelled') cancelled, " +
    "SUM(status='deposit_refund_pending') refundPending, " +
    "SUM(status='deposit_refunded') refunded FROM orders");
  return { pending:+r.pending||0, inGroup:+r.inGroup||0, taken:+r.taken||0, confirmed:+r.confirmed||0, completed:+r.completed||0, cancelled:+r.cancelled||0, refundPending:+r.refundPending||0, refunded:+r.refunded||0 };
}

function statusPanelText(c) {
  // Active-type statuses show their colour only when there's something in them, otherwise a
  // neutral white dot; completed (green), cancelled (white) and refunded (black) stay fixed.
  const dot = (n, color) => n > 0 ? color : '⚪️';
  const attention = c.pending + c.inGroup + c.refundPending;
  return `<b>Statistics</b>\n` +
    `\n` +
    `────────────\n` +
    ` ${dot(c.pending,'🟠')} Pending review: <b>${c.pending}</b>\n` +
    ` ${dot(c.inGroup,'🟡')} In group pool: <b>${c.inGroup}</b>\n` +
    ` ${dot(c.taken,'🟡')} Taken: <b>${c.taken}</b>\n` +
    ` ${dot(c.confirmed,'🟡')} Confirmed: <b>${c.confirmed}</b>\n` +
    ` 🟢 Completed: <b>${c.completed}</b>\n` +
    ` ⚪️ Cancelled: <b>${c.cancelled}</b>\n` +
    ` ${dot(c.refundPending,'🟠')} Refund pending: <b>${c.refundPending}</b>\n` +
    ` ⚫️ Refunded: <b>${c.refunded}</b>\n` +
    `────────────\n` +
    (attention > 0 ? `<b>${attention}</b> need attention` : `Nothing waiting`);
}

function statusPanelKb() {
  return Markup.inlineKeyboard([[Markup.button.callback('Refresh', 'status_refresh')]]);
}

async function postStatusPanel(ctx) {
  const chatId = ctx.chat.id;
  const prev = statusPanels.get(chatId);
  if (prev) { try { await bot.telegram.deleteMessage(chatId, prev); } catch (e) {} }
  try {
    const c = await liveCounts();
    const sent = await ctx.reply(statusPanelText(c), { parse_mode: 'HTML', ...statusPanelKb() });
    statusPanels.set(chatId, sent.message_id);
  } catch (e) {}
}

async function refreshAllStatusPanels() {
  let c; try { c = await liveCounts(); } catch (e) { return; }
  const text = statusPanelText(c);
  for (const [chatId, msgId] of statusPanels) {
    try { await bot.telegram.editMessageText(chatId, msgId, undefined, text, { parse_mode: 'HTML', ...statusPanelKb() }); } catch (e) {}
  }
}

bot.action('status_refresh', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) return ctx.answerCbQuery();
  try {
    const c = await liveCounts();
    await ctx.editMessageText(statusPanelText(c), { parse_mode: 'HTML', ...statusPanelKb() });
    statusPanels.set(ctx.chat.id, ctx.callbackQuery.message.message_id);
  } catch (e) {}
  await ctx.answerCbQuery('Updated');
});

// ============================================================
// BOT: /start + auth
// ============================================================

bot.start(async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  await clearScreen(ctx.chat.id);
  trackUserMessage(ctx);
  const pool = db.getPool();
  await pool.execute('UPDATE users SET telegram_chat_id = ? WHERE id = ?', [ctx.chat.id, user.id]);
  const lang = user.language || 'en';
  const welcomeKey = user.role === 'super_admin' ? 'welcome_super' : user.role === 'admin' ? 'welcome_admin' : 'welcome_instructor';
  // Send the welcome + reply-keyboard anchor ONCE per chat. On repeated /start we neither resend
  // nor delete it — deleting/reposting the anchor made the custom keyboard flicker away.
  if (!welcomeAnchors.get(ctx.chat.id)) {
    const anchor = await ctx.reply(t(lang, welcomeKey), { parse_mode: 'HTML', ...(await mainKeyboard(user)) });
    welcomeAnchors.set(ctx.chat.id, anchor.message_id);
  }
  if (user.role === 'admin' || user.role === 'super_admin') await postStatusPanel(ctx);
});

// ============================================================
// PENDING REVIEW (admin + super_admin)
// ============================================================

bot.hears(/Pending|Ожида|рассмотрени/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) return ctx.reply(t(user?.language, 'access_denied'));
  await clearScreen(ctx.chat.id);
  trackUserMessage(ctx);
  await renderCurrentViewer(ctx, user, { fresh: true, mode: 'pending' });
});

bot.action(/admin_send_(\d+)/, async (ctx) => {
  const orderId = ctx.match[1];
  const user = await requireUser(ctx);
  if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) return ctx.answerCbQuery(t(user?.language, 'access_denied'));
  const pool = db.getPool();
  const [rows] = await pool.execute('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!rows.length) return ctx.answerCbQuery(t(user.language, 'order_not_found'));
  const order = rows[0];

  const sent = await bot.telegram.sendMessage(INSTRUCTORS_GROUP_ID, groupCardMessage(order), {
    parse_mode: 'HTML',
    protect_content: true,
    ...Markup.inlineKeyboard([[Markup.button.callback(TAKE_BTN_GROUP_LABEL, `take_${orderId}`)]])
  });

  await pool.execute(
    "UPDATE orders SET status = 'in_group', group_message_id = ?, pool_expires_at = ? WHERE id = ?",
    [sent.message_id, time.nowBaliString(POOL_WINDOW_MIN), orderId]
  );
  await db.logAction(ctx.from.username, user.role, 'sent_to_group', orderId, null);
  await clearAdminBcasts(order);
  await broadcastPoolDMs({ ...order, id: orderId, status: 'in_group' });
  await refreshAllStatusPanels();
  await ctx.answerCbQuery(t(user.language, 'sent_to_group'));
  try { await ctx.deleteMessage(); } catch (e) {}
});

bot.action(/admin_delete_(\d+)/, async (ctx) => {
  const orderId = ctx.match[1];
  const user = await requireUser(ctx);
  if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) return ctx.answerCbQuery(t(user?.language, 'access_denied'));
  const pool = db.getPool();
  const [rows] = await pool.execute('SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = rows[0];
  await pool.execute("UPDATE orders SET status = 'cancelled', pinned = 0 WHERE id = ?", [orderId]);
  await db.logAction(ctx.from.username, user.role, 'deleted_order', orderId, null);
  // Deleting from Pending only removes the admin's own review card (no group/instructor
  // ever saw it). But if it had already gone further — posted to the group, or taken by an
  // instructor — those need cleaning up too, otherwise the order looks "not deleted" from
  // their side (still shows a live TAKE button / still sits in the instructor's chat).
  if (order) {
    if (order.group_message_id) { try { await bot.telegram.deleteMessage(INSTRUCTORS_GROUP_ID, order.group_message_id); } catch (e) {} }
    if (order.instructor_id) {
      const [[instructor]] = await pool.execute('SELECT * FROM users WHERE id = ?', [order.instructor_id]);
      if (instructor && instructor.telegram_chat_id) {
        if (order.instructor_message_id) { try { await bot.telegram.deleteMessage(instructor.telegram_chat_id, order.instructor_message_id); } catch (e) {} }
        await bot.telegram.sendMessage(instructor.telegram_chat_id, `✗ Order #${orderId} was cancelled by an admin.`, { parse_mode: 'HTML' }).catch(() => {});
      }
    }
  }
  await ctx.answerCbQuery('✓ Deleted');
  await refreshAllStatusPanels();
  if (await refreshViewerIfActive(ctx, user)) return;
  try { await ctx.deleteMessage(); } catch (e) {}
});

// Cancel + refund deposit — super_admin only.
bot.action(/^admin_cancelrefund_(\d+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const user = await requireUser(ctx);
  if (!user || user.role !== 'super_admin') return ctx.answerCbQuery(t(user?.language, 'access_denied'));
  const pool = db.getPool();
  const [rows] = await pool.execute('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!rows.length) return ctx.answerCbQuery(t(user.language, 'order_not_found'));
  const order = rows[0];

  await processDepositRefund(order); // always manual now — see refunds.js
  await pool.execute("UPDATE orders SET status = 'deposit_refund_pending' WHERE id = ?", [orderId]);
  await db.logAction(ctx.from.username, user.role, 'cancel_refund_flagged', orderId, null);
  await refreshAllStatusPanels();
  if (order.group_message_id) { try { await bot.telegram.deleteMessage(INSTRUCTORS_GROUP_ID, order.group_message_id); } catch (e) {} }
  await clearPoolDMs(order);
  await clearAdminBcasts(order);
  await ctx.answerCbQuery(t(user.language, 'refund_manual_needed'));
  // If invoked from the single-message viewer, re-render it in place (the order is now a refund
  // task and stays in the current set) instead of deleting the card + posting a separate message.
  if (await refreshViewerIfActive(ctx, user)) return;
  // Remove the original order card outright (not just its buttons) — the actionable refund task
  // message below replaces it, so nothing stale lingers implying the order is still live.
  try { await ctx.deleteMessage(); } catch (e) { try { await ctx.editMessageReplyMarkup(undefined); } catch (e2) {} }
  // Immediately surface the actionable refund task — who to pay, how much, by what method
  // — instead of leaving the super_admin to dig it out of a generic order card later.
  await trackReply(ctx, refundTaskMessage(order), { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('✓ Mark as refunded', `cfm:admin_markrefunded_${orderId}`)]]) });
});

// Force-majeure path: pull a taken/confirmed order back into the group pool WITHOUT
// striking the instructor (e.g. they got sick, a genuine emergency) — distinct from the
// automatic no-response bounce in the cron job below, which does strike.
bot.action(/admin_returntogroup_(\d+)/, async (ctx) => {
  const orderId = ctx.match[1];
  const user = await requireUser(ctx);
  if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) return ctx.answerCbQuery(t(user?.language, 'access_denied'));
  const pool = db.getPool();
  const [rows] = await pool.execute('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!rows.length) return ctx.answerCbQuery(t(user.language, 'order_not_found'));
  const order = rows[0];
  if (!['taken', 'confirmed'].includes(order.status)) return ctx.answerCbQuery(t(user.language, 'order_not_found'));

  if (order.instructor_id) {
    const [[instructor]] = await pool.execute('SELECT * FROM users WHERE id = ?', [order.instructor_id]);
    if (instructor && instructor.telegram_chat_id) {
      if (order.instructor_message_id) { try { await bot.telegram.deleteMessage(instructor.telegram_chat_id, order.instructor_message_id); } catch (e) {} }
    }
  }

  const sent = await bot.telegram.sendMessage(INSTRUCTORS_GROUP_ID, groupCardMessage(order), {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback(TAKE_BTN_GROUP_LABEL, `take_${orderId}`)]])
  });
  await pool.execute(
    "UPDATE orders SET status = 'in_group', instructor_id = NULL, group_message_id = ?, instructor_message_id = NULL, whatsapp_deadline_at = NULL, whatsapp_clicked = 0, pool_expires_at = ? WHERE id = ?",
    [sent.message_id, time.nowBaliString(POOL_WINDOW_MIN), orderId]
  );
  await db.logAction(ctx.from.username, user.role, 'returned_to_group_no_strike', orderId, null);
  await clearPoolDMs(order);
  await broadcastPoolDMs({ ...order, id: orderId, status: 'in_group' });
  await refreshAllStatusPanels();
  await ctx.answerCbQuery('\u2705');
  if (await refreshViewerIfActive(ctx, user)) return;
  try { await ctx.deleteMessage(); } catch (e) {}
});

// Confirmation step for a manual refund — super_admin taps this only AFTER they've actually
// sent the money via PayPal/crypto. Marks it done + logs who/when so there's a clean audit
// trail instead of a pile of "pending" refunds nobody remembers the status of.
bot.action(/^admin_markrefunded_(\d+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const user = await requireUser(ctx);
  if (!user || user.role !== 'super_admin') return ctx.answerCbQuery(t(user?.language, 'access_denied'));
  const pool = db.getPool();
  const [rows] = await pool.execute('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!rows.length) return ctx.answerCbQuery(t(user.language, 'order_not_found'));
  const order = rows[0];
  // Idempotency guard: only a pending refund can be marked done. Prevents a double-tap (or tapping
  // an already-refunded card in the Refunds viewer) from re-sending the email and re-logging.
  if (order.status !== 'deposit_refund_pending') {
    await ctx.answerCbQuery(order.status === 'deposit_refunded' ? '✓ Already refunded' : 'Not in refund state');
    if (await refreshViewerIfActive(ctx, user)) return;
    return;
  }
  await pool.execute("UPDATE orders SET status = 'deposit_refunded' WHERE id = ?", [orderId]);
  await db.logAction(ctx.from.username, user.role, 'refund_confirmed_manual', orderId, { amount: order.deposit_price, method: order.deposit_payment_method });
  await refreshAllStatusPanels();
  await email.depositRefundedEmail(order).catch(() => {});
  await ctx.answerCbQuery('✓ Marked as refunded');
  if (await refreshViewerIfActive(ctx, user)) return;
  // Delete the refund card entirely and drop a compact service line in its place.
  try { await ctx.deleteMessage(); } catch (e) {}
  await trackReply(ctx, `Order #${orderId} — deposit refunded.`, { parse_mode: 'HTML' });
});

// ============================================================
// GROUP: instructor takes an order
// ============================================================

bot.action(/take_(\d+)/, async (ctx) => {
  const orderId = ctx.match[1];
  const user = await requireUser(ctx);
  if (!user) return ctx.answerCbQuery('✗ Not authorized');
  const pool = db.getPool();
  const [rows] = await pool.execute('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!rows.length) return ctx.answerCbQuery(t(user.language, 'order_not_found'));
  const order = rows[0];
  if (order.status !== 'in_group') return ctx.answerCbQuery(t(user.language, 'already_taken'));
  if (!isEligible(user, order)) return ctx.answerCbQuery(t(user.language, 'not_eligible'));

  // Block double-booking: an instructor can't hold two orders with an overlapping
  // date+time slot, even across different orders/clients.
  const newSessions = parseJson(order.sessions, []);
  const [activeOrders] = await pool.execute(
    "SELECT sessions FROM orders WHERE instructor_id = ? AND status IN ('taken','confirmed')",
    [user.id]
  );
  const existing = activeOrders.flatMap(o => parseJson(o.sessions, []));
  if (scheduleConflict(newSessions, existing)) return ctx.answerCbQuery('✗ Clashes with another session that day (overlap or not enough travel time between spots).');

  await pool.execute(
    "UPDATE orders SET status = 'taken', instructor_id = ?, whatsapp_deadline_at = ?, whatsapp_clicked = 0 WHERE id = ?",
    [user.id, time.nowBaliString(WHATSAPP_WINDOW_MIN), orderId]
  );
  await db.logAction(ctx.from.username, user.role, 'took_order', orderId, null);
  await refreshAllStatusPanels();

  // Immediately tell admins who took it. A separate service message is deliberately used
  // instead of editing the original admin card (stale message ids make edits silently
  // fail); the card's status is re-read live wherever it's re-rendered anyway.
  try {
    const [adminRows] = await pool.execute("SELECT * FROM users WHERE role IN ('admin','super_admin') AND telegram_chat_id IS NOT NULL");
    for (const a of adminRows) {
      if (a.id === user.id) continue;
      bot.telegram.sendMessage(a.telegram_chat_id, `Order #${orderId} taken by ${user.name}${ctx.from.username ? ' (@' + ctx.from.username + ')' : ''}`).catch(() => {});
    }
  } catch (e) { console.error('take admin-notify error:', e.message); }

  if (order.group_message_id) { try { await bot.telegram.deleteMessage(INSTRUCTORS_GROUP_ID, order.group_message_id); } catch (e) {} }
  await clearPoolDMs(order);

  const updated = { ...order, status: 'taken', instructor_id: user.id };
  const kb = Markup.inlineKeyboard([[
    Markup.button.url(order.whatsapp_clicked ? '✓ WhatsApp' : t(user.language, 'whatsapp_btn'), trackedWhatsappUrl(order)),
    Markup.button.url(t(user.language, 'calendar_btn'), calendarUrl(order))
  ]]);
  const deadlineHM = time.nowBaliString(WHATSAPP_WINDOW_MIN).slice(11, 16);
  const sent = await bot.telegram.sendMessage(
    user.telegram_chat_id,
    fullOrderMessage(updated, {}) + `\n\nYou have 5 minutes to message the client on WhatsApp.`,
    { parse_mode: 'HTML', protect_content: true, ...kb }
  );
  await pool.execute('UPDATE orders SET instructor_message_id = ? WHERE id = ?', [sent.message_id, orderId]);
  await ctx.answerCbQuery(t(user.language, 'order_taken'));
});

// ============================================================
// DIRECT ASSIGN (admin/super_admin) — hand a pending order straight to a chosen eligible
// instructor, bypassing the group pool. Same 'taken' state + 5-min WhatsApp window as TAKE.
// ============================================================
async function eligibleInstructorsFor(order) {
  const pool = db.getPool();
  const [insts] = await pool.execute("SELECT * FROM users WHERE role = 'instructor' AND is_active = 1 AND telegram_chat_id IS NOT NULL");
  const newSessions = parseJson(order.sessions, []);
  const out = [];
  for (const i of insts) {
    if (!isEligible(i, order)) continue;
    const [act] = await pool.execute("SELECT sessions FROM orders WHERE instructor_id = ? AND status IN ('taken','confirmed')", [i.id]);
    const existing = act.flatMap(o => parseJson(o.sessions, []));
    if (!scheduleConflict(newSessions, existing)) out.push(i);
  }
  return out;
}

async function assignDiagnostics(order) {
  const pool = db.getPool();
  const [insts] = await pool.execute("SELECT * FROM users WHERE role = 'instructor'");
  if (!insts.length) return 'No instructors exist yet.';
  const norm = x => String(x == null ? '' : x).trim().toLowerCase();
  const lines = insts.map(i => {
    const reasons = [];
    if (!i.is_active) reasons.push('inactive');
    if (!i.telegram_chat_id) reasons.push('hasn\'t opened the bot (/start)');
    const gear = parseJson(i.gear, []).map(norm);
    if (!gear.includes(norm(order.sport_type))) reasons.push('no ' + order.sport_type + ' gear');
    const teach = parseJson(i.teach_levels, null);
    const lvOk = Array.isArray(teach) && teach.length ? teach.map(norm).includes(norm(order.skill_level)) : true;
    if (!lvOk) reasons.push("doesn't teach " + order.skill_level);
    const langs = parseJson(i.spoken_languages, []).map(norm);
    const reqLangs = parseJson(order.required_languages, []).map(norm).filter(Boolean);
    if (reqLangs.length && !reqLangs.some(l => langs.includes(l))) reasons.push('no ' + reqLangs.join('/'));
    return `• <b>${i.name || i.telegram_username}</b>: ${reasons.length ? reasons.join(', ') : 'matches — likely a time-slot conflict'}`;
  });
  return `Order needs: <b>${order.sport_type} · ${order.skill_level}${parseJson(order.required_languages, []).length ? ' · ' + parseJson(order.required_languages, []).join('/') : ''}</b>\n\nWhy each instructor was skipped:\n` + lines.join('\n');
}

bot.action(/admin_assign_(\d+)/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) return ctx.answerCbQuery(t(user?.language, 'access_denied'));
  const pool = db.getPool();
  const [[order]] = await pool.execute('SELECT * FROM orders WHERE id = ?', [ctx.match[1]]);
  if (!order) return ctx.answerCbQuery(t(user.language, 'order_not_found'));
  if (order.status !== 'pending_review' && order.status !== 'in_group') return ctx.answerCbQuery('Order already handled');
  const eligible = await eligibleInstructorsFor(order);
  await ctx.answerCbQuery();
  if (!eligible.length) {
    const diag = await assignDiagnostics(order);
    return trackReply(ctx, `No eligible instructor for order #${order.id}.\n\n${diag}`, { parse_mode: 'HTML' });
  }
  const rows = eligible.map(i => [Markup.button.callback(`${i.name || i.telegram_username}`, `cfm:admin_assignto_${order.id}_${i.id}`)]);
  rows.push([Markup.button.callback('« Cancel', 'admin_assign_cancel')]);
  await trackReply(ctx, `» Assign order #${order.id} directly to:`, Markup.inlineKeyboard(rows));
});

bot.action('admin_assign_cancel', async (ctx) => { await ctx.answerCbQuery(); try { await ctx.deleteMessage(); } catch (e) {} });

// Two-step confirm for impactful money actions (assign, refund, cancel+refund). A button whose
// callback is `cfm:<realCallback>` first swaps the message keyboard to Yes/No; Yes fires the real
// callback (which is idempotent + audit-logged), No restores the viewer or drops the buttons.
bot.action(/^cfm:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const real = ctx.match[1];
  try {
    await ctx.editMessageReplyMarkup({ inline_keyboard: [[
      { text: '\u2713 Yes, confirm', callback_data: real },
      { text: '\u2717 No', callback_data: 'cfm_no' }
    ]] });
  } catch (e) {}
});
bot.action('cfm_no', async (ctx) => {
  await ctx.answerCbQuery('Cancelled');
  const user = await requireUser(ctx);
  if (user && await refreshViewerIfActive(ctx, user)) return;
  try { await ctx.editMessageReplyMarkup(undefined); } catch (e) {}
});

// /order <id> — jump straight to an order in the single-message viewer (Current set, else All).
bot.command('order', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  const n = Number(String((ctx.message.text.split(/\s+/)[1] || '')).replace('#', ''));
  if (!n) return trackReply(ctx, 'Usage: /order 17');
  await clearScreen(ctx.chat.id);
  trackUserMessage(ctx);
  let mode = 'current';
  let orders = await loadViewerOrders('current', user);
  let idx = orders.findIndex(o => o.id === n);
  if (idx < 0) { mode = 'all'; orders = await loadViewerOrders('all', user); idx = orders.findIndex(o => o.id === n); }
  if (idx < 0) return trackReply(ctx, `Order #${n} not found in your list.`);
  const st = currentViewer.get(ctx.chat.id) || {};
  st.mode = mode; st.idx = idx;
  currentViewer.set(ctx.chat.id, st);
  await renderCurrentViewer(ctx, user, { fresh: false, mode });
});

bot.action(/^admin_assignto_(\d+)_(\d+)$/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) return ctx.answerCbQuery(t(user?.language, 'access_denied'));
  const pool = db.getPool();
  const orderId = ctx.match[1], instrId = ctx.match[2];
  const [[order]] = await pool.execute('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) return ctx.answerCbQuery(t(user.language, 'order_not_found'));
  if (order.status !== 'pending_review' && order.status !== 'in_group') return ctx.answerCbQuery('Order already handled');
  const [[instructor]] = await pool.execute('SELECT * FROM users WHERE id = ? AND is_active = 1', [instrId]);
  if (!instructor) return ctx.answerCbQuery('✗ Instructor unavailable');
  if (!isEligible(instructor, order)) return ctx.answerCbQuery('✗ Instructor no longer eligible');
  const newSlots = new Set(parseJson(order.sessions, []).map(s => `${s.date}|${s.timeWindow}`));
  const [act] = await pool.execute("SELECT sessions FROM orders WHERE instructor_id = ? AND status IN ('taken','confirmed')", [instrId]);
  if (act.some(o => parseJson(o.sessions, []).some(s => newSlots.has(`${s.date}|${s.timeWindow}`)))) return ctx.answerCbQuery('✗ That instructor has a clashing session.');

  await pool.execute(
    "UPDATE orders SET status = 'taken', instructor_id = ?, whatsapp_deadline_at = ?, whatsapp_clicked = 0 WHERE id = ?",
    [instrId, time.nowBaliString(WHATSAPP_WINDOW_MIN), orderId]
  );
  await db.logAction(ctx.from.username, user.role, 'assigned_order', orderId, { instructorId: instrId });
  await refreshAllStatusPanels();
  if (order.group_message_id) { try { await bot.telegram.deleteMessage(INSTRUCTORS_GROUP_ID, order.group_message_id); } catch (e) {} }
  await clearPoolDMs(order);
  await clearAdminBcasts(order);

  const updated = { ...order, status: 'taken', instructor_id: instrId };
  if (instructor.telegram_chat_id) {
    const kb = Markup.inlineKeyboard([[
      Markup.button.url(t(instructor.language, 'whatsapp_btn'), trackedWhatsappUrl(order)),
      Markup.button.url(t(instructor.language, 'calendar_btn'), calendarUrl(order))
    ]]);
    const deadlineHM = time.nowBaliString(WHATSAPP_WINDOW_MIN).slice(11, 16);
    try {
      const sent = await bot.telegram.sendMessage(
        instructor.telegram_chat_id,
        fullOrderMessage(updated, {}) + `\n\nYou have 5 minutes to message the client on WhatsApp.`,
        { parse_mode: 'HTML', protect_content: true, ...kb }
      );
      await pool.execute('UPDATE orders SET instructor_message_id = ? WHERE id = ?', [sent.message_id, orderId]);
    } catch (e) { console.error('assign send error:', e.message); }
  }
  await ctx.answerCbQuery('✓ Assigned');
  // The assign picker is a SEPARATE message from the order viewer. Remove the picker, post a
  // standalone service confirmation, and re-render the still-open viewer IN PLACE by its stored
  // message id so it keeps paginating/updating (the old code left it stale & unresponsive).
  try { await ctx.deleteMessage(); } catch (e) {}
  await trackReply(ctx, `✓ Order #${orderId} assigned to ${instructor.name || instructor.telegram_username}${instructor.telegram_username ? ' @' + String(instructor.telegram_username).replace(/^@/, '') : ''}.`);
  if (viewerActive(ctx.chat.id)) { await renderCurrentViewer(ctx, user, { byMsgId: true }); }
  try {
    const [adminRows] = await pool.execute("SELECT * FROM users WHERE role IN ('admin','super_admin') AND telegram_chat_id IS NOT NULL");
    for (const a of adminRows) { if (a.id === user.id) continue; bot.telegram.sendMessage(a.telegram_chat_id, `Order #${orderId} assigned to ${instructor.name || instructor.telegram_username} by ${user.name || ('@' + ctx.from.username)}`).catch(() => {}); }
  } catch (e) {}
});

// Express redirect used by the WhatsApp button — records the click, then bounces to wa.me.
function registerWhatsappRedirect(app) {
  app.get('/wa/:orderId', async (req, res) => {
    try {
      const pool = db.getPool();
      const [rows] = await pool.execute('SELECT o.*, u.name AS instructor_name FROM orders o LEFT JOIN users u ON u.id = o.instructor_id WHERE o.id = ?', [req.params.orderId]);
      const order = rows[0];
      if (!order) return res.redirect('https://wa.me/');
      if (!order.whatsapp_clicked) {
        await pool.execute("UPDATE orders SET whatsapp_clicked = 1, whatsapp_clicked_at = ?, status = 'confirmed' WHERE id = ?", [time.nowBaliString(), order.id]);
        try { await refreshAllStatusPanels(); } catch (e) {}
        try { await email.bookingConfirmedEmail(order); } catch (e) { console.error('bookingConfirmedEmail error:', e.message); }
        // Don't rely solely on editing the original message's button (fragile: wrong/stale
        // message id, edit permission edge cases, etc — silent no-op if it fails). The
        // authoritative checkmark state is order.whatsapp_clicked, recomputed live wherever
        // an order card is re-rendered (Current orders, All orders); this is just a best-effort
        // touch-up of the original message PLUS a guaranteed separate confirmation ping so the
        // instructor always sees SOMETHING even if the edit silently fails.
        if (order.instructor_id) {
          try {
            const [[instructor]] = await pool.execute('SELECT telegram_chat_id, language FROM users WHERE id = ?', [order.instructor_id]);
            if (instructor && instructor.telegram_chat_id && order.instructor_message_id) {
              // Instructor tapped WhatsApp → remove the order card from their chat and confirm.
              try { await bot.telegram.deleteMessage(instructor.telegram_chat_id, order.instructor_message_id); } catch (e) {}
              await pool.execute('UPDATE orders SET instructor_message_id = NULL WHERE id = ?', [order.id]);
              // Transient service toast: confirm, then auto-remove after a few seconds.
              try {
                const toast = await bot.telegram.sendMessage(instructor.telegram_chat_id, `✓ Order #${order.id} — session confirmed`);
                setTimeout(() => { bot.telegram.deleteMessage(instructor.telegram_chat_id, toast.message_id).catch(() => {}); }, 5000);
              } catch (e) {}
            }
          } catch (e) { console.error('wa redirect instructor-notify error:', e.message); }
        }
      }
      return res.redirect(contactDeepLink(order, order.instructor_name || 'your coach'));
    } catch (e) {
      console.error('wa redirect error:', e.message);
      try { return res.redirect('https://wa.me/'); } catch (e2) {}
    }
  });
}

// ============================================================
// FINANCES
// ============================================================

// Cutoff timestamp (Bali wall-clock string) for a reporting period, or null for all-time.
function periodCutoff(period) {
  if (period === 'week') return time.nowBaliString(-7 * 24 * 60);
  if (period === 'month') return time.nowBaliString(-30 * 24 * 60);
  return null;
}

function periodKeyboard(active, lang) {
  const label = (p, key) => (p === active ? '• ' : '') + m(lang, key);
  return Markup.inlineKeyboard([[
    Markup.button.callback(label('week', 'period_week'), 'fin_period_week'),
    Markup.button.callback(label('month', 'period_month'), 'fin_period_month'),
    Markup.button.callback(label('all', 'period_all'), 'fin_period_all')
  ]]);
}

function financesKeyboard(period, user) {
  const label = (p, key) => (p === period ? '• ' : '') + m(user.language, key);
  const periodRow = [
    Markup.button.callback(label('week', 'period_week'), 'fin_period_week'),
    Markup.button.callback(label('month', 'period_month'), 'fin_period_month'),
    Markup.button.callback(label('all', 'period_all'), 'fin_period_all')
  ];
  const rows = [periodRow];
  if (user.role === 'super_admin') rows.push([Markup.button.callback('📈 Key metrics', 'fin_kpi')]);
  return Markup.inlineKeyboard(rows);
}

async function kpiText(user, period) {
  const pool = db.getPool();
  const cutoff = periodCutoff(period);
  const [rows] = await pool.execute(
    `SELECT status, total_price, session_price, deposit_price, addons, sessions, media_dates, participants, client_email, sport_type, created_at FROM orders${cutoff ? ' WHERE created_at >= ?' : ''}`,
    cutoff ? [cutoff] : []);
  const total = rows.length;
  const completed = rows.filter(r => r.status === 'completed');
  const cc = completed.length;
  const won = rows.filter(r => r.status === 'confirmed' || r.status === 'completed').length;
  const cancelled = rows.filter(r => r.status === 'cancelled').length;
  const refunded = rows.filter(r => r.status === 'deposit_refunded' || r.status === 'deposit_refund_pending').length;
  const sum = (arr, f) => arr.reduce((s, r) => s + f(r), 0);
  const pct = (a, b) => b ? Math.round(a / b * 100) : 0;
  const round = n => Math.round(n);
  const grossRevenue = sum(completed, r => Number(r.total_price || 0));
  const sessionsRev = sum(completed, r => Number(r.session_price || 0));
  const addonsRev = sum(completed, r => addonsSubtotal(parseJson(r.addons, [])));
  const depositsColl = sum(rows.filter(r => r.status !== 'cancelled'), r => Number(r.deposit_price || 0));
  const avgOrder = cc ? round(grossRevenue / cc) : 0;
  const avgRiders = cc ? (sum(completed, r => Number(r.participants || 1)) / cc).toFixed(1) : '0';
  const avgSessions = cc ? (sum(completed, r => parseJson(r.sessions, []).length || 1) / cc).toFixed(1) : '0';
  const hasType = (r, ty) => parseJson(r.sessions, []).some(s => Array.isArray(s.addons) && s.addons.some(a => a.type === ty)) || (ty === 'media' && parseJson(r.media_dates, []).length);
  const hasTransfer = r => parseJson(r.sessions, []).some(s => Array.isArray(s.addons) && s.addons.some(a => a.type === 'transferTo' || a.type === 'transferBack'));
  const withAddons = completed.filter(r => addonsSubtotal(parseJson(r.addons, [])) > 0).length;
  const mediaAttach = pct(completed.filter(r => hasType(r, 'media')).length, cc);
  const rentalAttach = pct(completed.filter(r => hasType(r, 'rental')).length, cc);
  const transferAttach = pct(completed.filter(hasTransfer).length, cc);
  // Repeat / new clients (by email, among completed).
  const byEmail = {};
  for (const r of completed) byEmail[r.client_email] = (byEmail[r.client_email] || 0) + 1;
  const clients = Object.keys(byEmail).length;
  const repeatClients = Object.values(byEmail).filter(n => n > 1).length;
  // Top discipline / spot / weekday / avg lead time.
  const mode = obj => { let k = '—', mx = 0; for (const [key, n] of Object.entries(obj)) if (n > mx) { mx = n; k = key; } return k; };
  const discCount = {}, spotCount = {}, dowCount = {}; let leadSum = 0, leadN = 0;
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (const r of completed) {
    discCount[sportShort(r.sport_type)] = (discCount[sportShort(r.sport_type)] || 0) + 1;
    const first = parseJson(r.sessions, [])[0];
    if (first && first.spot) spotCount[first.spot] = (spotCount[first.spot] || 0) + 1;
    if (first && first.date) {
      const d = new Date(first.date + 'T00:00:00Z');
      if (!isNaN(d)) dowCount[DOW[d.getUTCDay()]] = (dowCount[DOW[d.getUTCDay()]] || 0) + 1;
      const created = new Date(String(r.created_at).replace(' ', 'T') + 'Z');
      if (!isNaN(created) && !isNaN(d)) { leadSum += (d - created) / 86400000; leadN++; }
    }
  }
  const avgLead = leadN ? (leadSum / leadN).toFixed(1) : '0';
  const periodLabel = m(user.language, period === 'week' ? 'period_week' : period === 'month' ? 'period_month' : 'period_all');
  return `<b>Key metrics — ${periodLabel}</b>\n\n` +
    `<b>Volume</b>\n` +
    `Orders (all): ${total}\n` +
    `Completed: ${cc} · Won: ${won}\n` +
    `Cancelled: ${cancelled} · Refunds: ${refunded}\n\n` +
    `<b>Revenue (completed)</b>\n` +
    `Gross (client): $${grossRevenue}\n` +
    `Sessions: $${sessionsRev} · Add-ons: $${addonsRev}\n` +
    `Deposits collected: $${depositsColl}\n` +
    `Avg order value: $${avgOrder}\n\n` +
    `<b>Rates</b>\n` +
    `Conversion (paid → won): ${pct(won, total)}%\n` +
    `Cancellation: ${pct(cancelled, total)}%\n` +
    `Refund: ${pct(refunded, total)}%\n` +
    `Add-on attach: ${pct(withAddons, cc)}%\n` +
    `— media ${mediaAttach}% · rental ${rentalAttach}% · transfer ${transferAttach}%\n\n` +
    `<b>Behaviour</b>\n` +
    `Clients: ${clients} · repeat ${pct(repeatClients, clients)}%\n` +
    `Avg riders/order: ${avgRiders}\n` +
    `Avg sessions/order: ${avgSessions}\n` +
    `Avg lead time: ${avgLead} d\n\n` +
    `<b>Popularity</b>\n` +
    `Top discipline: ${mode(discCount)}\n` +
    `Top spot: ${mode(spotCount)}\n` +
    `Busiest weekday: ${mode(dowCount)}`;
}

bot.action('fin_stats', async (ctx) => {
  const user = await requireUser(ctx); if (!user || user.role === 'instructor') return ctx.answerCbQuery();
  const c = await liveCounts();
  try { await ctx.editMessageText(statusPanelText(c), { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('« Finances', 'fin_back')]]) }); } catch (e) {}
  await ctx.answerCbQuery();
});
bot.action('fin_kpi', async (ctx) => {
  const user = await requireUser(ctx); if (!user || user.role !== 'super_admin') return ctx.answerCbQuery();
  try { await ctx.editMessageText(await kpiText(user, 'all'), { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('« Finances', 'fin_back')]]) }); } catch (e) {}
  await ctx.answerCbQuery();
});
bot.action('fin_back', async (ctx) => {
  const user = await requireUser(ctx); if (!user || user.role === 'instructor') return ctx.answerCbQuery();
  try { await ctx.editMessageText(await financesText(user, 'week'), { parse_mode: 'HTML', ...financesKeyboard('week', user) }); } catch (e) {}
  await ctx.answerCbQuery();
});

// Admin/super_admin finances card: sessions revenue and add-ons revenue are always
// reported separately (they're different money — add-ons pass through, don't count
// as "our" revenue the same way), and deposits are their own line (that's collected
// upfront and is our income independent of whether the session revenue is realized).
async function financesText(user, period) {
  const pool = db.getPool();
  const cutoff = periodCutoff(period);
  // Finances count ONLY executed (completed) orders — cancelled, refunded and in-progress
  // (pending/in_group/taken/confirmed) orders are excluded; money is only "real" once the session ran.
  const activeStatuses = "status = 'completed'";
  const params = [];
  let where = activeStatuses;
  if (cutoff) { where += ' AND created_at >= ?'; params.push(cutoff); }
  // Same filter, but qualified for the instructor-join query below (orders AND users both
  // have a created_at column, so the unqualified version would throw "ambiguous column").
  const activeStatusesQ = "o.status = 'completed'";
  const paramsQ = [];
  let whereQ = activeStatusesQ;
  if (cutoff) { whereQ += ' AND o.created_at >= ?'; paramsQ.push(cutoff); }
  const periodLabel = m(user.language, period === 'week' ? 'period_week' : period === 'month' ? 'period_month' : 'period_all');

  const [rows] = await pool.execute(`SELECT session_price, addons, deposit_price FROM orders WHERE ${where}`, params);
  const sessionsRevenue = rows.reduce((s, r) => s + Number(r.session_price || 0), 0);
  const addonsRevenue = rows.reduce((s, r) => s + addonsSubtotal(parseJson(r.addons, [])), 0);

  const [instRows] = await pool.execute(
    `SELECT u.name, u.telegram_username, COUNT(o.id) n, COALESCE(SUM(o.session_price),0) rev
     FROM orders o JOIN users u ON u.id = o.instructor_id
     WHERE ${whereQ} AND o.instructor_id IS NOT NULL
     GROUP BY u.id ORDER BY rev DESC LIMIT 5`,
    paramsQ
  );
  const topLines = instRows.map((r, i) => `${i + 1}. ${r.name || r.telegram_username} — $${Math.round(Number(r.rev) * 0.8)} (${r.n} ${m(user.language, 'orders_suffix')})`).join('\n') || m(user.language, 'no_data');

  let text = `<b>${m(user.language, 'finances_title')} — ${periodLabel}</b>\n` +
    `${m(user.language, 'active_orders')}: ${rows.length}\n\n` +
    `────────────────\n` +
    `${m(user.language, 'sessions_revenue')}: $${sessionsRevenue}\n` +
    `${m(user.language, 'addons_revenue')}: $${addonsRevenue}\n`;

  if (user.role === 'super_admin') {
    const depositsIncome = rows.reduce((s, r) => s + Number(r.deposit_price || 0), 0);
    const [[refunded]] = await pool.execute(
      `SELECT COUNT(*) n, COALESCE(SUM(deposit_price),0) sum FROM orders WHERE status IN ('deposit_refunded','deposit_refund_pending')${cutoff ? ' AND created_at >= ?' : ''}`,
      cutoff ? [cutoff] : []
    );
    text += `${m(user.language, 'deposits_income')}: $${depositsIncome}\n\n${m(user.language, 'refunded_pending')}: ${refunded.n} ($${Number(refunded.sum)})`;
  }

  text += `\n────────────────\n<b>${m(user.language, 'top_instructors')}</b>\n${topLines}`;
  return text;
}

bot.hears(/Finances|Финансы/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  await clearScreen(ctx.chat.id);
  trackUserMessage(ctx);

  if (user.role === 'instructor') {
    const pool = db.getPool();
    // Instructors see ONLY the current month — no all-time total.
    const monthStart = time.nowBaliString().slice(0, 7) + '-01 00:00:00';
    const [[mine]] = await pool.execute(
      "SELECT COUNT(*) n, COALESCE(SUM(session_price),0) rev FROM orders WHERE instructor_id = ? AND status IN ('confirmed','completed') AND created_at >= ?",
      [user.id, monthStart]
    );
    return trackReply(ctx, `<b>${m(user.language, 'your_earnings_title')} — ${m(user.language, 'period_month')}</b>\n\n${m(user.language, 'orders_word')}: ${mine.n}\n${m(user.language, 'earnings_total')}: $${Math.round(Number(mine.rev) * 0.8)}`, { parse_mode: 'HTML' });
  }
  // admin + super_admin — same period-switchable card, super_admin gets the deposits line too
  const text = await financesText(user, 'week');
  return trackReply(ctx, text, { parse_mode: 'HTML', ...financesKeyboard('week', user) });
});

bot.action(/fin_period_(all|week|month)/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role === 'instructor') return ctx.answerCbQuery();
  const period = ctx.match[1];
  const text = await financesText(user, period);
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...financesKeyboard(period, user) });
  } catch (e) {}
  return ctx.answerCbQuery();
});

// ============================================================
// STATISTICS (admin + super_admin)
// ============================================================

const STATS_LABELS = {
  en: { title: 'STATISTICS', pending: 'Pending review', in_group: 'In group pool', taken: 'Taken', confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled', refund_pending: 'Refund pending', refunded: 'Refunded', total_active: 'Total active', revenue: 'Gross revenue (active)' },
  ru: { title: 'СТАТИСТИКА', pending: 'На рассмотрении', in_group: 'В пуле группы', taken: 'Взяты', confirmed: 'Подтверждены', completed: 'Завершены', cancelled: 'Отменены', refund_pending: 'Ожидают возврата', refunded: 'Возвращены', total_active: 'Всего активных', revenue: 'Выручка (активные)' }
};
function sl(lang, key) { return (STATS_LABELS[lang] && STATS_LABELS[lang][key]) || STATS_LABELS.en[key]; }

// ============================================================
// ALL ORDERS (admin + super_admin) / MY ORDERS (instructor)
// ============================================================

function orderStatusKeyboard(order, user) {
  // super_admin can cancel+refund from anywhere; plain admin can only resend/delete while pending-ish.
  const rows = [];
  if (order.status === 'pending_review') rows.push([Markup.button.callback(t(user.language, 'send_to_group_btn'), `admin_send_${order.id}`)]);
  // Direct-assign is available while the order is unclaimed (pending OR sitting in the group pool);
  // once an instructor has taken it (taken/confirmed) it's no longer offered.
  if (['pending_review', 'in_group'].includes(order.status)) rows.push([Markup.button.callback('Assign to instructor', `admin_assign_${order.id}`)]);
  if (['taken', 'confirmed'].includes(order.status)) {
    rows.push([Markup.button.callback(t(user.language, 'return_to_group_btn'), `admin_returntogroup_${order.id}`)]);
  }
  if (['pending_review', 'in_group', 'taken', 'confirmed'].includes(order.status) && user.role === 'super_admin') {
    rows.push([Markup.button.callback(t(user.language, 'cancel_refund_btn'), `cfm:admin_cancelrefund_${order.id}`)]);
  }
  if (user.role === 'super_admin' || user.role === 'admin') rows.push([Markup.button.callback(t(user.language, 'delete_btn'), `admin_delete_${order.id}`)]);
  return rows.length ? Markup.inlineKeyboard(rows) : undefined;
}

// ============================================================
// ALL ORDERS — skischool.ge-style: one paginated inline-keyboard list,
// most recent first, Prev/Next + page indicator, with a toggle to the
// grouped detailed view (in-group / taken / cancelled / refunds).
// ============================================================
const ALL_ORDERS_PAGE_SIZE = 10;
const allOrdersPagination = new Map(); // chatId -> { orders, page }

function pageLabel(lang) { return `${t(lang, 'page_word')} %PAGE% ${t(lang, 'of_word')} %TOTAL%`; }

function renderAllOrdersPage(chatId, lang) {
  const state = allOrdersPagination.get(chatId);
  if (!state) return { text: m(lang, 'no_orders'), keyboard: undefined };
  const disc = state.disc || 'all';
  const filtered = disc === 'all' ? state.allOrders : state.allOrders.filter(o => (o.sport_type || '').toLowerCase() === disc);
  state.orders = filtered;
  // Discipline filter chips (only shown when orders span >1 discipline).
  const discs = [...new Set(state.allOrders.map(o => (o.sport_type || '').toLowerCase()).filter(Boolean))];
  const filterRow = [];
  if (discs.length > 1) {
    filterRow.push(Markup.button.callback((disc === 'all' ? '• ' : '') + (lang === 'ru' ? 'Все' : 'All'), 'all_disc_all'));
    for (const d of discs) filterRow.push(Markup.button.callback((disc === d ? '• ' : '') + d, `all_disc_${d}`));
  }
  const title = state.scope === 'mine' ? (lang === 'ru' ? 'Все ваши занятия' : 'All your sessions') : (lang === 'ru' ? 'Все заказы' : 'All orders');
  if (!filtered.length) {
    return { text: `<b>${title} (0)</b>\n\n${m(lang, 'no_orders')}`, keyboard: filterRow.length ? Markup.inlineKeyboard([filterRow]) : undefined };
  }
  const totalPages = Math.ceil(filtered.length / ALL_ORDERS_PAGE_SIZE);
  const page = Math.min(Math.max(1, state.page), totalPages);
  state.page = page;
  const slice = filtered.slice((page - 1) * ALL_ORDERS_PAGE_SIZE, page * ALL_ORDERS_PAGE_SIZE);
  const pageRow = totalPages > 1 ? [Markup.button.callback(t(lang, 'prev_page_btn'), 'all_orders_prev'), Markup.button.callback(t(lang, 'next_page_btn'), 'all_orders_next')] : null;
  // Bulk-delete mode: each order becomes a checkbox; select across pages, then delete all at once.
  if (state.deleteMode) {
    const selected = state.selected || (state.selected = []);
    const rows = slice.map(o => [Markup.button.callback(`${selected.includes(o.id) ? '☑' : '☐'} #${o.id} ${sportShort(o.sport_type)} · ${sl(lang, COMPACT_STATUS_KEY[o.status] || 'pending')}`, `all_del_toggle_${o.id}`)]);
    if (pageRow) rows.push(pageRow);
    rows.push([Markup.button.callback(`🗑 Delete selected (${selected.length})`, 'all_del_confirm'), Markup.button.callback('✗ Exit', 'all_del_exit')]);
    return { text: `<b>${title} — delete mode</b>\nTap orders to select, then Delete.\n\n${t(lang, 'page_word')} ${page} ${t(lang, 'of_word')} ${totalPages}`, keyboard: Markup.inlineKeyboard(rows) };
  }
  const text = `<b>${title} (${filtered.length})</b>\n\n` +
    slice.map(o => compactOrderLine(o, lang, state.scope !== 'mine')).join('\n') +
    `\n\n${t(lang, 'page_word')} ${page} ${t(lang, 'of_word')} ${totalPages}`;
  const rows = [];
  if (filterRow.length) rows.push(filterRow);
  if (pageRow) rows.push(pageRow);
  if (state.scope !== 'mine') rows.push([Markup.button.callback('🗑 Delete orders', 'all_del_start')]);
  return { text, keyboard: rows.length ? Markup.inlineKeyboard(rows) : undefined };
}

// "All orders": compact one-line list, paginated, with a discipline filter for scanning large
// volumes. Admin/super see all non-cancelled orders; an instructor sees only their finished +
// upcoming sessions (completed/taken/confirmed) — never deleted/cancelled or returned-to-pool ones.
bot.hears(/All orders|Все заказы/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  await clearScreen(ctx.chat.id);
  trackUserMessage(ctx);
  await renderAllOrdersList(ctx, user);
});
async function renderAllOrdersList(ctx, user) {
  const pool = db.getPool();
  let orders, scope;
  if (user.role === 'instructor') {
    [orders] = await pool.execute("SELECT * FROM orders WHERE instructor_id = ? AND status IN ('taken','confirmed','completed') ORDER BY created_at ASC LIMIT 300", [user.id]);
    scope = 'mine';
  } else {
    [orders] = await pool.execute("SELECT o.*, u.name AS instructor_name, u.telegram_username AS instructor_username FROM orders o LEFT JOIN users u ON u.id = o.instructor_id WHERE o.status != 'cancelled' ORDER BY o.pinned DESC, o.created_at ASC LIMIT 300");
    scope = 'all';
  }
  allOrdersPagination.set(ctx.chat.id, { allOrders: orders, orders, page: 1, scope, disc: 'all' });
  const { text, keyboard } = renderAllOrdersPage(ctx.chat.id, user.language);
  await trackReply(ctx, text, { parse_mode: 'HTML', ...(keyboard || {}) });
}

bot.action(/all_disc_(.+)/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return ctx.answerCbQuery();
  const state = allOrdersPagination.get(ctx.chat.id);
  if (!state) return ctx.answerCbQuery();
  state.disc = ctx.match[1];
  state.page = 1;
  const { text, keyboard } = renderAllOrdersPage(ctx.chat.id, user.language);
  try { await ctx.editMessageText(text, { parse_mode: 'HTML', ...(keyboard || {}) }); } catch (e) {}
  await ctx.answerCbQuery();
});

bot.action(/all_orders_(prev|next)/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || (user.role !== 'admin' && user.role !== 'super_admin' && user.role !== 'instructor')) return ctx.answerCbQuery(t(user?.language, 'access_denied'));
  const state = allOrdersPagination.get(ctx.chat.id);
  if (!state) return ctx.answerCbQuery();
  const totalPages = Math.ceil(state.orders.length / ALL_ORDERS_PAGE_SIZE);
  const delta = ctx.match[1] === 'next' ? 1 : -1;
  const nextPage = state.page + delta;
  if (nextPage < 1 || nextPage > totalPages) return ctx.answerCbQuery(); // already at an edge, no-op like the reference bot
  state.page = nextPage;
  const { text, keyboard } = renderAllOrdersPage(ctx.chat.id, user.language);
  await ctx.answerCbQuery();
  try { await ctx.editMessageText(text, { parse_mode: 'HTML', ...(keyboard || {}) }); } catch (e) {}
});

async function rerenderAllOrders(ctx, user) {
  const { text, keyboard } = renderAllOrdersPage(ctx.chat.id, user.language);
  try { await ctx.editMessageText(text, { parse_mode: 'HTML', ...(keyboard || {}) }); } catch (e) {}
}
bot.action('all_del_start', async (ctx) => {
  const user = await requireUser(ctx); if (!user || user.role === 'instructor') return ctx.answerCbQuery();
  const state = allOrdersPagination.get(ctx.chat.id); if (!state) return ctx.answerCbQuery();
  state.deleteMode = true; state.selected = [];
  await rerenderAllOrders(ctx, user); await ctx.answerCbQuery();
});
bot.action('all_del_exit', async (ctx) => {
  const user = await requireUser(ctx); if (!user) return ctx.answerCbQuery();
  const state = allOrdersPagination.get(ctx.chat.id); if (!state) return ctx.answerCbQuery();
  state.deleteMode = false; state.selected = [];
  await rerenderAllOrders(ctx, user); await ctx.answerCbQuery();
});
bot.action(/all_del_toggle_(\d+)/, async (ctx) => {
  const user = await requireUser(ctx); if (!user) return ctx.answerCbQuery();
  const state = allOrdersPagination.get(ctx.chat.id); if (!state) return ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  state.selected = state.selected || [];
  state.selected = state.selected.includes(id) ? state.selected.filter(x => x !== id) : [...state.selected, id];
  await rerenderAllOrders(ctx, user); await ctx.answerCbQuery();
});
bot.action('all_del_confirm', async (ctx) => {
  const user = await requireUser(ctx); if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) return ctx.answerCbQuery(t(user?.language, 'access_denied'));
  const state = allOrdersPagination.get(ctx.chat.id); if (!state) return ctx.answerCbQuery();
  const ids = state.selected || [];
  if (!ids.length) return ctx.answerCbQuery('Nothing selected');
  const pool = db.getPool();
  await pool.execute(`UPDATE orders SET status='cancelled', pinned=0 WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  await db.logAction(ctx.from.username, user.role, 'bulk_delete_orders', null, { ids });
  state.allOrders = state.allOrders.filter(o => !ids.includes(o.id));
  state.selected = []; state.deleteMode = false; state.page = 1;
  await refreshAllStatusPanels();
  await rerenderAllOrders(ctx, user);
  await ctx.answerCbQuery(`Deleted ${ids.length}`);
});
// them (in group pool / taken / cancelled / refunds). For an instructor, their own currently
// active bookings (taken/confirmed, not yet completed) with WhatsApp/Calendar buttons.
bot.hears(/Current orders|Текущие заказы/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  await clearScreen(ctx.chat.id);
  trackUserMessage(ctx);
  await renderCurrentViewer(ctx, user, { fresh: true, mode: 'current' });
});

// Refunds manager (super_admin only): one paginated card list of pending + completed refunds,
// each with its "Mark as refunded" action. Read-only for anyone else — guarded by role.
bot.hears(/Refunds/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role !== 'super_admin') return;
  await clearScreen(ctx.chat.id);
  trackUserMessage(ctx);
  await renderCurrentViewer(ctx, user, { fresh: true, mode: 'refunds' });
});

// ---- Single-message order viewer (one order at a time, inline nav, no chat scroll) ----
// Used by BOTH "Current orders" (mode 'current') and "All orders" (mode 'all'), for every role.
const currentViewer = new Map(); // chatId -> { mode, ids:[], idx, msgId }

async function loadViewerOrders(mode, user) {
  const pool = db.getPool();
  if (mode === 'pending') {
    const [rows] = await pool.execute(
      `SELECT o.*, u.name AS instructor_name, u.telegram_username AS instructor_username
       FROM orders o LEFT JOIN users u ON u.id = o.instructor_id
       WHERE o.status = 'pending_review' ORDER BY o.created_at ASC`);
    return rows;
  }
  if (mode === 'refunds') {
    // Refund management (super_admin): pending refunds first (money still owed), then done ones.
    const [rows] = await pool.execute(
      `SELECT o.*, u.name AS instructor_name, u.telegram_username AS instructor_username
       FROM orders o LEFT JOIN users u ON u.id = o.instructor_id
       WHERE o.status IN ('deposit_refund_pending','deposit_refunded')
       ORDER BY FIELD(o.status,'deposit_refund_pending','deposit_refunded'), o.created_at ASC`);
    return rows;
  }
  if (mode === 'all') {
    if (user.role === 'instructor') {
      const [rows] = await pool.execute(
        `SELECT o.*, u.name AS instructor_name, u.telegram_username AS instructor_username
         FROM orders o LEFT JOIN users u ON u.id = o.instructor_id
         WHERE o.instructor_id = ? ORDER BY o.created_at ASC LIMIT 300`, [user.id]);
      return rows;
    }
    const [rows] = await pool.execute(
      `SELECT o.*, u.name AS instructor_name, u.telegram_username AS instructor_username
       FROM orders o LEFT JOIN users u ON u.id = o.instructor_id
       WHERE o.status != 'cancelled' ORDER BY o.created_at ASC LIMIT 300`);
    return rows;
  }
  // mode 'toconfirm' (instructor): their taken-not-confirmed orders PLUS every eligible order
  // still open in the pool (the "Incoming" section — mirrors the group/DM, minus double-takes).
  if (mode === 'toconfirm') {
    const [mine] = await pool.execute(
      "SELECT * FROM orders WHERE instructor_id = ? AND status = 'taken' ORDER BY created_at ASC", [user.id]);
    const [poolRows] = await pool.execute(
      "SELECT * FROM orders WHERE status = 'in_group' ORDER BY created_at ASC");
    const incoming = poolRows.filter(o => isEligible(user, o));
    return [...mine, ...incoming];
  }
  // mode 'current'
  if (user.role === 'instructor') {
    const [rows] = await pool.execute(
      "SELECT * FROM orders WHERE instructor_id = ? AND status = 'confirmed' ORDER BY created_at ASC", [user.id]);
    return rows;
  }
  const [rows] = await pool.execute(
    `SELECT o.*, u.name AS instructor_name, u.telegram_username AS instructor_username
     FROM orders o LEFT JOIN users u ON u.id = o.instructor_id
     WHERE o.status IN ('in_group','taken','confirmed','deposit_refund_pending')
     ORDER BY o.pinned DESC, FIELD(o.status,'in_group','taken','confirmed','deposit_refund_pending'), o.created_at ASC`);
  return rows;
}

function ordersTabRow(active) {
  return [
    Markup.button.callback((active === 'cal' ? '● ' : '') + '📆 Calendar', 'ordtab_cal'),
    Markup.button.callback((active === 'cur' ? '● ' : '') + '🟡 Current', 'ordtab_cur'),
    Markup.button.callback((active === 'all' ? '● ' : '') + '📋 All', 'ordtab_all')
  ];
}

function currentViewerCard(order, idx, total, user, mode) {
  const instructorName = order.instructor_name ? `${order.instructor_name}${order.instructor_username ? ' @' + String(order.instructor_username).replace(/^@/, '') : ''}` : undefined;
  const isRefund = order.status === 'deposit_refund_pending';
  const nav = [
    Markup.button.callback('◀', 'cur_prev'),
    Markup.button.callback(`${idx + 1} / ${total}`, 'cur_noop'),
    Markup.button.callback('▶', 'cur_next')
  ];
  let body, actionRows = [];
  // Pin toggle: admins/super-admins in "Current orders" can star an order to keep it on top.
  const canPin = mode === 'current' && (user.role === 'admin' || user.role === 'super_admin');
  const pinRow = canPin ? [Markup.button.callback(
    order.pinned ? (user.language === 'ru' ? '📌 Открепить' : '📌 Unpin') : (user.language === 'ru' ? '📌 Закрепить' : '📌 Pin'),
    `cur_pin_${order.id}`)] : null;
  if (user.role === 'instructor') {
    body = fullOrderMessage(order, { showEarnings: true });
    if (order.status === 'taken' || order.status === 'confirmed') {
      actionRows = [[
        Markup.button.url(order.whatsapp_clicked ? '✓ WhatsApp' : t(user.language, 'whatsapp_btn'), trackedWhatsappUrl(order)),
        Markup.button.url(t(user.language, 'calendar_btn'), calendarUrl(order))
      ]];
    } else if (order.status === 'in_group') {
      // Incoming pool order shown in the instructor's "To confirm" — same TAKE action as the DM/group.
      actionRows = [[ Markup.button.callback(TAKE_BTN_GROUP_LABEL, `take_${order.id}`) ]];
    }
  } else if (order.status === 'deposit_refunded') {
    body = `<b>Order #${order.id} — refunded</b>\n${order.client_name}\n────────────\n$${order.deposit_price} via ${order.deposit_payment_method}`;
    actionRows = [];
  } else if (isRefund && user.role === 'super_admin') {
    body = refundTaskMessage(order);
    actionRows = [[Markup.button.callback('✓ Mark as refunded', `cfm:admin_markrefunded_${order.id}`)]];
  } else {
    body = fullOrderMessage(order, { admin: true, instructorName });
    actionRows = (orderStatusKeyboard(order, user) || { reply_markup: { inline_keyboard: [] } }).reply_markup.inline_keyboard;
  }
  if (canPin && order.pinned) body = '📌\n' + body;
  return { text: body, keyboard: Markup.inlineKeyboard([...(pinRow ? [pinRow] : []), ...actionRows, nav]) };
}

function emptyViewerMsg(mode, user) {
  const inst = user.role === 'instructor';
  if (mode === 'pending') return m(user.language, 'nothing_pending');
  if (mode === 'refunds') return m(user.language, 'empty_refunds');
  if (mode === 'toconfirm') return user.language === 'ru' ? 'Нет заказов к подтверждению — всё чисто.' : 'Nothing to confirm — all clear.';
  if (mode === 'all') return m(user.language, inst ? 'empty_my_all' : 'empty_all');
  return m(user.language, inst ? 'empty_my_current' : 'empty_current');
}

async function renderCurrentViewer(ctx, user, { fresh = false, edit = false, byMsgId = false, mode } = {}) {
  const chatId = ctx.chat.id;
  let st = currentViewer.get(chatId) || { idx: 0, mode: 'current' };
  if (mode) st.mode = mode;
  // Immediate loading placeholder on a fresh open (feels responsive on a cold DB); it's edited
  // into the real card once the query returns.
  let loadingMsg = null;
  if (!edit && !byMsgId) { try { loadingMsg = await trackReply(ctx, m(user.language, 'viewer_loading')); } catch (e) {} }
  const orders = await loadViewerOrders(st.mode, user);
  if (fresh) st.idx = 0;
  st.ids = orders.map(o => o.id);
  if (!orders.length) {
    currentViewer.delete(chatId);
    const empty = emptyViewerMsg(st.mode, user);
    const opts = { parse_mode: 'HTML' };
    if (loadingMsg) { try { await ctx.telegram.editMessageText(chatId, loadingMsg.message_id, undefined, empty, opts); } catch (e) {} return; }
    if (byMsgId && st.msgId) { try { await bot.telegram.editMessageText(chatId, st.msgId, undefined, empty, opts); } catch (e) {} return; }
    if (edit) { try { await ctx.editMessageText(empty, opts); } catch (e) {} return; }
    return trackReply(ctx, empty, opts);
  }
  if (st.idx >= orders.length) st.idx = orders.length - 1;
  if (st.idx < 0) st.idx = 0;
  const { text, keyboard } = currentViewerCard(orders[st.idx], st.idx, orders.length, user, st.mode);
  if (byMsgId && st.msgId) {
    // Re-render the viewer card IN PLACE by its stored message id, even when the triggering
    // callback came from a DIFFERENT message (e.g. the assign-instructor picker). This is what
    // keeps the viewer live after an assign — previously it was left stale and unresponsive.
    try { await bot.telegram.editMessageText(chatId, st.msgId, undefined, text, { parse_mode: 'HTML', ...keyboard }); } catch (e) {}
  } else if (edit) {
    try { await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }); } catch (e) {}
    st.msgId = ctx.callbackQuery && ctx.callbackQuery.message ? ctx.callbackQuery.message.message_id : st.msgId;
  } else if (loadingMsg) {
    try { await ctx.telegram.editMessageText(chatId, loadingMsg.message_id, undefined, text, { parse_mode: 'HTML', ...keyboard }); st.msgId = loadingMsg.message_id; }
    catch (e) { const sent = await trackReply(ctx, text, { parse_mode: 'HTML', ...keyboard }); st.msgId = sent.message_id; }
  } else {
    const sent = await trackReply(ctx, text, { parse_mode: 'HTML', ...keyboard });
    st.msgId = sent.message_id;
  }
  currentViewer.set(chatId, st);
}

// True when a viewer message is currently open for this chat (regardless of which message the
// callback fired from). Used by actions reachable from a SEPARATE message (assign picker).
function viewerActive(chatId) {
  const st = currentViewer.get(chatId);
  return !!(st && st.msgId);
}

bot.action(/cur_pin_(\d+)/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role === 'instructor') return ctx.answerCbQuery();
  if (!inCurrentViewer(ctx)) return ctx.answerCbQuery();
  const orderId = Number(ctx.match[1]);
  const pool = db.getPool();
  await pool.execute('UPDATE orders SET pinned = 1 - pinned WHERE id = ?', [orderId]);
  const st = currentViewer.get(ctx.chat.id);
  // Keep the viewer on the same order after the list re-sorts (pinned jump to the top).
  const orders = await loadViewerOrders(st.mode, user);
  const newIdx = orders.findIndex(o => o.id === orderId);
  if (newIdx >= 0) st.idx = newIdx;
  currentViewer.set(ctx.chat.id, st);
  await renderCurrentViewer(ctx, user, { edit: true });
  await ctx.answerCbQuery('');
});

bot.action('cur_noop', ctx => ctx.answerCbQuery());
bot.action(/cur_(prev|next)/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return ctx.answerCbQuery();
  const st = currentViewer.get(ctx.chat.id);
  if (!st) return ctx.answerCbQuery();
  const total = st.ids.length;
  st.idx = ctx.match[1] === 'next' ? (st.idx + 1) % total : (st.idx - 1 + total) % total;
  currentViewer.set(ctx.chat.id, st);
  await renderCurrentViewer(ctx, user, { edit: true });
  await ctx.answerCbQuery();
});

// True when the tapped inline button belongs to the order viewer message.
function inCurrentViewer(ctx) {
  const st = currentViewer.get(ctx.chat.id);
  return !!(st && ctx.callbackQuery && ctx.callbackQuery.message && st.msgId === ctx.callbackQuery.message.message_id);
}
async function refreshViewerIfActive(ctx, user) {
  if (!inCurrentViewer(ctx)) return false;
  await renderCurrentViewer(ctx, user, { edit: true });
  return true;
}

// ============================================================
// PEOPLE VIEWER — instructors & admins as ONE message with ◀ idx/total ▶ nav (same UX as
// Current/Pending orders), instead of a stream of per-person cards.
// ============================================================
const peopleViewer = new Map(); // chatId -> { kind:'instructors'|'admins', ids, idx, msgId }

async function loadPeople(kind) {
  const [rows] = await db.getPool().execute('SELECT * FROM users WHERE role = ? ORDER BY name', [kind === 'admins' ? 'admin' : 'instructor']);
  return rows;
}

function personCard(row, idx, total, kind, user) {
  const nav = [
    Markup.button.callback('◀', 'people_prev'),
    Markup.button.callback(`${idx + 1} / ${total}`, 'people_noop'),
    Markup.button.callback('▶', 'people_next')
  ];
  let text, actionRows = [];
  const uname = String(row.telegram_username).replace(/^@/, '');
  const title = row.name ? `<b>${row.name}</b> (@${uname})` : `<b>@${uname}</b>`;
  if (kind === 'instructors') {
    const gear = parseJson(row.gear, []).join(', ') || '—';
    const langs = parseJson(row.spoken_languages, []).join(', ') || '—';
    const lvl = parseJson(row.teach_levels, []).length ? parseJson(row.teach_levels, []).join(', ') : ((row.level_min || '?') + '–' + (row.level_max || '?'));
    text = `${row.is_active ? '✓ ' : ''}${title}  ${m(user.language, 'strikes_label')}: ${row.rating_strikes}\n\n` +
      `${m(user.language, 'gear_label')}: ${gear}\n` +
      `${m(user.language, 'level_label')}: ${lvl}\n` +
      `${m(user.language, 'languages_label')}: ${langs}`;
    actionRows.push([
      Markup.button.callback(row.is_active ? m(user.language, 'deactivate_btn') : m(user.language, 'activate_btn'), `inst_toggle_${row.id}`),
      Markup.button.callback(m(user.language, 'reset_strikes_btn'), `inst_resetstrikes_${row.id}`)
    ]);
    if (user.role === 'super_admin') {
      actionRows.push([
        Markup.button.callback('Gear', `inst_eg_${row.id}`),
        Markup.button.callback('Level', `inst_el_${row.id}`),
        Markup.button.callback('Langs', `inst_ela_${row.id}`)
      ]);
      actionRows.push([Markup.button.callback(m(user.language, 'remove_btn'), `inst_remove_${row.id}`)]);
    }
  } else {
    text = title;
    if (user.role === 'super_admin') actionRows.push([Markup.button.callback(m(user.language, 'remove_btn'), `admin_remove_${row.id}`)]);
  }
  const addFooter = user.role === 'super_admin'
    ? [[Markup.button.callback(kind === 'admins' ? m(user.language, 'add_admin_btn') : m(user.language, 'add_instructor_btn'), kind === 'admins' ? 'admin_add' : 'inst_add')]]
    : [];
  return { text, keyboard: Markup.inlineKeyboard([...actionRows, nav, ...addFooter]) };
}

async function renderPeopleViewer(ctx, user, { kind, fresh = false, edit = false, idx } = {}) {
  const chatId = ctx.chat.id;
  let st = peopleViewer.get(chatId) || { kind, idx: 0 };
  st.kind = kind;
  if (typeof idx === 'number') st.idx = idx;
  if (fresh) st.idx = 0;
  const rows = await loadPeople(kind);
  st.ids = rows.map(r => r.id);
  const addKb = user.role === 'super_admin'
    ? Markup.inlineKeyboard([[Markup.button.callback(kind === 'admins' ? m(user.language, 'add_admin_btn') : m(user.language, 'add_instructor_btn'), kind === 'admins' ? 'admin_add' : 'inst_add')]])
    : undefined;
  if (!rows.length) {
    peopleViewer.delete(chatId);
    const empty = kind === 'admins' ? m(user.language, 'no_admins') : m(user.language, 'no_instructors');
    const opts = { parse_mode: 'HTML', ...(addKb || {}) };
    if (edit) { try { await ctx.editMessageText(empty, opts); } catch (e) {} return; }
    const sent = await trackReply(ctx, empty, opts); st.msgId = sent.message_id; peopleViewer.set(chatId, st); return;
  }
  if (st.idx >= rows.length) st.idx = rows.length - 1;
  if (st.idx < 0) st.idx = 0;
  const { text, keyboard } = personCard(rows[st.idx], st.idx, rows.length, kind, user);
  if (edit) { try { await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }); } catch (e) {} }
  else { const sent = await trackReply(ctx, text, { parse_mode: 'HTML', ...keyboard }); st.msgId = sent.message_id; }
  peopleViewer.set(chatId, st);
}

bot.action('people_noop', ctx => ctx.answerCbQuery());
bot.action(/people_(prev|next)/, async (ctx) => {
  const user = await requireUser(ctx); if (!user) return ctx.answerCbQuery();
  const st = peopleViewer.get(ctx.chat.id); if (!st) return ctx.answerCbQuery();
  const rows = await loadPeople(st.kind);
  if (!rows.length) return ctx.answerCbQuery();
  st.idx = (st.idx + (ctx.match[1] === 'next' ? 1 : -1) + rows.length) % rows.length;
  peopleViewer.set(ctx.chat.id, st);
  await renderPeopleViewer(ctx, user, { kind: st.kind, edit: true, idx: st.idx });
  await ctx.answerCbQuery();
});

// ============================================================
// ADMINS MANAGEMENT (super_admin only) — add/remove plain admins
// ============================================================

bot.hears(/Admins|Админы/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role !== 'super_admin') return ctx.reply(t(user?.language, 'access_denied'));
  await renderAdmins(ctx, user);
});
async function renderAdmins(ctx, user) {
  await clearScreen(ctx.chat.id);
  trackUserMessage(ctx);
  await renderPeopleViewer(ctx, user, { kind: 'admins', fresh: true });
}

bot.action('admin_add', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role !== 'super_admin') return ctx.answerCbQuery(t(user?.language, 'access_denied'));
  conversationState.set(ctx.from.id, { step: 'add_admin_name' });
  await ctx.answerCbQuery();
  await trackReply(ctx, m(user.language, 'ask_name'));
});

bot.action(/admin_remove_(\d+)/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role !== 'super_admin') return ctx.answerCbQuery(t(user?.language, 'access_denied'));
  const pool = db.getPool();
  await pool.execute('DELETE FROM users WHERE id = ? AND role = "admin"', [ctx.match[1]]);
  await db.logAction(ctx.from.username, user.role, 'remove_admin', null, { adminId: ctx.match[1] });
  await ctx.answerCbQuery(m(user.language, 'removed'));
  await renderPeopleViewer(ctx, user, { kind: 'admins', edit: true });
});

// ============================================================
// INSTRUCTOR MANAGEMENT (super_admin: add/remove/edit; instructor: self-edit gear/level/lang)
// ============================================================

bot.hears(/Instructors|Инструкторы/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) return ctx.reply(t(user?.language, 'access_denied'));
  await renderInstructors(ctx, user);
});
async function renderInstructors(ctx, user) {
  await clearScreen(ctx.chat.id);
  trackUserMessage(ctx);
  await renderPeopleViewer(ctx, user, { kind: 'instructors', fresh: true });
}

// Gear/level/language selection is entirely inline-button multi-select rather than free
// text — a typo, wrong separator, or unexpected casing in a comma-separated answer used to
// silently produce a value that could never match isEligible()'s exact string comparisons,
// so a miskeyed instructor could never be handed an order from the group. Buttons make an
// invalid value structurally impossible: only the exact slugs isEligible() checks against
// are ever selectable.
const GEAR_OPTIONS = ['surf', 'kite', 'wing', 'sup'];
const LEVEL_OPTIONS = ['first-timer', 'beginner', 'intermediate', 'advanced'];
const LANG_OPTIONS = ['en', 'ru'];

function gearPickKeyboard(selected) {
  const rows = GEAR_OPTIONS.map(g => [Markup.button.callback(`${selected.includes(g) ? '✓' : ''} ${g}`, `instadd_gear_${g}`)]);
  rows.push([Markup.button.callback('✔Done', 'instadd_gear_done')]);
  return Markup.inlineKeyboard(rows);
}
function levelPickKeyboard(prefix, selected) {
  const rows = LEVEL_OPTIONS.map(l => [Markup.button.callback(`${l === selected ? '' : ''} ${l}`, `${prefix}_${l}`)]);
  return Markup.inlineKeyboard(rows);
}
function levelMultiKeyboard(selected) {
  const rows = LEVEL_OPTIONS.map(l => [Markup.button.callback(`${selected.includes(l) ? '✓' : ''} ${l}`, `instadd_level_${l}`)]);
  rows.push([Markup.button.callback('✔ Done', 'instadd_levels_done')]);
  return Markup.inlineKeyboard(rows);
}
function langPickKeyboard(selected) {
  const rows = LANG_OPTIONS.map(l => [Markup.button.callback(`${selected.includes(l) ? '✓' : ''} ${l}`, `instadd_lang_${l}`)]);
  rows.push([Markup.button.callback('✔Done', 'instadd_lang_done')]);
  return Markup.inlineKeyboard(rows);
}

function addInstructorKeyboard(lang) {
  return Markup.inlineKeyboard([[Markup.button.callback(m(lang, 'add_instructor_btn'), 'inst_add')]]);
}

bot.action('inst_add', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role !== 'super_admin') return ctx.answerCbQuery(t(user?.language, 'access_denied'));
  conversationState.set(ctx.from.id, { step: 'add_instructor_username' });
  await ctx.answerCbQuery();
  await trackReply(ctx, m(user.language, 'send_instructor_username'));
});

bot.action(/instadd_gear_(surf|kite|wing|sup)/, async (ctx) => {
  const state = conversationState.get(ctx.from.id);
  const user = await requireUser(ctx);
  if (!user || !state || state.step !== 'add_instructor_gear') return ctx.answerCbQuery();
  const g = ctx.match[1];
  state.gear = state.gear || [];
  state.gear = state.gear.includes(g) ? state.gear.filter(x => x !== g) : [...state.gear, g];
  await ctx.answerCbQuery();
  try { await ctx.editMessageReplyMarkup(gearPickKeyboard(state.gear).reply_markup); } catch (e) {}
});

bot.action('instadd_gear_done', async (ctx) => {
  const state = conversationState.get(ctx.from.id);
  const user = await requireUser(ctx);
  if (!user || !state || state.step !== 'add_instructor_gear') return ctx.answerCbQuery();
  if (!state.gear || !state.gear.length) return ctx.answerCbQuery('✗ Pick at least one');
  state.step = 'add_instructor_levels';
  state.levels = [];
  await ctx.answerCbQuery();
  try { await ctx.deleteMessage(); } catch (e) {}
  await trackReply(ctx, m(user.language, 'ask_levels'), levelMultiKeyboard(state.levels));
});

bot.action(/instadd_level_(first-timer|beginner|intermediate|advanced)/, async (ctx) => {
  const state = conversationState.get(ctx.from.id);
  const user = await requireUser(ctx);
  if (!user || !state || state.step !== 'add_instructor_levels') return ctx.answerCbQuery();
  const l = ctx.match[1];
  state.levels = state.levels.includes(l) ? state.levels.filter(x => x !== l) : [...state.levels, l];
  await ctx.answerCbQuery();
  try { await ctx.editMessageReplyMarkup(levelMultiKeyboard(state.levels).reply_markup); } catch (e) {}
});

bot.action('instadd_levels_done', async (ctx) => {
  const state = conversationState.get(ctx.from.id);
  const user = await requireUser(ctx);
  if (!user || !state || state.step !== 'add_instructor_levels') return ctx.answerCbQuery();
  if (!state.levels || !state.levels.length) return ctx.answerCbQuery('✗ Pick at least one');
  state.step = 'add_instructor_langs';
  state.spoken_languages = [];
  await ctx.answerCbQuery();
  try { await ctx.deleteMessage(); } catch (e) {}
  await trackReply(ctx, m(user.language, 'ask_langs'), langPickKeyboard(state.spoken_languages));
});

bot.action(/instadd_levelmin_(first-timer|beginner|intermediate|advanced)/, async (ctx) => {
  const state = conversationState.get(ctx.from.id);
  const user = await requireUser(ctx);
  if (!user || !state || state.step !== 'add_instructor_level_min') return ctx.answerCbQuery();
  state.level_min = ctx.match[1];
  state.step = 'add_instructor_level_max';
  await ctx.answerCbQuery();
  try { await ctx.deleteMessage(); } catch (e) {}
  await trackReply(ctx, m(user.language, 'ask_level_max'), levelPickKeyboard('instadd_levelmax', null));
});

bot.action(/instadd_levelmax_(first-timer|beginner|intermediate|advanced)/, async (ctx) => {
  const state = conversationState.get(ctx.from.id);
  const user = await requireUser(ctx);
  if (!user || !state || state.step !== 'add_instructor_level_max') return ctx.answerCbQuery();
  const max = ctx.match[1];
  if (LEVEL_OPTIONS.indexOf(max) < LEVEL_OPTIONS.indexOf(state.level_min)) return ctx.answerCbQuery('✗ Must be ≥ min level');
  state.level_max = max;
  state.step = 'add_instructor_langs';
  state.spoken_languages = [];
  await ctx.answerCbQuery();
  try { await ctx.deleteMessage(); } catch (e) {}
  await trackReply(ctx, m(user.language, 'ask_langs'), langPickKeyboard(state.spoken_languages));
});

bot.action(/instadd_lang_(en|ru)/, async (ctx) => {
  const state = conversationState.get(ctx.from.id);
  const user = await requireUser(ctx);
  if (!user || !state || state.step !== 'add_instructor_langs') return ctx.answerCbQuery();
  const l = ctx.match[1];
  state.spoken_languages = state.spoken_languages.includes(l) ? state.spoken_languages.filter(x => x !== l) : [...state.spoken_languages, l];
  await ctx.answerCbQuery();
  try { await ctx.editMessageReplyMarkup(langPickKeyboard(state.spoken_languages).reply_markup); } catch (e) {}
});

bot.action('instadd_lang_done', async (ctx) => {
  const state = conversationState.get(ctx.from.id);
  const user = await requireUser(ctx);
  if (!user || !state || state.step !== 'add_instructor_langs') return ctx.answerCbQuery();
  if (!state.spoken_languages.length) return ctx.answerCbQuery('✗ Pick at least one');
  const pool = db.getPool();
  await pool.execute(
    'INSERT INTO users (telegram_username, role, name, gear, teach_levels, spoken_languages, is_active) VALUES (?, "instructor", ?, ?, ?, ?, 1)',
    [state.username, state.name, JSON.stringify(state.gear), JSON.stringify(state.levels || []), JSON.stringify(state.spoken_languages)]
  );
  await db.logAction(ctx.from.username, user.role, 'add_instructor', null, { username: state.username });
  conversationState.delete(ctx.from.id);
  await ctx.answerCbQuery();
  await clearScreen(ctx.chat.id);
  await trackReply(ctx, `✓ ${state.username} ${m(user.language, 'added_as_instructor')}`);
});

bot.action(/inst_toggle_(\d+)/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) return ctx.answerCbQuery(t(user?.language, 'access_denied'));
  const pool = db.getPool();
  await pool.execute('UPDATE users SET is_active = NOT is_active WHERE id = ?', [ctx.match[1]]);
  await db.logAction(ctx.from.username, user.role, 'toggle_instructor_active', null, { instructorId: ctx.match[1] });
  await ctx.answerCbQuery(m(user.language, 'updated'));
  await editInstCard(ctx, ctx.match[1]);
});

bot.action(/inst_resetstrikes_(\d+)/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) return ctx.answerCbQuery(t(user?.language, 'access_denied'));
  const pool = db.getPool();
  await pool.execute('UPDATE users SET rating_strikes = 0, is_active = 1 WHERE id = ?', [ctx.match[1]]);
  await db.logAction(ctx.from.username, user.role, 'reset_strikes', null, { instructorId: ctx.match[1] });
  await ctx.answerCbQuery(m(user.language, 'strikes_reset'));
  await editInstCard(ctx, ctx.match[1]);
});

bot.action(/inst_remove_(\d+)/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role !== 'super_admin') return ctx.answerCbQuery(t(user?.language, 'access_denied'));
  const pool = db.getPool();
  await pool.execute('DELETE FROM users WHERE id = ? AND role = "instructor"', [ctx.match[1]]);
  await db.logAction(ctx.from.username, user.role, 'remove_instructor', null, { instructorId: ctx.match[1] });
  await ctx.answerCbQuery(m(user.language, 'removed'));
  await renderPeopleViewer(ctx, user, { kind: 'instructors', edit: true });
});

// ---- Super-admin: edit an EXISTING instructor's gear / level / languages, live in place ----
async function editInstCard(ctx, id) {
  const st = peopleViewer.get(ctx.chat.id);
  if (st && st.kind === 'instructors') {
    const rows = await loadPeople('instructors');
    const idx = rows.findIndex(r => String(r.id) === String(id));
    if (idx >= 0) { const u = await requireUser(ctx); st.idx = idx; peopleViewer.set(ctx.chat.id, st); return renderPeopleViewer(ctx, u, { kind: 'instructors', edit: true, idx }); }
  }
  const pool = db.getPool();
  const [[i]] = await pool.execute('SELECT * FROM users WHERE id = ? AND role = "instructor"', [id]);
  if (!i) { try { await ctx.editMessageText('Instructor not found.'); } catch (e) {} return; }
  const gear = parseJson(i.gear, []).join(', ') || '—';
  const langs = parseJson(i.spoken_languages, []).join(', ') || '—';
  const text = `${i.is_active ? '✓' : ''} <b>${i.name || i.telegram_username}</b> (${i.telegram_username})\n` +
    `Gear: ${gear} · Level: ${parseJson(i.teach_levels, []).length ? parseJson(i.teach_levels, []).join(', ') : ((i.level_min || '?') + '–' + (i.level_max || '?'))} · Langs: ${langs}`;
  const kb = Markup.inlineKeyboard([[
    Markup.button.callback('Gear', `inst_eg_${id}`),
    Markup.button.callback('Level', `inst_el_${id}`),
    Markup.button.callback('Langs', `inst_ela_${id}`)
  ]]);
  try { await ctx.editMessageText(text, { parse_mode: 'HTML', ...kb }); } catch (e) {}
}

// Gear (multi-select, saves on each toggle)
bot.action(/inst_eg_(\d+)/, async (ctx) => {
  const user = await requireUser(ctx); if (!user || user.role !== 'super_admin') return ctx.answerCbQuery();
  const [[i]] = await db.getPool().execute('SELECT gear FROM users WHERE id = ?', [ctx.match[1]]);
  const sel = parseJson(i.gear, []);
  const rows = GEAR_OPTIONS.map(g => [Markup.button.callback(`${sel.includes(g) ? '✓' : ''} ${g}`, `inst_egt_${ctx.match[1]}_${g}`)]);
  rows.push([Markup.button.callback('✔Done', `inst_edone_${ctx.match[1]}`)]);
  try { await ctx.editMessageText('Select gear:', Markup.inlineKeyboard(rows)); } catch (e) {}
  await ctx.answerCbQuery();
});
bot.action(/inst_egt_(\d+)_(surf|kite|wing|sup)/, async (ctx) => {
  const user = await requireUser(ctx); if (!user || user.role !== 'super_admin') return ctx.answerCbQuery();
  const id = ctx.match[1], g = ctx.match[2];
  const [[i]] = await db.getPool().execute('SELECT gear FROM users WHERE id = ?', [id]);
  let sel = parseJson(i.gear, []);
  sel = sel.includes(g) ? sel.filter(x => x !== g) : [...sel, g];
  await db.getPool().execute('UPDATE users SET gear = ? WHERE id = ?', [JSON.stringify(sel), id]);
  const rows = GEAR_OPTIONS.map(x => [Markup.button.callback(`${sel.includes(x) ? '✓' : ''} ${x}`, `inst_egt_${id}_${x}`)]);
  rows.push([Markup.button.callback('✔Done', `inst_edone_${id}`)]);
  try { await ctx.editMessageReplyMarkup(Markup.inlineKeyboard(rows).reply_markup); } catch (e) {}
  await ctx.answerCbQuery('Saved');
});

// Level (multi-select checkboxes — the exact set of levels the instructor teaches)
bot.action(/inst_el_(\d+)/, async (ctx) => {
  const user = await requireUser(ctx); if (!user || user.role !== 'super_admin') return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  await showLevelEditor(ctx, ctx.match[1]);
});
function levelEditRows(id, set) {
  const rows = LEVEL_OPTIONS.map(l => [Markup.button.callback(`${set.includes(l) ? '✓' : ''} ${l}`, `inst_ltgl_${id}_${l}`)]);
  rows.push([Markup.button.callback('✔ Done', `inst_ldone_${id}`)]);
  return Markup.inlineKeyboard(rows);
}
async function showLevelEditor(ctx, id) {
  const [[i]] = await db.getPool().execute('SELECT teach_levels FROM users WHERE id = ?', [id]);
  const set = parseJson(i && i.teach_levels, []);
  const kb = levelEditRows(id, Array.isArray(set) ? set : []);
  try { await ctx.editMessageText('Levels this instructor teaches:', kb); }
  catch (e) { await trackReply(ctx, 'Levels this instructor teaches:', kb); }
}
bot.action(/inst_ltgl_(\d+)_(first-timer|beginner|intermediate|advanced)/, async (ctx) => {
  const user = await requireUser(ctx); if (!user || user.role !== 'super_admin') return ctx.answerCbQuery();
  const id = ctx.match[1], lvl = ctx.match[2];
  const [[i]] = await db.getPool().execute('SELECT teach_levels FROM users WHERE id = ?', [id]);
  let set = parseJson(i && i.teach_levels, []); if (!Array.isArray(set)) set = [];
  set = set.includes(lvl) ? set.filter(x => x !== lvl) : [...set, lvl];
  await db.getPool().execute('UPDATE users SET teach_levels = ? WHERE id = ?', [JSON.stringify(set), id]);
  await ctx.answerCbQuery();
  try { await ctx.editMessageReplyMarkup(levelEditRows(id, set).reply_markup); } catch (e) {}
});
bot.action(/inst_ldone_(\d+)/, async (ctx) => {
  const user = await requireUser(ctx); if (!user || user.role !== 'super_admin') return ctx.answerCbQuery();
  await ctx.answerCbQuery('Saved');
  await editInstCard(ctx, ctx.match[1]);
});

// Languages (multi-select from the catalog languages list, saves on each toggle)
async function instLangRows(id, sel) {
  let langs = [];
  try { langs = await catalog.getLanguages(); } catch (e) {}
  if (!langs.length) langs = [{ code: 'en', label: 'English' }, { code: 'ru', label: 'Russian' }];
  const rows = langs.map(l => [Markup.button.callback(`${sel.includes(l.code) ? '✓' : ''} ${l.label} (${l.code})`, `inst_elat_${id}_${l.code}`)]);
  rows.push([Markup.button.callback('✔Done', `inst_edone_${id}`)]);
  return rows;
}
bot.action(/inst_ela_(\d+)/, async (ctx) => {
  const user = await requireUser(ctx); if (!user || user.role !== 'super_admin') return ctx.answerCbQuery();
  const [[i]] = await db.getPool().execute('SELECT spoken_languages FROM users WHERE id = ?', [ctx.match[1]]);
  const rows = await instLangRows(ctx.match[1], parseJson(i.spoken_languages, []));
  try { await ctx.editMessageText('Select languages:', Markup.inlineKeyboard(rows)); } catch (e) {}
  await ctx.answerCbQuery();
});
bot.action(/inst_elat_(\d+)_([a-z]{2,10})/, async (ctx) => {
  const user = await requireUser(ctx); if (!user || user.role !== 'super_admin') return ctx.answerCbQuery();
  const id = ctx.match[1], code = ctx.match[2];
  const [[i]] = await db.getPool().execute('SELECT spoken_languages FROM users WHERE id = ?', [id]);
  let sel = parseJson(i.spoken_languages, []);
  sel = sel.includes(code) ? sel.filter(x => x !== code) : [...sel, code];
  await db.getPool().execute('UPDATE users SET spoken_languages = ? WHERE id = ?', [JSON.stringify(sel), id]);
  const rows = await instLangRows(id, sel);
  try { await ctx.editMessageReplyMarkup(Markup.inlineKeyboard(rows).reply_markup); } catch (e) {}
  await ctx.answerCbQuery('Saved');
});

bot.action(/inst_edone_(\d+)/, async (ctx) => {
  const user = await requireUser(ctx); if (!user || user.role !== 'super_admin') return ctx.answerCbQuery();
  await db.logAction(ctx.from.username, user.role, 'edit_instructor', null, { instructorId: ctx.match[1] });
  await ctx.answerCbQuery('Updated');
  await editInstCard(ctx, ctx.match[1]);
});

// ============================================================
// DANGER ZONE (super_admin only) — typed-confirmation destructive actions
// ============================================================
bot.hears('🎒 Add-ons', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role !== 'super_admin') return;
  await clearScreen(ctx.chat.id);
  trackUserMessage(ctx);
  await renderAddonsMenu(ctx, user, true);
});
async function renderAddonsMenu(ctx, user, entry) {
  const ru = user.language === 'ru';
  const mediaPrice = await catalog.getAddonMediaPrice();
  const markupPct = await catalog.getTransferMarkupPct();
  const list = await catalog.listCustomAddons(false);
  let text = ru
    ? `<b>Допы</b>\nОдна цена/настройка на все услуги. Аренда снаряжения (цена/скидка/ON-OFF) настраивается по услуге ниже — там же в Spots можно задать цену проката для конкретного спота.\n\nМедиа-съёмка: $${mediaPrice}\nНаценка на трансфер: +${markupPct}%`
    : `<b>Add-ons</b>\nOne price/setting for every service. Rental (price/discount/ON-OFF) is set per service below — its Spots screen lets you override the price for one specific spot.\n\nMedia shoot: $${mediaPrice}\nTransfer markup: +${markupPct}%`;
  text += ru ? `\n\n<b>Свои допы</b> (флажок в форме, как медиа):` : `\n\n<b>Custom add-ons</b> (checkbox on the form, like media):`;
  const rows = [
    [Markup.button.callback(ru ? 'Цена медиа-съёмки' : 'Media price', 'addons_media')],
    [Markup.button.callback(ru ? 'Наценка на трансфер' : 'Transfer markup %', 'addons_transfermarkup')],
    [Markup.button.callback(ru ? '🏄 Аренда снаряжения' : '🏄 Rental', 'cat_home')]
  ];
  if (!list.length) text += ru ? '\n—' : '\n—';
  for (const a of list) {
    rows.push([
      Markup.button.callback(`${a.is_active ? '●' : '○'} ${a.label_en} — $${a.price}${Number(a.discount_pct) ? ' (−' + Number(a.discount_pct) + '%/day)' : ''}`, `addon_edit_${a.id}`),
      Markup.button.callback('✕', `addon_del_${a.id}`)
    ]);
  }
  rows.push([Markup.button.callback(ru ? '+ Добавить доп' : '+ Add add-on', 'addon_add')]);
  const extra = { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) };
  if (entry) await trackReply(ctx, text, extra);
  else { try { await ctx.editMessageText(text, extra); } catch (e) { await trackReply(ctx, text, extra); } }
}
bot.action('addon_add', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role !== 'super_admin') return ctx.answerCbQuery();
  conversationState.set(ctx.from.id, { step: 'addon_add_en' });
  await ctx.answerCbQuery();
  await clearScreen(ctx.chat.id);
  await trackReply(ctx, user.language === 'ru' ? 'Новый доп — отправьте название на английском (как в форме), напр. "GoPro rental"' : 'New add-on — send its label in English (shown on the form), e.g. "GoPro rental"');
});
bot.action(/addon_edit_(\d+)/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role !== 'super_admin') return ctx.answerCbQuery();
  const id = +ctx.match[1];
  const [a] = await catalog.listCustomAddons(false).then(l => l.filter(x => x.id === id));
  if (!a) return ctx.answerCbQuery();
  const ru = user.language === 'ru';
  await ctx.answerCbQuery();
  await clearScreen(ctx.chat.id);
  await trackReply(ctx, `<b>${a.label_en}</b>\n$${a.price} · −${Number(a.discount_pct)}%/day`, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback(ru ? 'Цена' : 'Price', `addon_price_${id}`), Markup.button.callback(ru ? 'Скидка %/день' : 'Discount %/day', `addon_disc_${id}`)],
      [Markup.button.callback(a.is_active ? (ru ? '○ Скрыть' : '○ Hide') : (ru ? '● Показать' : '● Show'), `addon_tgl_${id}`)],
      [Markup.button.callback(ru ? '« Назад' : '« Back', 'addons_back')]
    ])
  });
});
bot.action('addons_back', async (ctx) => { const user = await requireUser(ctx); if (!user || user.role !== 'super_admin') return ctx.answerCbQuery(); await ctx.answerCbQuery(); await clearScreen(ctx.chat.id); await renderAddonsMenu(ctx, user, true); });
bot.action(/addon_price_(\d+)/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role !== 'super_admin') return ctx.answerCbQuery();
  conversationState.set(ctx.from.id, { step: 'addon_price_val', id: +ctx.match[1] });
  await ctx.answerCbQuery();
  await clearScreen(ctx.chat.id);
  await trackReply(ctx, user.language === 'ru' ? 'Отправьте новую цену, напр. 50' : 'Send the new price, e.g. 50');
});
bot.action(/addon_disc_(\d+)/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role !== 'super_admin') return ctx.answerCbQuery();
  conversationState.set(ctx.from.id, { step: 'addon_disc_val', id: +ctx.match[1] });
  await ctx.answerCbQuery();
  await clearScreen(ctx.chat.id);
  await trackReply(ctx, user.language === 'ru' ? 'Скидка % за доп. день/занятие, напр. 10' : '% off per extra day/session, e.g. 10');
});
bot.action(/addon_tgl_(\d+)/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role !== 'super_admin') return ctx.answerCbQuery();
  const id = +ctx.match[1];
  const list = await catalog.listCustomAddons(false);
  const a = list.find(x => x.id === id); if (!a) return ctx.answerCbQuery();
  await catalog.updateCustomAddon(id, { is_active: a.is_active ? 0 : 1 });
  await ctx.answerCbQuery('✓');
  await clearScreen(ctx.chat.id);
  const ru = user.language === 'ru';
  const na = { ...a, is_active: a.is_active ? 0 : 1 };
  await trackReply(ctx, `<b>${na.label_en}</b>\n$${na.price} · −${Number(na.discount_pct)}%/day`, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback(ru ? 'Цена' : 'Price', `addon_price_${id}`), Markup.button.callback(ru ? 'Скидка %/день' : 'Discount %/day', `addon_disc_${id}`)],
      [Markup.button.callback(na.is_active ? (ru ? '○ Скрыть' : '○ Hide') : (ru ? '● Показать' : '● Show'), `addon_tgl_${id}`)],
      [Markup.button.callback(ru ? '« Назад' : '« Back', 'addons_back')]
    ])
  });
});
bot.action(/addon_del_(\d+)/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role !== 'super_admin') return ctx.answerCbQuery();
  await catalog.removeCustomAddon(+ctx.match[1]);
  await ctx.answerCbQuery('✓');
  await clearScreen(ctx.chat.id);
  await renderAddonsMenu(ctx, user, true);
});
bot.action('addons_transfermarkup', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role !== 'super_admin') return ctx.answerCbQuery();
  const pct = await catalog.getTransferMarkupPct();
  const ru = user.language === 'ru';
  conversationState.set(ctx.from.id, { step: 'addons_transfermarkup_val' });
  await ctx.answerCbQuery();
  await clearScreen(ctx.chat.id);
  await trackReply(ctx, ru
    ? `Текущая наценка: <b>+${pct}%</b> над средним тарифом Grab по маршруту.\nОтправьте новое число, напр. <b>20</b>.`
    : `Current markup: <b>+${pct}%</b> over the average Grab fare for the route.\nSend the new number, e.g. <b>20</b>.`, { parse_mode: 'HTML' });
});

bot.hears(/Settings/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role !== 'super_admin') return;
  await clearScreen(ctx.chat.id);
  trackUserMessage(ctx);
  const ru = user.language === 'ru';
  await trackReply(ctx, '<b>Settings</b>', {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback((refunds.isSandboxMode() ? '🟡 ' : '⚪️ ') + (ru ? 'Sandbox платежи: ' : 'Sandbox payments: ') + (refunds.isSandboxMode() ? (ru ? 'ВКЛ' : 'ON') : (ru ? 'ВЫКЛ' : 'OFF')), 'danger_sandbox_toggle')],
      [Markup.button.callback(ru ? 'Часы работы' : 'Working hours', 'settings_hours')],
      [Markup.button.callback(ru ? 'Блокировка периода' : 'Blocked periods', 'settings_blocked')],
      [Markup.button.callback(ru ? 'Удалить тестовые заказы' : 'Delete test orders', 'danger_deltest')],
      [Markup.button.callback(ru ? 'Очистить историю заказов' : 'Clear order history', 'danger_clear')],
      [Markup.button.callback(ru ? 'Рестарт бота' : 'Restart bot', 'danger_restart')]
    ])
  });
});

bot.action('settings_hours', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role !== 'super_admin') return ctx.answerCbQuery();
  const wh = await catalog.getWorkHours();
  const ru = user.language === 'ru';
  conversationState.set(ctx.from.id, { step: 'settings_hours_val' });
  await ctx.answerCbQuery();
  await clearScreen(ctx.chat.id);
  await trackReply(ctx, ru
    ? `Текущие часы: <b>${wh.open}:00–${wh.close}:00</b>.\nОтправьте новые как "открытие закрытие" в 24ч формате, напр. <b>8 16</b>.`
    : `Current hours: <b>${wh.open}:00–${wh.close}:00</b>.\nSend the new ones as "open close" in 24h, e.g. <b>8 16</b>.`, { parse_mode: 'HTML' });
});

bot.action('addons_media', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role !== 'super_admin') return ctx.answerCbQuery();
  const price = await catalog.getAddonMediaPrice();
  const ru = user.language === 'ru';
  conversationState.set(ctx.from.id, { step: 'addons_media_val' });
  await ctx.answerCbQuery();
  await clearScreen(ctx.chat.id);
  await trackReply(ctx, ru
    ? `Текущая цена медиа-съёмки: <b>$${price}</b> (одна цена на все услуги).\nОтправьте новую сумму, напр. <b>200</b>.`
    : `Current media add-on price: <b>$${price}</b> (one price for every service).\nSend the new amount, e.g. <b>200</b>.`, { parse_mode: 'HTML' });
});

bot.action('settings_blocked', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role !== 'super_admin') return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  await clearScreen(ctx.chat.id);
  await renderBlockedPeriods(ctx, user);
});
async function renderBlockedPeriods(ctx, user) {
  const ru = user.language === 'ru';
  const periods = await catalog.listBlockedPeriods();
  const fmt = d => (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
  let text = ru ? '<b>Блокировка периода</b>\n\nЭти даты скрыты на сайте и недоступны для брони. Существующие заказы не трогаем.\n\n' : '<b>Blocked periods</b>\n\nThese dates are hidden on the site and can\'t be booked. Existing orders are left alone.\n\n';
  text += periods.length ? periods.map(p => `${fmt(p.start_date)} → ${fmt(p.end_date)}${p.note ? ' — ' + p.note : ''}`).join('\n') : (ru ? 'Пока нет заблокированных периодов.' : 'No blocked periods yet.');
  const rows = periods.map(p => [Markup.button.callback(`🗑 ${fmt(p.start_date)} → ${fmt(p.end_date)}`, `settings_blockdel_${p.id}`)]);
  rows.push([Markup.button.callback(ru ? '+ Добавить период' : '+ Add period', 'settings_blockadd')]);
  await trackReply(ctx, text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) });
}
bot.action('settings_blockadd', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role !== 'super_admin') return ctx.answerCbQuery();
  const ru = user.language === 'ru';
  conversationState.set(ctx.from.id, { step: 'settings_blockadd_val' });
  await ctx.answerCbQuery();
  await clearScreen(ctx.chat.id);
  await trackReply(ctx, ru
    ? 'Отправьте: <b>ГГГГ-ММ-ДД ГГГГ-ММ-ДД [заметка]</b>\nнапр. 2026-12-24 2026-12-26 Christmas'
    : 'Send: <b>YYYY-MM-DD YYYY-MM-DD [note]</b>\ne.g. 2026-12-24 2026-12-26 Christmas', { parse_mode: 'HTML' });
});
bot.action(/settings_blockdel_(\d+)/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role !== 'super_admin') return ctx.answerCbQuery();
  await catalog.removeBlockedPeriod(+ctx.match[1]);
  await db.logAction(ctx.from.username, user.role, 'blocked_period_removed', null, { id: ctx.match[1] });
  await ctx.answerCbQuery('✓ Removed');
  await renderBlockedPeriods(ctx, user);
});

bot.action('danger_sandbox_toggle', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role !== 'super_admin') return ctx.answerCbQuery();
  const next = !refunds.isSandboxMode();
  refunds.setSandboxMode(next);
  await db.setSetting('paypal_sandbox', next ? '1' : '0');
  await db.logAction(ctx.from.username, user.role, 'danger_sandbox_toggle', null, { on: next });
  const ru = user.language === 'ru';
  await ctx.answerCbQuery(next ? (ru ? '🟡 Sandbox включён — новые заказы пойдут как тестовые' : '🟡 Sandbox ON — new orders are marked test') : (ru ? '⚪️ Sandbox выключен — живые платёжи' : '⚪️ Sandbox OFF — live payments'));
  try {
    await ctx.editMessageReplyMarkup(Markup.inlineKeyboard([
      [Markup.button.callback((refunds.isSandboxMode() ? '🟡 ' : '⚪️ ') + (ru ? 'Sandbox платежи: ' : 'Sandbox payments: ') + (refunds.isSandboxMode() ? (ru ? 'ВКЛ' : 'ON') : (ru ? 'ВЫКЛ' : 'OFF')), 'danger_sandbox_toggle')],
      [Markup.button.callback(ru ? 'Часы работы' : 'Working hours', 'settings_hours')],
      [Markup.button.callback(ru ? 'Блокировка периода' : 'Blocked periods', 'settings_blocked')],
      [Markup.button.callback(ru ? 'Удалить тестовые заказы' : 'Delete test orders', 'danger_deltest')],
      [Markup.button.callback(ru ? 'Очистить историю заказов' : 'Clear order history', 'danger_clear')],
      [Markup.button.callback(ru ? 'Рестарт бота' : 'Restart bot', 'danger_restart')]
    ]).reply_markup);
  } catch (e) {}
});

bot.action('danger_deltest', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role !== 'super_admin') return ctx.answerCbQuery();
  conversationState.set(ctx.from.id, { step: 'danger_deltest' });
  const ru = user.language === 'ru';
  const [[c]] = await db.getPool().execute('SELECT COUNT(*) c FROM orders WHERE is_test = 1');
  await clearScreen(ctx.chat.id);
  await trackReply(ctx, ru
    ? `Найдено тестовых заказов: <b>${c.c}</b> (созданы, пока был включён Sandbox). Чтобы подтвердить, отправьте <b>DELETE TEST</b>. Любой другой текст — отмена.`
    : `Found <b>${c.c}</b> test order(s) (created while Sandbox was ON). To confirm, send <b>DELETE TEST</b>. Any other text cancels.`, { parse_mode: 'HTML' });
  await ctx.answerCbQuery();
});

bot.action(/danger_(clear|restart)/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role !== 'super_admin') return ctx.answerCbQuery();
  const kind = ctx.match[1];
  conversationState.set(ctx.from.id, { step: 'danger_' + kind });
  const ru = user.language === 'ru';
  const word = kind === 'clear' ? 'CLEAR' : 'RESTART';
  await clearScreen(ctx.chat.id);
  await trackReply(ctx, ru
    ? `Чтобы подтвердить, отправьте сообщение <b>${word}</b> (заглавными). Любой другой текст — отмена.`
    : `To confirm, send the message <b>${word}</b> (uppercase). Any other text cancels.`, { parse_mode: 'HTML' });
  await ctx.answerCbQuery();
});

// ============================================================
// INSTRUCTOR CALENDAR — single inline message, week/month views
// ============================================================
const calendarState = new Map(); // chatId -> { view, anchor }  (anchor = 'YYYY-MM-DD')

function calToDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function calFmt(d) { return d.toISOString().slice(0, 10); }
function calAddDays(s, n) { const d = calToDate(s); d.setUTCDate(d.getUTCDate() + n); return calFmt(d); }
function calMonday(s) { const d = calToDate(s); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return calFmt(d); }
const CAL_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const CAL_DOW = ['Mo','Tu','We','Th','Fr','Sa','Su'];
const CAL_DOW_FULL = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

async function loadCalendarSessions(user) {
  const pool = db.getPool();
  let rows;
  if (user.role === 'instructor') {
    // Own sessions incl. completed (past); cancelled / reassigned-away orders drop out naturally.
    [rows] = await pool.execute(
      "SELECT o.id, o.client_name, o.sport_type, o.participants, o.sessions, o.media_dates, o.status, NULL AS instructor_name FROM orders o WHERE o.instructor_id = ? AND o.status IN ('taken','confirmed','completed')", [user.id]);
  } else {
    // Admin / super-admin: every non-cancelled session across all instructors.
    [rows] = await pool.execute(
      "SELECT o.id, o.client_name, o.sport_type, o.participants, o.sessions, o.media_dates, o.status, o.pinned, u.name AS instructor_name, u.telegram_username AS instructor_username FROM orders o LEFT JOIN users u ON u.id = o.instructor_id WHERE o.status IN ('in_group','taken','confirmed','completed')");
  }
  const out = [];
  for (const o of rows) {
    const mediaDates = parseJson(o.media_dates, []);
    for (const s of parseJson(o.sessions, [])) {
      if (s && s.date) {
        const who = user.role === 'instructor' ? o.client_name : ((o.instructor_name || '❗ no instructor') + (o.instructor_username ? ' @' + String(o.instructor_username).replace(/^@/, '') : ''));
        const addons = Array.isArray(s.addons) ? s.addons : [];
        const icons = [];
        if (addons.some(a => a.type === 'rental')) icons.push('🏄');
        if (addons.some(a => a.type === 'transferTo' || a.type === 'transferBack')) icons.push('🚕');
        if (addons.some(a => a.type === 'media') || (!addons.length && mediaDates.includes(s.date))) icons.push('📸');
        out.push({
          id: o.id,
          status: o.status,
          date: s.date, slot: s.timeWindow || s.slot || '',
          main: `${(user.role !== 'instructor' && o.pinned) ? '📌 ' : ''}#${o.id} ${sportShort(o.sport_type)} (${o.participants}p) - ${who}`,
          spot: s.spot || 'TBD',
          icons: icons.join(' ')
        });
      }
    }
  }
  out.sort((a, b) => (a.date + a.slot).localeCompare(b.date + b.slot));
  return out;
}

function calRender(anchor, sel, sessions, today) {
  const byDate = {};
  for (const s of sessions) (byDate[s.date] = byDate[s.date] || []).push(s);
  const [ay, amo] = anchor.split('-').map(Number);
  let txt = '';
  if (sel) {
    const d = calToDate(sel);
    const dow = CAL_DOW_FULL[(d.getUTCDay() + 6) % 7];
    const [yy, mm, dd] = sel.split('-');
    // Single compact header line: weekday+day on the left, month+year on the right.
    txt += `<b>${dow} ${dd}</b>${sel === today ? ' (today)' : ''}    —    <b>${CAL_MONTHS[amo - 1]} ${ay}</b>\n\n`;
    txt += `${'─'.repeat(19)}\n`;
    const list = byDate[sel] || [];
    let body = list.length
      ? list.map(s => `${statusDot(s.status)} ${s.main}\n${s.spot} <b>${s.slot}</b>${s.icons ? ' ' + s.icons : ''}`).join('\n\n')
      : '— free day —';
    // Keep the message a constant height so the calendar keyboard below never shifts.
    // Telegram strips trailing whitespace/newlines, so pad with a Braille-blank line (U+2800)
    // which it preserves — every day renders the same number of lines.
    const MIN_LINES = 9;
    const bodyLines = body.split('\n').length;
    if (bodyLines < MIN_LINES) body += '\n' + Array(MIN_LINES - bodyLines).fill('\u2800').join('\n');
    txt += body;
  } else {
    txt += `<b>${CAL_MONTHS[amo - 1]} ${ay}</b>`;
  }
  return txt;
}

function calKeyboard(anchor, sel, sessions, today) {
  const byDate = {}, byDateFull = {};
  for (const s of sessions) { byDate[s.date] = true; (byDateFull[s.date] = byDateFull[s.date] || []).push(s); }
  const [y, mo] = anchor.split('-').map(Number);
  const first = new Date(Date.UTC(y, mo - 1, 1));
  const daysIn = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const rows = [CAL_DOW.map(d => Markup.button.callback(d, 'cal_noop'))];
  let row = [];
  const lead = (first.getUTCDay() + 6) % 7;
  for (let i = 0; i < lead; i++) row.push(Markup.button.callback(' ', 'cal_noop'));
  for (let d = 1; d <= daysIn; d++) {
    const ds = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    let label = String(d);
    if (byDate[ds]) {
      const act = (byDateFull[ds] || []).some(x => ['in_group','taken','confirmed'].includes(x.status));
      label = label + (act ? '🟡' : (ds < today ? '˙' : '•'));
    }
    row.push(Markup.button.callback(label, 'cal_day_' + ds));
    if (row.length === 7) { rows.push(row); row = []; }
  }
  if (row.length) { while (row.length < 7) row.push(Markup.button.callback(' ', 'cal_noop')); rows.push(row); }
  // Prev / next buttons carry the month name so it's always clear where you are and where you'll go.
  const prevD = new Date(Date.UTC(y, mo - 2, 1)), nextD = new Date(Date.UTC(y, mo, 1));
  rows.push([
    Markup.button.callback('◀ ' + MONTHS_SHORT[prevD.getUTCMonth()], 'cal_prev'),
    Markup.button.callback('Today', 'cal_today'),
    Markup.button.callback(MONTHS_SHORT[nextD.getUTCMonth()] + ' ▶', 'cal_next')
  ]);
  return Markup.inlineKeyboard(rows);
}

async function renderCalendar(ctx, user, { fresh = false } = {}) {
  const today = time.nowBaliString().slice(0, 10);
  let st = calendarState.get(ctx.chat.id) || { anchor: today.slice(0, 7) + '-01', sel: today };
  if (fresh) st = { anchor: today.slice(0, 7) + '-01', sel: today };
  let loadingMsg = null;
  if (fresh) { try { loadingMsg = await trackReply(ctx, m(user.language, 'viewer_loading')); } catch (e) {} }
  const sessions = await loadCalendarSessions(user);
  const text = calRender(st.anchor, st.sel, sessions, today);
  const kb = calKeyboard(st.anchor, st.sel, sessions, today);
  if (loadingMsg) {
    try { await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined, text, { parse_mode: 'HTML', ...kb }); st.msgId = loadingMsg.message_id; }
    catch (e) { const sent = await trackReply(ctx, text, { parse_mode: 'HTML', ...kb }); st.msgId = sent.message_id; }
  } else {
    try { await ctx.editMessageText(text, { parse_mode: 'HTML', ...kb }); } catch (e) {}
  }
  calendarState.set(ctx.chat.id, st);
}

bot.hears('Calendar', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  await clearScreen(ctx.chat.id);
  trackUserMessage(ctx);
  await renderCalendar(ctx, user, { fresh: true });
});

// ----- Orders hub: like Team — tapping Orders opens a chooser; each view has NO tab strip -----
// Instructor's split menu: ✓ To confirm / 🟡 Current sessions / 📆 Calendar / 📋 All sessions are separate reply buttons.
bot.hears('✓ To confirm', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role !== 'instructor') return;
  await clearScreen(ctx.chat.id);
  trackUserMessage(ctx);
  await renderCurrentViewer(ctx, user, { fresh: true, mode: 'toconfirm' });
});
bot.hears('🟡 Current sessions', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role !== 'instructor') return;
  await clearScreen(ctx.chat.id);
  trackUserMessage(ctx);
  await renderCurrentViewer(ctx, user, { fresh: true, mode: 'current' });
});
bot.hears('📆 Calendar', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  await clearScreen(ctx.chat.id);
  trackUserMessage(ctx);
  await renderCalendar(ctx, user, { fresh: true });
});
bot.hears(/📋/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  await clearScreen(ctx.chat.id);
  trackUserMessage(ctx);
  // Instructors go straight to their All list (no hub); admins/super get the view chooser.
  if (user.role === 'instructor') { await renderAllOrdersList(ctx, user); return; }
  const rows = [[
    Markup.button.callback('🟡 Current', 'ordtab_cur'),
    Markup.button.callback('📆 Calendar', 'ordtab_cal'),
    Markup.button.callback('📋 All', 'ordtab_all')
  ]];
  await trackReply(ctx, user.language === 'ru' ? '<b>Заказы</b>\nВыберите вид.' : '<b>Orders</b>\nChoose a view.', { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) });
});
bot.action('ordtab_cal', async (ctx) => { const u = await requireUser(ctx); if (!u) return ctx.answerCbQuery(); await ctx.answerCbQuery(); try { await ctx.deleteMessage(); } catch (e) {} await renderCalendar(ctx, u, { fresh: true }); });
bot.action('ordtab_cur', async (ctx) => { const u = await requireUser(ctx); if (!u) return ctx.answerCbQuery(); await ctx.answerCbQuery(); try { await ctx.deleteMessage(); } catch (e) {} await renderCurrentViewer(ctx, u, { fresh: true, mode: 'current' }); });
bot.action('ordtab_all', async (ctx) => { const u = await requireUser(ctx); if (!u) return ctx.answerCbQuery(); await ctx.answerCbQuery(); try { await ctx.deleteMessage(); } catch (e) {} await renderAllOrdersList(ctx, u); });

// ----- Team hub: instructors (service providers) + admins (management) behind inline tabs -----
bot.hears(/👥/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) return;
  await clearScreen(ctx.chat.id);
  trackUserMessage(ctx);
  const rows = [[Markup.button.callback('🏄 Instructors', 'team_inst')]];
  if (user.role === 'super_admin') rows.push([Markup.button.callback('🛡 Admins', 'team_adm')]);
  if (user.role === 'super_admin') rows.push([Markup.button.callback('🌐 Languages', 'cat_langs')]);
  await trackReply(ctx, user.language === 'ru' ? '<b>Команда</b>\nПоставщики услуг и управление.' : '<b>Team</b>\nService providers & management.', { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) });
});
bot.action('team_inst', async (ctx) => { const u = await requireUser(ctx); if (!u || (u.role !== 'admin' && u.role !== 'super_admin')) return ctx.answerCbQuery(); await ctx.answerCbQuery(); await renderInstructors(ctx, u); });
bot.action('team_adm', async (ctx) => { const u = await requireUser(ctx); if (!u || u.role !== 'super_admin') return ctx.answerCbQuery(); await ctx.answerCbQuery(); await renderAdmins(ctx, u); });

bot.action('cal_noop', ctx => ctx.answerCbQuery());
bot.action(/cal_day_(\d{4}-\d{2}-\d{2})/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return ctx.answerCbQuery();
  const st = calendarState.get(ctx.chat.id);
  if (!st) return ctx.answerCbQuery();
  st.sel = ctx.match[1];
  calendarState.set(ctx.chat.id, st);
  await renderCalendar(ctx, user);
  await ctx.answerCbQuery();
});
bot.action(/cal_open_(\d+)/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return ctx.answerCbQuery();
  const orderId = Number(ctx.match[1]);
  // Open this order in the Current viewer; if it's not in the current set (e.g. completed), fall
  // back to the All-orders viewer. Posts a fresh viewer message positioned on that order.
  let st = currentViewer.get(ctx.chat.id) || { idx: 0, mode: 'current' };
  st.mode = 'current';
  let orders = await loadViewerOrders('current', user);
  let idx = orders.findIndex(o => o.id === orderId);
  if (idx < 0) { st.mode = 'all'; orders = await loadViewerOrders('all', user); idx = orders.findIndex(o => o.id === orderId); }
  if (idx < 0) return ctx.answerCbQuery('Order not in your list');
  st.idx = idx;
  currentViewer.set(ctx.chat.id, st);
  await renderCurrentViewer(ctx, user, { mode: st.mode });
  await ctx.answerCbQuery('➜ #' + orderId);
});

bot.action(/cal_(prev|next|today)/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return ctx.answerCbQuery();
  const st = calendarState.get(ctx.chat.id);
  if (!st) return ctx.answerCbQuery();
  const a = ctx.match[1];
  const today = time.nowBaliString().slice(0, 10);
  if (a === 'today') { st.anchor = today.slice(0, 7) + '-01'; st.sel = today; }
  else {
    const [y, m] = st.anchor.split('-').map(Number);
    const d = new Date(Date.UTC(y, a === 'next' ? m : m - 2, 1));
    st.anchor = calFmt(d);
    st.sel = null;
  }
  calendarState.set(ctx.chat.id, st);
  await renderCalendar(ctx, user);
  await ctx.answerCbQuery();
});

// Simple multi-step text conversation for adding an admin/instructor (username + name only
// — gear/level/language use inline button pickers above, not free text).
bot.on('text', async (ctx, next) => {
  const state = conversationState.get(ctx.from.id);
  if (!state) return next();
  const user = await requireUser(ctx);
  if (!user) return;
  const text = ctx.message.text.trim();
  trackUserMessage(ctx);

  if (state.step === 'settings_hours_val') {
    conversationState.delete(ctx.from.id);
    if (user.role !== 'super_admin') return;
    const [open, close] = text.trim().split(/\s+/).map(Number);
    const ru = user.language === 'ru';
    if (!Number.isFinite(open) || !Number.isFinite(close) || open < 0 || close > 23 || close <= open) {
      return trackReply(ctx, ru ? 'Отправьте два числа 0-23, напр. 8 16' : 'Send two numbers 0-23, e.g. 8 16');
    }
    await catalog.setWorkHours(open, close);
    await db.logAction(ctx.from.username, user.role, 'work_hours_set', null, { open, close });
    return trackReply(ctx, (ru ? '✓ Часы работы обновлены: ' : '✓ Working hours updated: ') + `${open}:00–${close}:00`);
  }

  if (state.step === 'addons_media_val') {
    conversationState.delete(ctx.from.id);
    if (user.role !== 'super_admin') return;
    const price = Number(text.trim());
    const ru = user.language === 'ru';
    if (!Number.isFinite(price) || price < 0) return trackReply(ctx, ru ? 'Отправьте одно число, напр. 200' : 'Send one number, e.g. 200');
    await catalog.setAddonMediaPrice(Math.round(price));
    await db.logAction(ctx.from.username, user.role, 'addon_media_price_set', null, { price });
    return trackReply(ctx, (ru ? '✓ Цена медиа-съёмки обновлена: $' : '✓ Media price updated: $') + Math.round(price));
  }

  if (state.step === 'addons_transfermarkup_val') {
    conversationState.delete(ctx.from.id);
    if (user.role !== 'super_admin') return;
    const pct = Number(text.trim());
    const ru = user.language === 'ru';
    if (!Number.isFinite(pct) || pct < 0 || pct > 200) return trackReply(ctx, ru ? 'Отправьте число 0-200, напр. 20' : 'Send a number 0-200, e.g. 20');
    await catalog.setTransferMarkupPct(pct);
    await db.logAction(ctx.from.username, user.role, 'transfer_markup_set', null, { pct });
    return trackReply(ctx, (ru ? '✓ Наценка на трансфер обновлена: ' : '✓ Transfer markup updated: ') + pct + '%');
  }

  if (state.step === 'addon_add_en') {
    state.labelEn = text; state.step = 'addon_add_price';
    return trackReply(ctx, user.language === 'ru' ? 'Цена ($), напр. 50' : 'Price ($), e.g. 50');
  }
  if (state.step === 'addon_add_price') {
    const price = Number(text.trim());
    if (!Number.isFinite(price) || price < 0) return trackReply(ctx, user.language === 'ru' ? 'Отправьте одно число' : 'Send one number');
    state.price = price; state.step = 'addon_add_disc';
    return trackReply(ctx, user.language === 'ru' ? 'Скидка % за доп. день/занятие (0, если нет), напр. 10' : '% off per extra day/session (0 if none), e.g. 10');
  }
  if (state.step === 'addon_add_disc') {
    const pct = Number(text.trim());
    conversationState.delete(ctx.from.id);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return trackReply(ctx, user.language === 'ru' ? 'Отправьте число 0-100' : 'Send a number 0-100');
    await catalog.addCustomAddon(state.labelEn, state.labelEn, state.price, pct);
    await db.logAction(ctx.from.username, user.role, 'custom_addon_add', null, { label: state.labelEn });
    return trackReply(ctx, (user.language === 'ru' ? '✓ Доп добавлен: ' : '✓ Add-on added: ') + state.labelEn);
  }
  if (state.step === 'addon_price_val') {
    conversationState.delete(ctx.from.id);
    if (user.role !== 'super_admin') return;
    const price = Number(text.trim());
    if (!Number.isFinite(price) || price < 0) return trackReply(ctx, user.language === 'ru' ? 'Отправьте одно число' : 'Send one number');
    await catalog.updateCustomAddon(state.id, { price: Math.round(price) });
    return trackReply(ctx, user.language === 'ru' ? '✓ Цена обновлена.' : '✓ Price updated.');
  }
  if (state.step === 'addon_disc_val') {
    conversationState.delete(ctx.from.id);
    if (user.role !== 'super_admin') return;
    const pct = Number(text.trim());
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return trackReply(ctx, user.language === 'ru' ? 'Отправьте число 0-100' : 'Send a number 0-100');
    await catalog.updateCustomAddon(state.id, { discount_pct: pct });
    return trackReply(ctx, user.language === 'ru' ? '✓ Скидка обновлена.' : '✓ Discount updated.');
  }

  if (state.step === 'settings_blockadd_val') {
    conversationState.delete(ctx.from.id);
    if (user.role !== 'super_admin') return;
    const ru = user.language === 'ru';
    const parts = text.trim().split(/\s+/);
    const [start, end] = parts;
    const note = parts.slice(2).join(' ');
    const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d);
    if (!isDate(start) || !isDate(end) || end < start) {
      return trackReply(ctx, ru ? 'Формат: ГГГГ-ММ-ДД ГГГГ-ММ-ДД [заметка]' : 'Format: YYYY-MM-DD YYYY-MM-DD [note]');
    }
    await catalog.addBlockedPeriod(start, end, note);
    await db.logAction(ctx.from.username, user.role, 'blocked_period_added', null, { start, end, note });
    return trackReply(ctx, (ru ? '✓ Период заблокирован: ' : '✓ Period blocked: ') + `${start} → ${end}`);
  }

  if (state.step === 'danger_deltest') {
    conversationState.delete(ctx.from.id);
    if (user.role !== 'super_admin') return;
    const ru = user.language === 'ru';
    if (text !== 'DELETE TEST') return trackReply(ctx, ru ? '✗ Отменено (ожидалось DELETE TEST).' : '✗ Cancelled (expected DELETE TEST).');
    const pool = db.getPool();
    const [[c]] = await pool.execute('SELECT COUNT(*) c FROM orders WHERE is_test = 1');
    await pool.execute('DELETE FROM orders WHERE is_test = 1');
    await db.logAction(ctx.from.username, user.role, 'danger_delete_test_orders', null, { deleted: c.c });
    return trackReply(ctx, ru ? `Тестовые заказы удалены (${c.c}).` : `Test orders deleted (${c.c}).`);
  }

  if (state.step === 'danger_clear' || state.step === 'danger_restart') {
    conversationState.delete(ctx.from.id);
    if (user.role !== 'super_admin') return;
    const ru = user.language === 'ru';
    if (state.step === 'danger_clear') {
      if (text !== 'CLEAR') return trackReply(ctx, ru ? '✗ Отменено (ожидалось CLEAR).' : '✗ Cancelled (expected CLEAR).');
      const pool = db.getPool();
      const [[c]] = await pool.execute('SELECT COUNT(*) c FROM orders');
      // DELETE (not TRUNCATE) on purpose — AUTO_INCREMENT is preserved, order numbering continues.
      await pool.execute('DELETE FROM orders');
      await db.logAction(ctx.from.username, user.role, 'danger_clear_orders', null, { deleted: c.c });
      return trackReply(ctx, ru
        ? `История заказов очищена (удалено: ${c.c}). Нумерация заказов продолжится.`
        : `Order history cleared (${c.c} deleted). Order numbering continues.`);
    }
    if (text !== 'RESTART') return trackReply(ctx, ru ? '✗ Отменено (ожидалось RESTART).' : '✗ Cancelled (expected RESTART).');
    await db.logAction(ctx.from.username, user.role, 'danger_restart', null, {});
    await trackReply(ctx, ru ? 'Перезапуск бота… (около 30 секунд)' : 'Restarting bot… (about 30 seconds)');
    setTimeout(() => process.exit(0), 800); // Railway auto-restarts the process
    return;
  }

  if (state.step === 'add_review') {
    conversationState.delete(ctx.from.id);
    if (user.role !== 'super_admin') return;
    const parts = text.split('|').map(x => x.trim());
    if (parts.length < 5) return trackReply(ctx, '✗ Need 5 fields: Name | sport | Spot | Rating(1-5) | Text');
    const [name, sportRaw, spot, ratingRaw, ...rest] = parts;
    const sport = String(sportRaw).toLowerCase();
    const rating = parseInt(ratingRaw, 10);
    const body = rest.join(' | ').trim();
    if (!['surf', 'kite', 'wing', 'sup'].includes(sport)) return trackReply(ctx, '✗ Sport must be surf / kite / wing / sup.');
    if (!(rating >= 1 && rating <= 5)) return trackReply(ctx, '✗ Rating must be 1–5.');
    if (!body) return trackReply(ctx, '✗ Review text is empty.');
    const pool = db.getPool();
    // Synthetic order_id in the manual-review band (800000+) so it never collides with a real booking.
    const [[mx]] = await pool.execute("SELECT COALESCE(MAX(order_id),800000) mx FROM reviews WHERE order_id >= 800000 AND order_id < 900000");
    const orderId = (Number(mx.mx) || 800000) + 1;
    await pool.execute(
      "INSERT INTO reviews (order_id, instructor_id, client_name, sport_type, spot, rating, text, status, created_at) VALUES (?,?,?,?,?,?,?, 'published', ?)",
      [orderId, null, name || 'Rider', sport, spot || null, rating, body, time.nowBaliString()]);
    await db.logAction(ctx.from.username, user.role, 'review_added_manual', orderId, { rating });
    return trackReply(ctx, `✓ Review added and published to the site (#${orderId}). Manage it under Reviews.`);
  }

  if (state.step === 'add_admin_name') {
    state.adminName = text.trim();
    state.step = 'add_admin_username';
    return trackReply(ctx, m(user.language, 'send_admin_username'));
  }

  if (state.step === 'add_admin_username') {
    const username = db.normalizeUsername(text);
    const pool = db.getPool();
    const existing = await db.getUserByUsername(username);
    if (existing) {
      await pool.execute('UPDATE users SET role = "admin", is_active = 1, name = ? WHERE telegram_username = ?', [state.adminName || username, username]);
    } else {
      await pool.execute('INSERT INTO users (telegram_username, role, name, is_active) VALUES (?, "admin", ?, 1)', [username, state.adminName || username]);
    }
    await db.logAction(ctx.from.username, user.role, 'add_admin', null, { username });
    conversationState.delete(ctx.from.id);
    await clearScreen(ctx.chat.id);
    return trackReply(ctx, `✓ ${username} ${m(user.language, 'added_as_admin')}`);
  }

  if (state.step === 'add_instructor_username') {
    state.username = db.normalizeUsername(text);
    state.step = 'add_instructor_name';
    return trackReply(ctx, m(user.language, 'ask_name'));
  }
  if (state.step === 'add_instructor_name') {
    state.name = text;
    state.step = 'add_instructor_gear';
    state.gear = [];
    return trackReply(ctx, m(user.language, 'ask_gear'), gearPickKeyboard(state.gear));
  }
  return next();
});

// ============================================================
// CRON — pool expiry, WhatsApp deadline, 2h reminders, follow-ups
// ============================================================

cron.schedule('* * * * *', async () => {
  if (!db.isReady()) return;
  const pool = db.getPool();

  // 1) Unclaimed for 3h in the group → refund path
  try {
    const [expired] = await pool.execute("SELECT * FROM orders WHERE status = 'in_group' AND pool_expires_at < ?", [time.nowBaliString()]);
    for (const order of expired) {
      await clearPoolDMs(order);
      await processDepositRefund(order); // always manual now — see refunds.js
      await pool.execute("UPDATE orders SET status = 'deposit_refund_pending' WHERE id = ?", [order.id]);
      if (order.group_message_id) { try { await bot.telegram.deleteMessage(INSTRUCTORS_GROUP_ID, order.group_message_id); } catch (e) {} }
      await db.logAction('system', 'system', 'pool_expired_refund_flagged', order.id, null);
      await notifyRole('super_admin',
        () => `Order #${order.id} unclaimed for 3h.\n${refundTaskMessage(order)}`,
        () => Markup.inlineKeyboard([[Markup.button.callback('✓ Mark as refunded', `cfm:admin_markrefunded_${order.id}`)]])
      );
      await notifyRole('admin', `Order #${order.id} unclaimed for 3h — moved to refund path.`);
    }
  } catch (e) { console.error('cron pool-expiry error:', e); }

  // 2) WhatsApp not clicked within 5 min → strike instructor, bounce back (or escalate)
  try {
    const [missed] = await pool.execute("SELECT * FROM orders WHERE status = 'taken' AND whatsapp_clicked = 0 AND whatsapp_deadline_at < ?", [time.nowBaliString()]);
    for (const order of missed) {
      const [[instructor]] = await pool.execute('SELECT * FROM users WHERE id = ?', [order.instructor_id]);
      if (instructor) {
        const newStrikes = instructor.rating_strikes - 1;
        const deactivate = newStrikes <= -3;
        await pool.execute('UPDATE users SET rating_strikes = ?, is_active = ? WHERE id = ?', [newStrikes, deactivate ? 0 : 1, instructor.id]);
        await db.logAction('system', 'system', 'strike_no_response', order.id, { instructorId: instructor.id, newStrikes });
        // Remove the order from the instructor's own chat immediately on a strike — it's no
        // longer theirs (bounced back to the group below), so it shouldn't linger where they
        // could still act on stale info.
        if (instructor.telegram_chat_id && order.instructor_message_id) {
          try { await bot.telegram.deleteMessage(instructor.telegram_chat_id, order.instructor_message_id); } catch (e) {}
        }
      }

      const bounceCount = (order.bounce_count || 0) + 1;
      if (bounceCount >= MAX_BOUNCES) {
        await pool.execute("UPDATE orders SET status = 'needs_admin_assignment', bounce_count = ? WHERE id = ?", [bounceCount, order.id]);
        const escalationMsg = `NEEDS MANUAL ASSIGNMENT — order #${order.id}`;
        await notifyRole('admin', escalationMsg);
        await notifyRole('super_admin', escalationMsg);
      } else {
        const sent = await bot.telegram.sendMessage(INSTRUCTORS_GROUP_ID, groupCardMessage(order), {
          parse_mode: 'HTML',
          protect_content: true,
          ...Markup.inlineKeyboard([[Markup.button.callback(TAKE_BTN_GROUP_LABEL, `take_${order.id}`)]])
        });
        await pool.execute(
          "UPDATE orders SET status = 'in_group', instructor_id = NULL, group_message_id = ?, pool_expires_at = ?, bounce_count = ? WHERE id = ?",
          [sent.message_id, time.nowBaliString(POOL_WINDOW_MIN), bounceCount, order.id]
        );
        await broadcastPoolDMs({ ...order, status: 'in_group' });
      }
    }
  } catch (e) { console.error('cron whatsapp-deadline error:', e); }

  // 3b) 24h reminder to the client before the first upcoming session (email only) — a full
  // day's notice, in addition to the 2h nudge below. Guarded by its own sent flag so it fires
  // once even if the booking was made <24h out.
  try {
    const [rows] = await pool.execute(
      `SELECT * FROM orders WHERE status IN ('confirmed','taken') AND reminder_24h_sent = 0`
    );
    for (const order of rows) {
      const sessions = parseJson(order.sessions, []);
      const first = sessions[0]; if (!first) continue;
      const sessionUtc = time.baliToUtcDate(first.date, first.timeWindow.split(' – ')[0].trim());
      const minsUntil = (sessionUtc.getTime() - Date.now()) / 60000;
      if (minsUntil <= 1440 && minsUntil > 0) {
        await email.reminder24hEmail(order, `${first.date} ${first.timeWindow}`);
        await pool.execute('UPDATE orders SET reminder_24h_sent = 1 WHERE id = ?', [order.id]);
      }
    }
  } catch (e) { console.error('cron 24h-reminder error:', e); }

  // 3) 2h reminder to instructor (email to client too) before the first upcoming session
  try {
    const [rows] = await pool.execute(
      `SELECT o.*, u.telegram_chat_id, u.language FROM orders o JOIN users u ON u.id = o.instructor_id
       WHERE o.status IN ('confirmed','taken') AND o.reminder_2h_sent = 0`
    );
    for (const order of rows) {
      const sessions = parseJson(order.sessions, []);
      const first = sessions[0]; if (!first) continue;
      const sessionUtc = time.baliToUtcDate(first.date, first.timeWindow.split(' – ')[0].trim());
      const minsUntil = (sessionUtc.getTime() - Date.now()) / 60000;
      if (minsUntil <= 120 && minsUntil > 0) {
        if (order.telegram_chat_id) {
          await bot.telegram.sendMessage(order.telegram_chat_id, `Reminder: order #${order.id} starts in ~2h (${first.date} ${first.timeWindow}).`, { parse_mode: 'HTML' }).catch(() => {});
        }
        await email.reminder2hEmail(order, `${first.date} ${first.timeWindow}`);
        await pool.execute('UPDATE orders SET reminder_2h_sent = 1 WHERE id = ?', [order.id]);
      }
    }
  } catch (e) { console.error('cron 2h-reminder error:', e); }

  // 4) Mark completed after the last session has passed, then send the follow-up email once.
  try {
    const [rows] = await pool.execute("SELECT * FROM orders WHERE status = 'confirmed'");
    for (const order of rows) {
      const sessions = parseJson(order.sessions, []);
      const last = sessions[sessions.length - 1]; if (!last) continue;
      const lastEnd = new Date(time.baliToUtcDate(last.date, last.timeWindow.split(' – ')[1]?.trim() || last.timeWindow).getTime());
      if (Date.now() > lastEnd.getTime()) {
        await pool.execute("UPDATE orders SET status = 'completed', completed_at = ?, pinned = 0 WHERE id = ?", [time.nowBaliString(), order.id]);
        if (!order.review_request_sent) {
          // One-time token → emailed star link to the public review page.
          const token = require('crypto').randomBytes(16).toString('hex');
          await pool.execute('UPDATE orders SET review_token = ?, review_request_sent = 1, followup_email_sent = 1 WHERE id = ?', [token, order.id]);
          await email.reviewRequestEmail(order, `${SITE_URL}/review.html?o=${order.id}&t=${token}`);
        }
      }
    }
  } catch (e) { console.error('cron completion error:', e); }

  // 5) Reschedule requests past their deadline (coach never confirmed) → decline, original stands.
  try {
    const [rows] = await pool.execute("SELECT * FROM orders WHERE reschedule_pending = 1 AND reschedule_deadline_at < ?", [time.nowBaliString()]);
    for (const order of rows) {
      await resolveReschedule(order, false, 'timeout');
      notifyRole('super_admin', () => `Reschedule request on #${order.id} timed out — original booking stands.`).catch(() => {});
    }
  } catch (e) { console.error('cron reschedule-timeout error:', e); }
});

// Daily PII scrub: anonymize client contact details on long-closed orders (terminal states,
// older than the retention window). The order row is kept for stats/finances, but the
// person's name/phone/email/notes are erased once we no longer need them. Idempotent — rows
// already scrubbed are skipped by the `client_email <> '[erased]'` guard.
const PII_RETENTION_DAYS = 180;
cron.schedule('0 3 * * *', async () => {
  if (!db.isReady()) return;
  const pool = db.getPool();
  try {
    const cutoff = time.nowBaliString(-PII_RETENTION_DAYS * 24 * 60);
    const [r] = await pool.execute(
      `UPDATE orders SET client_name='[erased]', client_phone='[erased]', client_email='[erased]', additional_info=NULL, age=NULL
       WHERE status IN ('completed','cancelled','deposit_refunded') AND created_at < ? AND client_email <> '[erased]'`,
      [cutoff]
    );
    if (r.affectedRows) { await db.logAction('system', 'system', 'pii_scrub', null, { count: r.affectedRows }); console.log(`PII scrub: ${r.affectedRows} order(s)`); }
  } catch (e) { console.error('cron pii-scrub error:', e); }
});

// ============================================================
// HTTP: booking intake webhook + WhatsApp-click redirect
// ============================================================

// ---- Reviews: collection notify + super_admin moderation ----
async function notifyReviewToAdmins(order, rating, text, status) {
  const pool = db.getPool();
  const stars = '★'.repeat(rating) + '☆'.repeat(5 - rating);
  const body = `<b>🟠 New review — needs approval</b>\n#${order.id} · ${sportShort(order.sport_type)}\n${stars} (${rating}/5)\n${text ? '“' + text.replace(/</g, '&lt;') + '”' : '(no text)'}`;
  const kb = Markup.inlineKeyboard([[
    Markup.button.callback('✓ Show on site', `review_pub_${order.id}`),
    Markup.button.callback('🗑 Delete', `review_del_${order.id}`)
  ]]);
  const [admins] = await pool.execute("SELECT telegram_chat_id FROM users WHERE role = 'super_admin' AND telegram_chat_id IS NOT NULL");
  for (const a of admins) pushAlert(a.telegram_chat_id, body, kb);
}
bot.action(/review_(pub|del)_(\d+)/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role !== 'super_admin') return ctx.answerCbQuery();
  const pool = db.getPool();
  if (ctx.match[1] === 'del') {
    await pool.execute('DELETE FROM reviews WHERE order_id = ?', [ctx.match[2]]);
    await db.logAction(ctx.from.username, user.role, 'review_deleted', ctx.match[2], null);
    await ctx.answerCbQuery('🗑 Deleted');
  } else {
    await pool.execute("UPDATE reviews SET status = 'published' WHERE order_id = ?", [ctx.match[2]]);
    await db.logAction(ctx.from.username, user.role, 'review_published', ctx.match[2], null);
    await ctx.answerCbQuery('✓ Shown on site');
  }
  try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (e) {}
});

// ---- Reviews moderation: New/All submenu + one-card viewer (admins view, super_admin acts) ----
const reviewViewer = new Map(); // chatId -> { idx, rows, mode, isSuper }
async function loadReviews(mode) {
  const pool = db.getPool();
  let where = '', params = [];
  if (mode === 'new') where = "WHERE r.status = 'pending'";
  else if (mode && mode.indexOf('coach:') === 0) { where = 'WHERE r.instructor_id = ?'; params = [parseInt(mode.slice(6), 10) || 0]; }
  const [rows] = await pool.execute(
    `SELECT r.*, u.name AS coach_name, u.telegram_username AS coach_username FROM reviews r LEFT JOIN users u ON u.id = r.instructor_id ${where} ORDER BY (r.status='pending') DESC, r.created_at DESC`, params);
  return rows;
}
function reviewCoachName(r) { return r.coach_name || (r.coach_username ? '@' + String(r.coach_username).replace(/^@/, '') : (r.instructor_id ? 'coach #' + r.instructor_id : '— unassigned')); }
function reviewCardText(r, idx, total) {
  const stars = '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating);
  const st = r.status === 'published' ? '🟢 shown on site' : '🟠 awaiting review';
  return `<b>Review ${idx + 1}/${total}</b>  ${st}\n` +
    `\n────────────────\n` +
    `${stars}  (${r.rating}/5)\n` +
    `#${r.order_id} · ${sportShort(r.sport_type)}${r.spot ? ' · ' + r.spot : ''}\n` +
    `🏄 ${reviewCoachName(r)}\n` +
    `👤 ${r.client_name || 'Rider'}\n` +
    `\n${r.text ? '“' + String(r.text).replace(/</g, '&lt;') + '”' : '(no text)'}`;
}
function reviewCardKb(r, idx, total, isSuper) {
  const rows = [];
  if (isSuper) rows.push([
    Markup.button.callback(r.status === 'published' ? '✓ Shown on site — tap to hide' : 'Show on site', 'rev_pub'),
    Markup.button.callback('🗑 Delete', 'rev_del')
  ]);
  const nav = [];
  if (idx > 0) nav.push(Markup.button.callback('◀', 'rev_prev'));
  nav.push(Markup.button.callback(`${idx + 1}/${total}`, 'rev_noop'));
  if (idx < total - 1) nav.push(Markup.button.callback('▶', 'rev_next'));
  rows.push(nav);
  return Markup.inlineKeyboard(rows);
}
async function renderReviewViewer(ctx, { fresh, mode } = {}) {
  const chatId = ctx.chat.id;
  const user = await requireUser(ctx);
  let st = reviewViewer.get(chatId) || { idx: 0, mode: 'new' };
  if (mode) st.mode = mode;
  st.isSuper = !!(user && user.role === 'super_admin');
  st.rows = await loadReviews(st.mode);
  if (fresh) st.idx = 0;
  if (st.idx >= st.rows.length) st.idx = Math.max(0, st.rows.length - 1);
  reviewViewer.set(chatId, st);
  if (!st.rows.length) { await trackReply(ctx, st.mode === 'new' ? 'No new reviews — all moderated.' : 'No reviews yet.'); return; }
  const r = st.rows[st.idx];
  await trackReply(ctx, reviewCardText(r, st.idx, st.rows.length), { parse_mode: 'HTML', ...reviewCardKb(r, st.idx, st.rows.length, st.isSuper) });
}
async function editReviewViewer(ctx) {
  const st = reviewViewer.get(ctx.chat.id);
  if (!st || !st.rows || !st.rows.length) { try { await ctx.editMessageText(st && st.mode === 'new' ? 'No new reviews — all moderated.' : 'No reviews yet.'); } catch (e) {} return; }
  const r = st.rows[st.idx];
  try { await ctx.editMessageText(reviewCardText(r, st.idx, st.rows.length), { parse_mode: 'HTML', ...reviewCardKb(r, st.idx, st.rows.length, st.isSuper) }); } catch (e) {}
}
function reviewsAllowed(u) { return u && (u.role === 'admin' || u.role === 'super_admin'); }
bot.hears('⭐ Reviews', async (ctx) => {
  const user = await requireUser(ctx);
  if (!reviewsAllowed(user)) return;
  await clearScreen(ctx.chat.id);
  trackUserMessage(ctx);
  await trackReply(ctx, '<b>Reviews</b>\nChoose a view.', { parse_mode: 'HTML', ...Markup.inlineKeyboard([
    [ Markup.button.callback('🆕 New', 'revtab_new'),
      Markup.button.callback('📋 All', 'revtab_all'),
      Markup.button.callback('👤 By coach', 'revtab_coach') ],
    ...(user.role === 'super_admin' ? [[ Markup.button.callback('+ Add review', 'rev_add') ]] : [])
  ]) });
});
bot.hears('❓ Help', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  await clearScreen(ctx.chat.id);
  trackUserMessage(ctx);
  let text;
  if (user.role === 'instructor') {
    text = `<b>Help — Instructor</b>\n\n` +
      `<b>Getting a booking</b>\n` +
      `1. New order lands in ✓ To confirm (also DM'd + posted to the group as backup).\n` +
      `2. Tap Take if you match — first tap wins, it vanishes for everyone else instantly.\n` +
      `3. Button becomes WhatsApp with a 5-minute countdown.\n` +
      `4. Tap it and confirm with the client on WhatsApp within 5 minutes.\n` +
      `5. Miss the 5 minutes → order returns to the pool and you lose 1 strike (3 strikes = blocked).\n\n` +
      `<b>Daily use</b>\n` +
      `📆 Calendar — month view, colour dot = something active that day.\n` +
      `🟡 Current sessions — your taken/confirmed sessions, by date.\n` +
      `📋 All sessions — full history incl. completed/cancelled.\n` +
      `💰 Finances — Week / Month / All, your earnings only.\n\n` +
      `<b>Rules</b>\n` +
      `Only take orders matching your gear, level, language and free time. Never confirm on WhatsApp before checking you're actually free. 3 strikes in a rolling window = blocked until an admin resets you.`;
  } else {
    text = `<b>Help — ${user.role === 'super_admin' ? 'Super-admin' : 'Admin'}</b>\n\n` +
      `<b>Reviewing a new order</b>\n` +
      `New order lands as a card (pending review) → check it → Send to group fires the pool DM to every eligible instructor + posts to the group as backup. Unclaimed after 3h → auto refund. You can also Assign directly to one instructor.\n\n` +
      `<b>Refunds & cancellations</b>\n` +
      `Client self-cancels ≥24h before session → auto full refund. <24h → no refund (disclosed at booking). You can manually cancel + refund any order. Reschedule needs the instructor's approval — no response → times out, original booking stands.\n\n` +
      `<b>Team</b>\n` +
      `+ Add instructor needs their @telegram_username + name, then gear/levels/languages picked from buttons (never free-typed). They must /start the bot themselves before receiving orders. Deactivate instead of delete to keep history.\n\n` +
      `<b>Statistics colours</b>\n` +
      `🟡 = something active in that status right now, ⚪ = nothing active. 🟢 completed / ⚪ cancelled / ⚫ refunded never change colour.` +
      (user.role === 'super_admin' ?
        `\n\n<b>Catalog</b>\n🌊 Disciplines → a service → edit price/level, extra-rider %, multi-day discount, duration, max group, Show/Hide, add-ons ON/OFF + their per-day discount. Media price & transfer markup are global — set once in 🎒 Add-ons. Inside a service: Spots → add/rename/delete. Edits go live on the site immediately.\n\n` +
        `<b>Reviews</b>\nNew reviews are pending — invisible on site until you tap Show on site. Hide/Delete pulls it instantly. + Add review seeds one manually, published right away.\n\n` +
        `<b>Settings / Danger zone</b>\nSandbox payments switches ALL processing to test keys — turn off before real money. Delete test orders only wipes is_test orders (typed confirmation, real orders untouched). Blocked periods stop new bookings for a date range (existing bookings inside are left alone). Working hours changes the daily coaching window. Clear order history / Restart bot — use only when you know why.`
      : '');
  }
  return trackReply(ctx, text, { parse_mode: 'HTML' });
});
bot.action('rev_add', async (ctx) => {
  conversationState.set(ctx.from.id, { step: 'add_review' });
  await ctx.answerCbQuery();
  await trackReply(ctx, '<b>Add a review</b>\nSend it on one line, fields separated by <code>|</code>:\n\n<code>Name | sport | Spot | Rating(1-5) | Review text</code>\n\nExample:\n<code>Marta K. | surf | Batu Bolong | 5 | Amazing first session, caught my first wave!</code>\n\nSport = surf / kite / wing / sup. It publishes to the site immediately.', { parse_mode: 'HTML' });
});

bot.action('revtab_new', async (ctx) => { const u = await requireUser(ctx); if (!reviewsAllowed(u)) return ctx.answerCbQuery(); await ctx.answerCbQuery(); try { await ctx.deleteMessage(); } catch (e) {} await renderReviewViewer(ctx, { fresh: true, mode: 'new' }); });
bot.action('revtab_all', async (ctx) => { const u = await requireUser(ctx); if (!reviewsAllowed(u)) return ctx.answerCbQuery(); await ctx.answerCbQuery(); try { await ctx.deleteMessage(); } catch (e) {} await renderReviewViewer(ctx, { fresh: true, mode: 'all' }); });
bot.action('revtab_coach', async (ctx) => {
  const u = await requireUser(ctx);
  if (!reviewsAllowed(u)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  const [rows] = await db.getPool().execute("SELECT r.instructor_id, u.name, u.telegram_username, COUNT(*) c FROM reviews r LEFT JOIN users u ON u.id = r.instructor_id GROUP BY r.instructor_id, u.name, u.telegram_username ORDER BY c DESC");
  if (!rows.length) { try { await ctx.editMessageText('No reviews yet.'); } catch (e) {} return; }
  const btns = rows.map(r => [Markup.button.callback(`${r.name || (r.telegram_username ? '@' + String(r.telegram_username).replace(/^@/, '') : '— unassigned')} (${r.c})`, 'revco_' + (r.instructor_id || 0))]);
  try { await ctx.editMessageText('<b>Reviews by coach</b>\nPick a coach.', { parse_mode: 'HTML', ...Markup.inlineKeyboard(btns) }); } catch (e) {}
});
bot.action(/revco_(\d+)/, async (ctx) => { const u = await requireUser(ctx); if (!reviewsAllowed(u)) return ctx.answerCbQuery(); await ctx.answerCbQuery(); try { await ctx.deleteMessage(); } catch (e) {} await renderReviewViewer(ctx, { fresh: true, mode: 'coach:' + ctx.match[1] }); });
bot.action('rev_noop', ctx => ctx.answerCbQuery());
bot.action('rev_prev', async (ctx) => { const u = await requireUser(ctx); if (!reviewsAllowed(u)) return ctx.answerCbQuery(); const st = reviewViewer.get(ctx.chat.id); if (st) st.idx = Math.max(0, st.idx - 1); await ctx.answerCbQuery(); await editReviewViewer(ctx); });
bot.action('rev_next', async (ctx) => { const u = await requireUser(ctx); if (!reviewsAllowed(u)) return ctx.answerCbQuery(); const st = reviewViewer.get(ctx.chat.id); if (st && st.rows) st.idx = Math.min(st.rows.length - 1, st.idx + 1); await ctx.answerCbQuery(); await editReviewViewer(ctx); });
bot.action('rev_pub', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role !== 'super_admin') return ctx.answerCbQuery('Super-admin only');
  const st = reviewViewer.get(ctx.chat.id);
  if (!st || !st.rows || !st.rows.length) return ctx.answerCbQuery();
  const r = st.rows[st.idx];
  const goingLive = r.status !== 'published';
  await db.getPool().execute("UPDATE reviews SET status = ? WHERE id = ?", [goingLive ? 'published' : 'pending', r.id]);
  r.status = goingLive ? 'published' : 'pending';
  await db.logAction(ctx.from.username, user.role, goingLive ? 'review_published' : 'review_unpublished', r.order_id, null);
  await ctx.answerCbQuery(goingLive ? '✓ Shown on site' : 'Hidden from site');
  if (st.mode === 'new' && !goingLive) { /* stays in the 'new' list, now pending again */ }
  else if (st.mode === 'new' && goingLive) { st.rows.splice(st.idx, 1); if (st.idx >= st.rows.length) st.idx = Math.max(0, st.rows.length - 1); }
  await editReviewViewer(ctx);
});
bot.action('rev_del', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role !== 'super_admin') return ctx.answerCbQuery('Super-admin only');
  const st = reviewViewer.get(ctx.chat.id);
  if (!st || !st.rows || !st.rows.length) return ctx.answerCbQuery();
  const r = st.rows[st.idx];
  await db.getPool().execute('DELETE FROM reviews WHERE id = ?', [r.id]);
  await db.logAction(ctx.from.username, user.role, 'review_deleted', r.order_id, null);
  await ctx.answerCbQuery('🗑 Deleted');
  st.rows.splice(st.idx, 1);
  if (st.idx >= st.rows.length) st.idx = Math.max(0, st.rows.length - 1);
  await editReviewViewer(ctx);
});

// ============================================================
// HTTP API (website ⇄ bot)
// ============================================================

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' })); // cap intake body size — a booking payload is a few KB; anything larger is abuse/accident

// ---- In-memory IP rate limiter (token bucket). Second line of defence behind Cloudflare;
// survives a process lifetime, resets on redeploy. Blocks brute intake spam / fake-order floods.
const rlBuckets = new Map();
function rateLimit({ capacity = 12, refillPerSec = 0.2 } = {}) {
  return (req, res, next) => {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
    const now = Date.now();
    let b = rlBuckets.get(ip);
    if (!b) { b = { tokens: capacity, ts: now }; rlBuckets.set(ip, b); }
    b.tokens = Math.min(capacity, b.tokens + ((now - b.ts) / 1000) * refillPerSec);
    b.ts = now;
    if (b.tokens < 1) return res.status(429).json({ error: 'rate_limited' });
    b.tokens -= 1;
    next();
  };
}
// Periodically evict idle buckets so the map can't grow unbounded.
setInterval(() => { const now = Date.now(); for (const [ip, b] of rlBuckets) if (now - b.ts > 3600000) rlBuckets.delete(ip); }, 600000).unref?.();

// Public read-only catalogue for the website (disciplines / prices / spots). CORS is already
// enabled globally. No secret required — it exposes only public pricing, never orders or PII.
app.get('/catalog', rateLimit({ capacity: 60, refillPerSec: 1 }), async (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=60');
    res.json(await catalog.toServicesData());
  } catch (e) {
    console.error('catalog serve error:', e.message);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Client review submission from the emailed review page. Validated by order id + one-time token.
app.post('/review', rateLimit({ capacity: 20, refillPerSec: 0.3 }), async (req, res) => {
  try {
    const b = req.body || {};
    const orderId = parseInt(b.orderId ?? b.o, 10);
    const token = String(b.token ?? b.t ?? '');
    const rating = parseInt(b.rating, 10);
    const text = String(b.text || '').slice(0, 1000).trim();
    if (!orderId || !token || !(rating >= 1 && rating <= 5)) return res.status(400).json({ error: 'bad_params' });
    const pool = db.getPool();
    const [[order]] = await pool.execute('SELECT * FROM orders WHERE id = ? AND review_token = ? LIMIT 1', [orderId, token]);
    if (!order) return res.status(404).json({ error: 'not_found' });
    if (order.review_submitted) return res.status(409).json({ error: 'already_submitted' });
    const sessions = parseJson(order.sessions, []);
    const spot = (sessions[0] || {}).spot || null;
    const status = 'pending'; // every review is moderated before it can appear on the site
    const name = (order.client_name && order.client_name !== '[erased]') ? order.client_name : 'Rider';
    await pool.execute(
      "INSERT INTO reviews (order_id, instructor_id, client_name, sport_type, spot, rating, text, status, created_at) VALUES (?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE rating=VALUES(rating), text=VALUES(text), status=VALUES(status)",
      [orderId, order.instructor_id || null, name, order.sport_type, spot, rating, text, status, time.nowBaliString()]);
    await pool.execute('UPDATE orders SET review_submitted = 1 WHERE id = ?', [orderId]);
    notifyReviewToAdmins(order, rating, text, status).catch(() => {});
    res.json({ ok: true });
  } catch (e) { console.error('review submit error:', e.message); res.status(500).json({ error: 'internal_error' }); }
});

// Public published reviews for the website testimonials (best-rated first, newest tiebreak).
app.get('/reviews', rateLimit({ capacity: 60, refillPerSec: 1 }), async (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=120');
    const pool = db.getPool();
    const [rows] = await pool.execute(
      "SELECT client_name, sport_type, spot, rating, text FROM reviews WHERE status = 'published' AND text <> '' ORDER BY rating DESC, created_at DESC LIMIT 12");
    res.json({ reviews: rows.map(r => ({
      name: r.client_name || 'Rider',
      init: (r.client_name || 'R').trim().charAt(0).toUpperCase(),
      from: r.spot || (r.sport_type ? r.sport_type.charAt(0).toUpperCase() + r.sport_type.slice(1) : ''),
      rating: r.rating,
      text: r.text
    })) });
  } catch (e) { console.error('reviews serve error:', e.message); res.status(500).json({ error: 'internal_error' }); }
});

// ============================================================
// Client self-service: cancel / reschedule (manage.html)
// ============================================================
// Bali wall-clock ms of a session's start.
function sessionStartMs(s) {
  const start = (s.timeWindow || s.slot || '').split(/[–-]/)[0].trim() || '08:00';
  return time.baliToUtcDate(s.date, start).getTime();
}
function firstSessionStartMs(order) {
  const ss = parseJson(order.sessions, []);
  if (!ss.length) return Infinity;
  return Math.min(...ss.map(sessionStartMs));
}
function hoursUntil(ms) { return (ms - Date.now()) / 3600000; }
function fmtWhen(s) {
  const m = String(s.date || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  const d = m ? `${m[3]} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m[2]) - 1]}` : s.date;
  return `${d} · ${s.timeWindow || s.slot || ''}`.trim();
}
// What the client is allowed to do right now, per policy.
function bookingPolicy(order) {
  const active = ['pending_review', 'in_group', 'taken', 'confirmed'].includes(order.status);
  const hrs = hoursUntil(firstSessionStartMs(order));
  return {
    active,
    hoursUntil: hrs,
    canCancel: active && hrs > 0,
    cancelFreeRefund: hrs >= FREE_CANCEL_H,
    canReschedule: active && hrs > 0 && (order.reschedule_count || 0) < RESCHEDULE_MAX && !order.reschedule_pending,
    rescheduleNeedsCoachConfirm: hrs < FREE_CANCEL_H,
    reschedulePending: !!order.reschedule_pending
  };
}
async function loadOrderByToken(id, token) {
  const [[order]] = await db.getPool().execute('SELECT * FROM orders WHERE id = ? AND manage_token = ? LIMIT 1', [parseInt(id, 10) || 0, String(token || '')]);
  return order || null;
}
function publicOrderView(order) {
  const p = bookingPolicy(order);
  return {
    id: order.id,
    status: order.status,
    sport: order.sport_type,
    sessions: parseJson(order.sessions, []).map(s => ({ date: s.date, window: s.timeWindow || s.slot || '', spot: s.spot || '' })),
    total: order.total_price,
    deposit: order.deposit_price,
    policy: {
      canCancel: p.canCancel,
      cancelFreeRefund: p.cancelFreeRefund,
      freeCancelHours: FREE_CANCEL_H,
      canReschedule: p.canReschedule,
      rescheduleNeedsCoachConfirm: p.rescheduleNeedsCoachConfirm,
      reschedulePending: p.reschedulePending,
      maxReschedules: RESCHEDULE_MAX,
      used: order.reschedule_count || 0
    }
  };
}

app.get('/booking/:id', rateLimit({ capacity: 60, refillPerSec: 1 }), async (req, res) => {
  try {
    const order = await loadOrderByToken(req.params.id, req.query.t);
    if (!order) return res.status(404).json({ error: 'not_found' });
    res.set('Cache-Control', 'no-store');
    res.json(publicOrderView(order));
  } catch (e) { console.error('booking view error:', e.message); res.status(500).json({ error: 'internal_error' }); }
});

app.post('/booking/:id/cancel', rateLimit({ capacity: 20, refillPerSec: 0.2 }), async (req, res) => {
  try {
    const order = await loadOrderByToken(req.params.id, (req.body || {}).t || req.query.t);
    if (!order) return res.status(404).json({ error: 'not_found' });
    const p = bookingPolicy(order);
    if (!p.canCancel) return res.status(409).json({ error: 'not_cancellable' });
    const pool = db.getPool();
    const reason = String((req.body || {}).reason || '').slice(0, 200);
    // Free-refund window → refund path (manual, via existing flow); otherwise plain cancel, deposit forfeited.
    const newStatus = p.cancelFreeRefund ? 'deposit_refund_pending' : 'cancelled';
    await pool.execute(
      "UPDATE orders SET status = ?, cancelled_at = ?, cancel_reason = ?, cancelled_by = 'client', instructor_id = instructor_id, pinned = 0 WHERE id = ? AND status = ?",
      [newStatus, time.nowBaliString(), reason, order.id, order.status]);
    await db.logAction('client', 'client', 'client_cancel', order.id, { refund: p.cancelFreeRefund, reason });
    // Free the group message if it's still hanging in the pool.
    if (order.group_message_id && order.status === 'in_group') { try { await bot.telegram.deleteMessage(INSTRUCTORS_GROUP_ID, order.group_message_id); } catch (e) {} }
    const refundNote = p.cancelFreeRefund
      ? 'Your deposit will be refunded to your original payment method — allow a few business days.'
      : `As the session was within ${FREE_CANCEL_H} hours, the deposit is non-refundable per our terms.`;
    email.cancellationEmail(order, refundNote).catch(() => {});
    notifyRole('super_admin', () => `Client cancelled order #${order.id} (${p.cancelFreeRefund ? 'refund due' : 'no refund'}).${reason ? '\n“' + reason.replace(/</g, '&lt;') + '”' : ''}`).catch(() => {});
    if (order.instructor_id) { (async () => { const [[i]] = await pool.execute('SELECT telegram_chat_id FROM users WHERE id = ?', [order.instructor_id]); if (i && i.telegram_chat_id) { if (order.instructor_message_id) { try { await bot.telegram.deleteMessage(i.telegram_chat_id, order.instructor_message_id); } catch (e) {} } bot.telegram.sendMessage(i.telegram_chat_id, `Order #${order.id} was cancelled by the client.`).catch(() => {}); } })(); }
    await refreshAllStatusPanels().catch(() => {});
    res.json({ ok: true, refund: p.cancelFreeRefund });
  } catch (e) { console.error('cancel error:', e.message); res.status(500).json({ error: 'internal_error' }); }
});

// Body: { t, sessions:[{date,timeWindow|slot,spot}] } — same session shape the form submits.
app.post('/booking/:id/reschedule', rateLimit({ capacity: 20, refillPerSec: 0.2 }), async (req, res) => {
  try {
    const b = req.body || {};
    const order = await loadOrderByToken(req.params.id, b.t || req.query.t);
    if (!order) return res.status(404).json({ error: 'not_found' });
    const p = bookingPolicy(order);
    if (!p.canReschedule) return res.status(409).json({ error: 'not_reschedulable' });
    const newSessions = Array.isArray(b.sessions) ? b.sessions : [];
    if (!newSessions.length) return res.status(400).json({ error: 'no_sessions' });
    // New date must itself respect the minimum lead time.
    const newStart = Math.min(...newSessions.map(sessionStartMs));
    if (hoursUntil(newStart) < 0) return res.status(400).json({ error: 'past_date' });
    const pool = db.getPool();
    const origSessions = order.original_sessions ? order.original_sessions : order.sessions;

    // Can the CURRENT coach take the new slot? If so and it's confirmed, move directly.
    let sameCoachFree = false;
    if (order.instructor_id) {
      const [act] = await pool.execute("SELECT sessions FROM orders WHERE instructor_id = ? AND status IN ('taken','confirmed') AND id <> ?", [order.instructor_id, order.id]);
      const busy = []; for (const r of act) busy.push(...parseJson(r.sessions, []));
      sameCoachFree = newSessions.every(s => !scheduleConflict([s], busy));
    }

    if (sameCoachFree && ['taken', 'confirmed'].includes(order.status)) {
      await pool.execute(
        "UPDATE orders SET sessions = ?, original_sessions = COALESCE(original_sessions, ?), reschedule_count = reschedule_count + 1, reminder_24h_sent = 0, reminder_2h_sent = 0 WHERE id = ?",
        [JSON.stringify(newSessions), origSessions, order.id]);
      await db.logAction('client', 'client', 'client_reschedule_direct', order.id, null);
      email.rescheduleConfirmedEmail({ ...order, sessions: JSON.stringify(newSessions) }, fmtWhen(newSessions[0])).catch(() => {});
      (async () => { const [[i]] = await pool.execute('SELECT telegram_chat_id FROM users WHERE id = ?', [order.instructor_id]); if (i && i.telegram_chat_id) bot.telegram.sendMessage(i.telegram_chat_id, `🔁 Order #${order.id} moved to ${fmtWhen(newSessions[0])} (client reschedule).`).catch(() => {}); })();
      await refreshAllStatusPanels().catch(() => {});
      return res.json({ ok: true, mode: 'confirmed' });
    }

    // Otherwise it's a REQUEST: original stays booked, wait for coach / pool. Deadline = min(now+COACH_CONFIRM_H, origStart - MIN_LEAD_H).
    const origStart = firstSessionStartMs(order);
    const deadlineMs = Math.min(Date.now() + COACH_CONFIRM_H * 3600000, origStart - MIN_LEAD_H * 3600000);
    const deadlineStr = time.nowBaliString(Math.round((deadlineMs - Date.now()) / 60000));
    await pool.execute(
      "UPDATE orders SET reschedule_pending = 1, reschedule_new_sessions = ?, reschedule_deadline_at = ?, original_sessions = COALESCE(original_sessions, ?) WHERE id = ?",
      [JSON.stringify(newSessions), deadlineStr, origSessions, order.id]);
    await db.logAction('client', 'client', 'client_reschedule_request', order.id, { newStart: deadlineStr });
    email.rescheduleRequestedEmail(order, fmtWhen(newSessions[0])).catch(() => {});
    // Ask the current coach first (if any) with inline Approve/Decline; else straight to super_admin.
    const kb = Markup.inlineKeyboard([[
      Markup.button.callback('✓ Can do', `resq_ok_${order.id}`),
      Markup.button.callback('✗ Busy', `resq_no_${order.id}`)
    ]]);
    const msg = `<b>Reschedule request</b> — order #${order.id}\nFrom: ${fmtWhen(parseJson(order.sessions, [])[0] || {})}\nTo: <b>${fmtWhen(newSessions[0])}</b>\nRespond before ${deadlineStr.slice(0, 16)} Bali.`;
    if (order.instructor_id) { (async () => { const [[i]] = await pool.execute('SELECT telegram_chat_id FROM users WHERE id = ?', [order.instructor_id]); if (i && i.telegram_chat_id) pushAlert(i.telegram_chat_id, msg, { parse_mode: 'HTML', ...kb }); })(); }
    notifyRole('super_admin', () => msg, () => kb).catch(() => {});
    res.json({ ok: true, mode: 'pending' });
  } catch (e) { console.error('reschedule error:', e.message); res.status(500).json({ error: 'internal_error' }); }
});

// Coach/super_admin response to a reschedule request.
async function resolveReschedule(order, approve, actor) {
  const pool = db.getPool();
  const [[fresh]] = await pool.execute('SELECT * FROM orders WHERE id = ? LIMIT 1', [order.id]);
  if (!fresh || !fresh.reschedule_pending) return false; // already resolved (race/idempotent)
  const newSessions = parseJson(fresh.reschedule_new_sessions, []);
  if (approve && newSessions.length) {
    await pool.execute(
      "UPDATE orders SET sessions = ?, reschedule_pending = 0, reschedule_new_sessions = NULL, reschedule_deadline_at = NULL, reschedule_count = reschedule_count + 1, reminder_24h_sent = 0, reminder_2h_sent = 0 WHERE id = ?",
      [JSON.stringify(newSessions), fresh.id]);
    await db.logAction(actor, 'system', 'reschedule_approved', fresh.id, null);
    email.rescheduleConfirmedEmail({ ...fresh, sessions: JSON.stringify(newSessions) }, fmtWhen(newSessions[0])).catch(() => {});
  } else {
    await pool.execute("UPDATE orders SET reschedule_pending = 0, reschedule_new_sessions = NULL, reschedule_deadline_at = NULL WHERE id = ?", [fresh.id]);
    await db.logAction(actor, 'system', 'reschedule_declined', fresh.id, null);
    email.rescheduleFailedEmail(fresh, fmtWhen(parseJson(fresh.sessions, [])[0] || {})).catch(() => {});
  }
  await refreshAllStatusPanels().catch(() => {});
  return true;
}
bot.action(/resq_(ok|no)_(\d+)/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || !['instructor', 'admin', 'super_admin'].includes(user.role)) return ctx.answerCbQuery();
  const [[order]] = await db.getPool().execute('SELECT * FROM orders WHERE id = ? LIMIT 1', [ctx.match[2]]);
  if (!order) return ctx.answerCbQuery('Gone');
  const done = await resolveReschedule(order, ctx.match[1] === 'ok', ctx.from.username || String(user.id));
  await ctx.answerCbQuery(done ? (ctx.match[1] === 'ok' ? '✓ Confirmed' : '✗ Declined') : 'Already handled');
  try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (e) {}
});

// Public availability probe for the website forecast: for each 2h window on a date, is there
// AT LEAST ONE active instructor who both matches (gear+level+lang) and is still free (no time
// clash / not enough travel buffer). Returns booleans only — never counts — so the site can hide
// the "book" action for a full window and steer users to neighbouring ones.
app.get('/availability', rateLimit({ capacity: 60, refillPerSec: 1 }), async (req, res) => {
  try {
    const sport = String(req.query.sport || '').trim().toLowerCase();
    const date = String(req.query.date || '').trim();
    if (!/^(surf|kite|wing|sup)$/.test(sport) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'bad_params' });
    }
    const levelMap = { 'first timer': 'first-timer', 'first-timer': 'first-timer', beginner: 'beginner', intermediate: 'intermediate', advanced: 'advanced' };
    const level = levelMap[String(req.query.level || '').trim().toLowerCase()] || null;
    const langRaw = String(req.query.lang || '').trim().toLowerCase();
    const reqLangs = /^[a-z]{2}$/.test(langRaw) ? [langRaw] : [];
    const pseudoOrder = { sport_type: sport, skill_level: level || '', required_languages: JSON.stringify(reqLangs) };
    const pool = db.getPool();
    const [insts] = await pool.execute("SELECT * FROM users WHERE role = 'instructor' AND is_active = 1");
    const eligible = insts.filter(i => isEligible(i, pseudoOrder));
    // Preload each eligible instructor's booked sessions for that date.
    const busyByInst = {};
    if (eligible.length) {
      const ids = eligible.map(i => i.id);
      const [act] = await pool.execute(
        `SELECT instructor_id, sessions FROM orders WHERE instructor_id IN (${ids.map(() => '?').join(',')}) AND status IN ('taken','confirmed')`, ids);
      for (const r of act) {
        const same = parseJson(r.sessions, []).filter(s => s && s.date === date);
        if (same.length) (busyByInst[r.instructor_id] = busyByInst[r.instructor_id] || []).push(...same);
      }
    }
    res.set('Cache-Control', 'no-store');
    const slots = {};
    const windows = await catalog.getSlotWindows(sport);
    for (const w of windows) {
      const candidate = [{ date, timeWindow: w, spot: null }];
      slots[w] = eligible.some(i => !scheduleConflict(candidate, busyByInst[i.id] || []));
    }
    res.json({ date, sport, level, slots });
  } catch (e) {
    console.error('availability error:', e.message);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Multi-session feasibility: for a WHOLE set of sessions (multi-day package = one coach throughout),
// is there AT LEAST ONE eligible instructor who is free for EVERY session in the set — checked
// against their existing bookings AND against travel/overlap conflicts within the requested set
// itself. Booleans only. Used by the booking form before payment so a multi-day pick is honest.
app.post('/availability/multi', rateLimit({ capacity: 60, refillPerSec: 1 }), async (req, res) => {
  try {
    const body = req.body || {};
    const sport = String(body.sport || '').trim().toLowerCase();
    if (!/^(surf|kite|wing|sup)$/.test(sport)) return res.status(400).json({ error: 'bad_params' });
    const levelMap = { 'first timer': 'first-timer', 'first-timer': 'first-timer', beginner: 'beginner', intermediate: 'intermediate', advanced: 'advanced' };
    const level = levelMap[String(body.level || '').trim().toLowerCase()] || null;
    const langRaw = String(body.lang || '').trim().toLowerCase();
    const reqLangs = /^[a-z]{2}$/.test(langRaw) ? [langRaw] : [];
    const want = (Array.isArray(body.sessions) ? body.sessions : [])
      .map(s => ({ date: String(s.date || ''), timeWindow: String(s.timeWindow || s.slot || ''), spot: s.spot || null }))
      .filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s.date) && s.timeWindow)
      .slice(0, 10);
    if (!want.length) return res.status(400).json({ error: 'no_sessions' });
    // The requested set must be internally consistent (no self-clash) for a single coach.
    let selfClash = false;
    for (let a = 0; a < want.length && !selfClash; a++)
      for (let b = a + 1; b < want.length; b++)
        if (scheduleConflict([want[a]], [want[b]])) { selfClash = true; break; }
    if (selfClash) return res.json({ feasible: false, reason: 'self_clash' });

    const pseudoOrder = { sport_type: sport, skill_level: level || '', required_languages: JSON.stringify(reqLangs) };
    const pool = db.getPool();
    const [insts] = await pool.execute("SELECT * FROM users WHERE role = 'instructor' AND is_active = 1");
    const eligible = insts.filter(i => isEligible(i, pseudoOrder));
    if (!eligible.length) return res.json({ feasible: false, reason: 'no_eligible' });
    const dates = [...new Set(want.map(s => s.date))];
    const ids = eligible.map(i => i.id);
    const [act] = await pool.execute(
      `SELECT instructor_id, sessions FROM orders WHERE instructor_id IN (${ids.map(() => '?').join(',')}) AND status IN ('taken','confirmed')`, ids);
    const busyByInst = {};
    for (const r of act) {
      const same = parseJson(r.sessions, []).filter(s => s && dates.includes(s.date));
      if (same.length) (busyByInst[r.instructor_id] = busyByInst[r.instructor_id] || []).push(...same);
    }
    // Feasible if any single eligible instructor clears the ENTIRE requested set.
    const feasible = eligible.some(i => !scheduleConflict(want, busyByInst[i.id] || []));
    res.set('Cache-Control', 'no-store');
    res.json({ feasible, reason: feasible ? 'ok' : 'all_busy' });
  } catch (e) {
    console.error('availability/multi error:', e.message);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Constant-time secret comparison — avoids leaking the webhook secret via response timing.
function safeSecretEqual(a, b) {
  const crypto = require('crypto');
  const ab = Buffer.from(String(a || '')), bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

app.post('/webhook/booking', rateLimit({ capacity: 12, refillPerSec: 0.2 }), async (req, res) => {
  if (!safeSecretEqual(req.headers['x-booking-secret'], BOOKING_WEBHOOK_SECRET)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const body = req.body || {};
    // Idempotency: the browser sends a stable key per booking attempt. A repeat (double-click,
    // network retry, replay) returns the ORIGINAL order instead of creating a duplicate.
    const idemKey = String(body.idempotencyKey || req.headers['idempotency-key'] || '').slice(0, 100) || null;
    const pool = db.getPool();
    if (idemKey) {
      const [[dup]] = await pool.execute('SELECT id FROM orders WHERE idempotency_key = ?', [idemKey]);
      if (dup) return res.json({ ok: true, orderId: dup.id, deduped: true });
    }

    // Blocked period: reject bookings for any date the super-admin has closed off (holidays,
    // maintenance, etc). Existing orders in the range are never touched — this only stops new ones.
    try {
      const reqSessions = Array.isArray(body.sessions) ? body.sessions : [];
      for (const s of reqSessions) {
        if (s && s.date && await catalog.isDateBlocked(s.date)) return res.status(409).json({ error: 'date_blocked' });
      }
    } catch (e) { console.error('blocked-period check error:', e.message); }

    // Slot re-check: between the forecast probe and this submit, matching coaches may have filled
    // up. Reject (409) so the browser can show "your slot was just taken" instead of creating an
    // order nobody can fulfil. Pool orders (pending/in_group) don't consume a coach — only
    // taken/confirmed do, matching the /availability logic.
    try {
      const reqSessions = Array.isArray(body.sessions) ? body.sessions : [];
      if (reqSessions.length) {
        const sport = String(body.sport || '').trim().toLowerCase();
        const levelMap = { 'first timer': 'first-timer', 'first-timer': 'first-timer', beginner: 'beginner', intermediate: 'intermediate', advanced: 'advanced' };
        const level = levelMap[String(body.skillLevel || '').trim().toLowerCase()] || '';
        const reqLang = String(body.preferredLanguage || '').trim().toLowerCase();
        const langCode = { english: 'en', russian: 'ru' }[reqLang] || (/^[a-z]{2}$/.test(reqLang) ? reqLang : '');
        const pseudo = { sport_type: sport, skill_level: level, required_languages: JSON.stringify(langCode ? [langCode] : []) };
        const [insts] = await pool.execute("SELECT * FROM users WHERE role = 'instructor' AND is_active = 1");
        const eligible = insts.filter(i => isEligible(i, pseudo));
        let busyByInst = {};
        if (eligible.length) {
          const ids = eligible.map(i => i.id);
          const [act] = await pool.execute(
            `SELECT instructor_id, sessions FROM orders WHERE instructor_id IN (${ids.map(() => '?').join(',')}) AND status IN ('taken','confirmed')`, ids);
          for (const r of act) (busyByInst[r.instructor_id] = busyByInst[r.instructor_id] || []).push(...parseJson(r.sessions, []));
        }
        const canServe = eligible.some(i => reqSessions.every(s => !scheduleConflict([s], busyByInst[i.id] || [])));
        if (!canServe) return res.status(409).json({ error: 'slot_unavailable' });
      }
    } catch (e) { console.error('slot re-check error:', e.message); /* never block booking on a check error */ }

    // Anti-fraud: NEVER trust the price the browser sends. Recompute the coaching price +
    // deposit from the server catalogue; if the client-sent number disagrees, flag it for
    // the super-admin and store the trusted figures rather than the submitted ones.
    let priceFlag = null;
    try {
      const q = await catalog.recomputeQuote(body);
      if (q.ok) {
        const sentSession = Number(body.sessionPrice);
        const sentDeposit = Number(body.deposit);
        if (!Number.isNaN(sentSession) && sentSession !== q.sessionPrice) priceFlag = `session ${sentSession}→${q.sessionPrice}`;
        if (!Number.isNaN(sentDeposit) && Math.abs(sentDeposit - q.deposit) > 1) priceFlag = (priceFlag ? priceFlag + '; ' : '') + `deposit ${sentDeposit}→${q.deposit}`;
        // Overwrite with trusted figures so downstream (instructor 80% cut) is always correct.
        body.sessionPrice = q.sessionPrice;
        body.deposit = q.deposit;
      } else {
        priceFlag = 'recompute_failed:' + q.reason;
      }
    } catch (e) { priceFlag = 'recompute_error:' + e.message; }

    const orderId = await db.insertOrderFromWebhook(body, idemKey);
    const pool2 = pool;
    await pool2.execute('UPDATE orders SET manage_token = ? WHERE id = ? AND manage_token IS NULL', [require('crypto').randomBytes(16).toString('hex'), orderId]);
    const [[order]] = await pool.execute('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (priceFlag) {
      await db.logAction('webhook', 'system', 'price_mismatch', orderId, { flag: priceFlag });
      try { await notifyRole('super_admin', () => `\u26A0\uFE0F Price check on order #${orderId}: ${priceFlag}. Stored the server-verified figures.`); } catch {}
    }
    // Side-effects (admin/super-admin notify + internal email) go through the durable outbox so a
    // crash or a slow Telegram/Resend call can't drop them — the worker retries with backoff.
    await outbox.enqueue(pool, 'new_order_notify', { orderId });
    await outbox.enqueue(pool, 'new_order_email', { orderId });
    res.json({ ok: true, orderId });
    if (outboxWorker) outboxWorker.tick().catch(() => {}); // deliver immediately; retry net stays
  } catch (e) {
    console.error('webhook intake error:', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

registerWhatsappRedirect(app);
app.get('/health', (req, res) => res.json({ ok: true, db: db.isReady() }));

// Super-admin service-catalogue CRUD (disciplines/services/prices/discounts/spots). Registered
// AFTER the core text handler so its own bot.on('text') is reached via next() for cat_* steps.
registerCatalogAdmin({ bot, db, Markup, requireUser, trackReply, conversationState, clearScreen, trackUserMessage });

// Outbox side-effect handlers. At-least-once: each reloads the order fresh, so a retry after a
// partial failure is safe. Notify and email are SEPARATE kinds so an email hiccup never causes a
// duplicate admin card.
const outboxHandlers = {
  async new_order_notify({ orderId }) {
    const [[order]] = await db.getPool().execute('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order) return;
    await notifyRole('admin', u => fullOrderMessage(order, { admin: true }), () => adminReviewKeyboard(orderId, 'admin', 'en'), orderId);
    await notifyRole('super_admin', u => fullOrderMessage(order, { admin: true }), () => adminReviewKeyboard(orderId, 'super_admin', 'en'), orderId);
    await refreshAllStatusPanels();
  },
  async new_order_email({ orderId }) {
    const [[order]] = await db.getPool().execute('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order) return;
    await email.newOrderInternalEmail(order);
  }
};

// ============================================================
// BOOT
// ============================================================

(async () => {
  // Start the HTTP server FIRST, before DB and Telegram — both of those can
  // hang or throw if env vars are wrong/missing (e.g. MySQL vars not linked
  // in Railway), and until something is listening on PORT, Railway's proxy
  // returns 502/connection-refused for every request, including /health.
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`HTTP listening on :${port}`));

  try {
    await db.init();
  } catch (e) {
    console.error('✗ db.init() failed (check MYSQLHOST/MYSQLUSER/MYSQLPASSWORD/MYSQLDATABASE variables):', e.message);
  }

  try {
    await migrate.run(db.getPool());
    refunds.setSandboxMode((await db.getSetting('paypal_sandbox', '0')) === '1');
    outboxWorker = outbox.startWorker(db.getPool(), outboxHandlers, { intervalMs: 2000 });
    log.info('migrations applied + outbox worker started', { sentry: log.sentryEnabled() });
  } catch (e) {
    log.error('migrate/outbox init failed', { err: e.message });
  }

  try {
    await catalog.init(db.getPool());
  } catch (e) {
    console.error('✗ catalog.init() failed:', e.message);
  }

  try {
    await bot.launch();
    console.log('Admin bot launched');
  } catch (e) {
    // Don't let a Telegram-side failure take the whole process down — the
    // webhook intake should keep working even if bot.launch() can't connect.
    console.error('✗ bot.launch() failed (Telegram bot inactive, HTTP still up):', e.message);
  }
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
