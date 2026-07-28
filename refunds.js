// refunds.js — deposit refund handling.
// PayPal: automatic, via REST API (needs a real capture id stored at deposit-payment time).
// Crypto (NOWPayments/CryptoBot etc.): NOT automated here — most crypto refunds require
// manual review anyway (unclear which txid to send back to, network fees, etc.), so we
// just surface a clear "manual refund needed" task to the super_admin with all the details
// they need (amount, method, payment ref) instead of guessing at an API call.

const fetch = require('node-fetch');

// Sandbox toggle (Danger Zone) — swaps live PayPal creds for sandbox ones without a redeploy.
// Set PAYPAL_SANDBOX_CLIENT_ID / _SECRET in env; falls back to the live vars if unset.
let SANDBOX = false;
function setSandboxMode(on) { SANDBOX = !!on; }
function isSandboxMode() { return SANDBOX; }
function paypalCreds() {
  if (SANDBOX) return {
    id: process.env.PAYPAL_SANDBOX_CLIENT_ID || process.env.PAYPAL_CLIENT_ID,
    secret: process.env.PAYPAL_SANDBOX_CLIENT_SECRET || process.env.PAYPAL_CLIENT_SECRET,
    base: process.env.PAYPAL_SANDBOX_API_BASE || 'https://api-m.sandbox.paypal.com'
  };
  return { id: process.env.PAYPAL_CLIENT_ID, secret: process.env.PAYPAL_CLIENT_SECRET, base: process.env.PAYPAL_API_BASE || 'https://api-m.paypal.com' };
}

async function getPayPalAccessToken() {
  const { id, secret, base } = paypalCreds();
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  const data = await res.json();
  if (!res.ok) throw new Error('PayPal auth failed: ' + JSON.stringify(data));
  return data.access_token;
}

// captureId = the PayPal capture id stored in orders.deposit_payment_ref at checkout time.
async function refundPayPalDeposit(captureId, amountUsd) {
  const { base, id, secret } = paypalCreds();
  const token = await getPayPalAccessToken();
  const res = await fetch(`${base}/v2/payments/captures/${captureId}/refund`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: { value: amountUsd.toFixed(2), currency_code: 'USD' } })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('PayPal refund failed: ' + JSON.stringify(data));
  return data; // { id, status: 'COMPLETED', ... }
}

// Both PayPal and crypto refunds are handled manually by the super_admin now (PayPal's API
// auto-refund was dropped — a human always double-checks amount/recipient before moving
// money back out). This function's job is just to hand back the info needed to action it;
// see admin_markrefunded_* in index.js for the "I've sent it" confirmation step.
async function processDepositRefund(order) {
  return { auto: false };
}

module.exports = { processDepositRefund, refundPayPalDeposit, setSandboxMode, isSandboxMode };
