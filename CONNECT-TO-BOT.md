# Connecting the site to the admin bot (test mode, no PayPal yet)

The booking form already fires a webhook to the admin bot the moment someone
submits the form — it does NOT wait for a real PayPal payment yet (that
integration isn't built). `paymentStatus` is hardcoded to `'COMPLETED'` in
`submitOrderToAdminBot()`, which is exactly what you want for testing: every
submitted test booking goes straight through as if it were paid.

## 1. Get your two values from the admin bot deploy

From the admin-bot's Railway service:
- **Webhook URL** — Settings → Networking → your generated domain, e.g.
  `https://admin-bot-production-xxxx.up.railway.app`
- **Webhook secret** — the exact value you set for `BOOKING_WEBHOOK_SECRET`
  in that service's Variables.

## 2. Edit index.html

Open `index.html`, find `submitOrderToAdminBot` (search for it), and edit
these two lines:

```js
const WEBHOOK_URL = 'https://<your-admin-bot-domain>/webhook/booking';
const WEBHOOK_SECRET = 'REPLACE_WITH_BOOKING_WEBHOOK_SECRET';
```

Replace with your real values, e.g.:

```js
const WEBHOOK_URL = 'https://admin-bot-production-xxxx.up.railway.app/webhook/booking';
const WEBHOOK_SECRET = 'the-same-long-random-string-you-put-in-Railway';
```

Keep the `/webhook/booking` path — don't drop it.

## 3. Test it

1. Open the site, go through the booking form (any discipline/date/add-ons),
   submit.
2. Check the admin bot in Telegram — a new order should land in the
   super_admin's and admin's private chat within a couple seconds, with the
   "Send to group" button.
3. Tap "Send to group" → check the instructors group gets the anonymized
   card.
4. Have a test instructor account tap "Take" → confirm they get the full
   order + WhatsApp/Calendar buttons privately.

If nothing arrives: open the browser console on the site (F12) right after
submitting — a failed `fetch` logs `Admin bot webhook failed: ...` with the
actual error (wrong URL, CORS, wrong secret → 401, etc).

## 4. Before going live (not done yet)

This test wiring skips real payment verification entirely. Before real
money is involved, `submitOrderToAdminBot` needs to be triggered only AFTER
a genuine PayPal capture succeeds (server-verified) or a confirmed crypto
payment via the client bot — see the comment directly above the function in
the code for what's still a placeholder.
