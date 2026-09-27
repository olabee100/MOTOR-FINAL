// Sends an SMS alert when a high-urgency breakdown is reported.
// With SMS_PROVIDER=none (the default), nothing is sent and no cost is
// incurred — the message is just written to the server log so you can see
// what WOULD have been sent. Switch to a real provider once you're ready
// to pay for SMS credit.
const fetch = require('node-fetch');

async function sendAlertSms(message) {
  const provider = (process.env.SMS_PROVIDER || 'none').toLowerCase();
  const numbers = (process.env.ALERT_PHONE_NUMBERS || '')
    .split(',').map(n => n.trim()).filter(Boolean);

  if (provider === 'none' || numbers.length === 0) {
    console.log('[SMS not sent — no provider configured] Would have sent:', message);
    return { sent: false, reason: 'no_provider_configured' };
  }

  if (provider === 'termii') {
    const apiKey = process.env.TERMII_API_KEY;
    const senderId = process.env.TERMII_SENDER_ID || 'MotorTrack';
    if (!apiKey) {
      console.log('[SMS not sent — TERMII_API_KEY missing]', message);
      return { sent: false, reason: 'missing_api_key' };
    }
    const results = [];
    for (const to of numbers) {
      try {
        const resp = await fetch('https://api.ng.termii.com/api/sms/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to, from: senderId, sms: message, type: 'plain', channel: 'generic', api_key: apiKey }),
        });
        const data = await resp.json();
        results.push({ to, ok: resp.ok, data });
      } catch (e) {
        results.push({ to, ok: false, error: e.message });
      }
    }
    return { sent: true, provider: 'termii', results };
  }

  console.log('[SMS not sent — unknown provider]', provider);
  return { sent: false, reason: 'unknown_provider' };
}

module.exports = { sendAlertSms };
