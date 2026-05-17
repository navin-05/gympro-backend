const twilio = require('twilio');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const TWILIO_WHATSAPP_FROM = 'whatsapp:+14155238886';

/**
 * Send a WhatsApp message via Twilio sandbox.
 * @param {string} to - Recipient number in E.164 format (e.g. +919876543210)
 * @param {string} message - Message body
 * @returns {Promise<object|null>} Twilio message object or null on failure
 */
async function sendWhatsAppMessage(to, message) {
  try {
    if (!to || !message) {
      console.log('[WhatsApp] Skipped: missing recipient or message');
      return null;
    }

    // Sanitize phone number — ensure it starts with +
    const sanitizedTo = to.startsWith('+') ? to : `+${to}`;

    const result = await client.messages.create({
      from: TWILIO_WHATSAPP_FROM,
      to: `whatsapp:${sanitizedTo}`,
      body: message,
    });

    console.log(`[WhatsApp] Message sent successfully | SID: ${result.sid}`);
    return result;
  } catch (error) {
    console.error(`[WhatsApp] Failed to send message: ${error.message}`);
    return null;
  }
}

module.exports = { sendWhatsAppMessage };
