// email.js — client-facing transactional emails via Resend.
// All order-related mail is sent FROM orders@easybali.surf (override with RESEND_FROM_EMAIL),
// and every paid order is copied to that same inbox (newOrderInternalEmail).
const fetch = require('node-fetch');

const ORDERS_EMAIL = process.env.ORDERS_EMAIL || 'orders@easybali.surf';

async function sendEmail(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL || ORDERS_EMAIL;
  if (!apiKey) { console.log('RESEND_API_KEY not set — skipping email:', subject); return; }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, html, reply_to: ORDERS_EMAIL })
  });
  if (!res.ok) console.error('Resend send failed:', await res.text());
}

function pj(v, fb) { if (Array.isArray(v)) return v; try { const x = JSON.parse(v); return Array.isArray(x) ? x : fb; } catch { return fb; } }
const SPORT_SHORT = { surf: 'Surf', kite: 'Kite', wing: 'Wing', sup: 'SUP' };

// Full order details WITHOUT any contact data (no phone/email/WhatsApp).
function orderDetailsHtml(order) {
  const sessions = pj(order.sessions, []);
  const addonsFlat = pj(order.addons, []);
  const mediaDates = pj(order.media_dates, []);
  const sport = SPORT_SHORT[String(order.sport_type).toLowerCase()] || order.sport_type;
  const sessionRows = sessions.map((s, i) => {
    const extras = (Array.isArray(s.addons) ? s.addons : [])
      .map(a => `<div style="color:#55676D;font-size:13px">• ${a.label}${a.amount ? ' — $' + a.amount : ''}</div>`).join('');
    const media = (!s.addons && mediaDates.includes(s.date)) ? '<div style="color:#55676D;font-size:13px">• Photo + video + drone</div>' : '';
    return `<div style="margin:8px 0"><strong>${i + 1}. ${s.date} · ${s.timeWindow || ''}</strong><br>${s.spot || 'Spot TBD'}${extras}${media}</div>`;
  }).join('');
  const flatAddons = sessions.some(s => Array.isArray(s.addons) && s.addons.length) ? '' :
    addonsFlat.map(a => `<div style="color:#55676D;font-size:13px">• ${a.label}${a.amount ? ' — $' + a.amount : ''}</div>`).join('');
  return `
  <div style="border:1px solid #E3E0D6;border-radius:10px;padding:16px 18px;margin:16px 0;font-family:Arial,Helvetica,sans-serif;color:#33474C">
    <div><strong>Booking #${order.id}</strong></div>
    <div style="margin-top:6px">${sport} · ${order.skill_level}${order.instructor_lang_pref ? ' · ' + order.instructor_lang_pref : ''} · ${order.participants} rider(s)</div>
    ${sessionRows}
    ${flatAddons}
    <div style="border-top:1px solid #E3E0D6;margin-top:10px;padding-top:10px">
      Deposit paid: <strong>$${order.deposit_price}</strong> (${order.deposit_payment_method || '—'})<br>
      Total: <strong>$${order.total_price || ''}</strong>
    </div>
  </div>`;
}

const FOOTER = `<p style="color:#55676D;font-size:13px">Questions about your order? Write to us at <a href="mailto:${ORDERS_EMAIL}" style="color:#0E7C8C">${ORDERS_EMAIL}</a>.</p>`;

const SITE_URL = process.env.SITE_URL || 'https://easybali.surf';
function manageUrl(order) { return `${SITE_URL}/manage.html?o=${order.id}&t=${order.manage_token || ''}`; }
function manageBlock(order) {
  if (!order.manage_token) return '';
  return `<div style="margin:18px 0"><a href="${manageUrl(order)}" style="display:inline-block;background:#0E7C8C;color:#fff;text-decoration:none;padding:11px 22px;border-radius:100px;font-family:Arial,Helvetica,sans-serif;font-weight:bold">Manage booking</a><div style="color:#55676D;font-size:12px;margin-top:8px">Cancel or reschedule your session here.</div></div>`;
}

function bookingConfirmedEmail(order) {
  return sendEmail(
    order.client_email,
    'Your EasyBali.surf session is confirmed',
    `<p>Hi ${order.client_name},</p><p>Your ${order.sport_type} session is confirmed — your coach will reach out on WhatsApp for all details.</p>` +
    orderDetailsHtml(order) + manageBlock(order) + FOOTER
  );
}

// Client cancellation confirmation. refundNote describes the deposit outcome.
function cancellationEmail(order, refundNote) {
  return sendEmail(
    order.client_email,
    `Your EasyBali.surf booking #${order.id} is cancelled`,
    `<p>Hi ${order.client_name},</p><p>Your booking has been cancelled as requested.</p>` +
    (refundNote ? `<p>${refundNote}</p>` : '') + FOOTER
  );
}

// Reschedule request received (needs coach confirmation). newWhen = "DD Mon · window".
function rescheduleRequestedEmail(order, newWhen) {
  return sendEmail(
    order.client_email,
    `Reschedule request received — booking #${order.id}`,
    `<p>Hi ${order.client_name},</p><p>We received your request to move your session to <strong>${newWhen}</strong>. Your original session stays booked until a coach confirms the new time — we'll email you shortly.</p>` +
    manageBlock(order) + FOOTER
  );
}

// Reschedule finalised (confirmed onto the new date).
function rescheduleConfirmedEmail(order, newWhen) {
  return sendEmail(
    order.client_email,
    `Your session is moved — booking #${order.id}`,
    `<p>Hi ${order.client_name},</p><p>Your session is now set for <strong>${newWhen}</strong>. Your coach will confirm details on WhatsApp.</p>` +
    manageBlock(order) + FOOTER
  );
}

// Reschedule could not be arranged — original booking stands.
function rescheduleFailedEmail(order, origWhen) {
  return sendEmail(
    order.client_email,
    `Couldn't move booking #${order.id} — original time stands`,
    `<p>Hi ${order.client_name},</p><p>We couldn't arrange a coach for your requested time, so your original session on <strong>${origWhen}</strong> remains booked. You can pick another day or cancel from the link below.</p>` +
    manageBlock(order) + FOOTER
  );
}

// Internal copy of every paid order straight to the orders inbox (contacts included — internal only).
function newOrderInternalEmail(order) {
  return sendEmail(
    ORDERS_EMAIL,
    `New paid order #${order.id} — ${order.client_name}`,
    `<p><strong>${order.client_name}</strong>${order.age ? ' (' + order.age + 'y)' : ''}<br>${order.client_phone} · ${order.client_email}</p>` +
    (order.additional_info ? `<p>Note: ${order.additional_info}</p>` : '') +
    orderDetailsHtml(order)
  );
}

function reminder24hEmail(order, sessionTime) {
  return sendEmail(
    order.client_email,
    'Your session is tomorrow',
    `<p>Hi ${order.client_name},</p><p>Reminder — your ${order.sport_type} session is coming up at ${sessionTime}. Your coach will be in touch on WhatsApp with the details. See you in the water!</p>` + FOOTER
  );
}

function reminder2hEmail(order, sessionTime) {
  return sendEmail(
    order.client_email,
    'Your session starts in 2 hours',
    `<p>Hi ${order.client_name},</p><p>Just a reminder — your ${order.sport_type} session is coming up at ${sessionTime}. See you in the water!</p>` + FOOTER
  );
}

function followUpEmail(order) {
  return sendEmail(
    order.client_email,
    'How was your session with EasyBali.surf?',
    `<p>Hi ${order.client_name},</p><p>Thanks for riding with us! We'd love to hear how it went — and if you're up for another session, we're always here.</p>` + FOOTER
  );
}

// Post-session review request — a one-click star link to the review page (token-signed URL).
function reviewRequestEmail(order, reviewUrl) {
  const stars = [1, 2, 3, 4, 5].map(n =>
    `<a href="${reviewUrl}&rating=${n}" style="text-decoration:none;font-size:30px;color:#E0A32E;margin:0 3px">&#9733;</a>`
  ).join('');
  return sendEmail(
    order.client_email,
    'How was your session? Leave a quick review',
    `<p>Hi ${order.client_name},</p>` +
    `<p>Thanks for riding with EasyBali.surf! We'd love a quick word on how your ${order.sport_type} session went — it takes 20 seconds and helps other riders (and your coach).</p>` +
    `<div style="text-align:center;margin:22px 0">${stars}<div style="margin-top:10px"><a href="${reviewUrl}" style="display:inline-block;background:#0E7C8C;color:#fff;text-decoration:none;padding:12px 26px;border-radius:100px;font-family:Arial,Helvetica,sans-serif;font-weight:bold">Leave a review</a></div></div>` +
    FOOTER
  );
}

function depositRefundedEmail(order) {
  return sendEmail(
    order.client_email,
    'Your EasyBali.surf deposit has been refunded',
    `<p>Hi ${order.client_name},</p><p>We couldn't match your booking #${order.id} with a coach in time, so your $${order.deposit_price} deposit has been refunded via ${order.deposit_payment_method}. Sorry for the inconvenience — feel free to try another time window.</p>` + FOOTER
  );
}

module.exports = { sendEmail, bookingConfirmedEmail, newOrderInternalEmail, reminder24hEmail, reminder2hEmail, followUpEmail, reviewRequestEmail, depositRefundedEmail, cancellationEmail, rescheduleRequestedEmail, rescheduleConfirmedEmail, rescheduleFailedEmail };
