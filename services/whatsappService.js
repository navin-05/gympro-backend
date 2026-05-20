const { getClient, isWhatsAppReady } = require('./whatsappClient');

function toWhatsAppChatId(e164OrPlus) {
  const digits = String(e164OrPlus).replace(/\D/g, '');
  if (!digits) {
    return null;
  }
  return `${digits}@c.us`;
}

/**
 * Send a WhatsApp message via the server admin whatsapp-web.js session.
 * Reuses the global client initialized at startup — does not launch Chromium here.
 * @param {string} to - Recipient number in E.164 format (e.g. +919876543210)
 * @param {string} message - Message body
 * @returns {Promise<object|null>} Send result or null on failure
 */
async function sendWhatsAppMessage(to, message) {
  try {
    // STEP 5 — block sends before ready
    if (!isWhatsAppReady()) {
      console.log('[WhatsApp] Client not ready yet');
      return false;
    }

    if (!to || !message) {
      console.log('[WhatsApp] Skipped: missing recipient or message');
      return null;
    }

    const sanitizedTo = to.startsWith('+') ? to : `+${to}`;
    const chatId = toWhatsAppChatId(sanitizedTo);
    if (!chatId) {
      console.log('[WhatsApp] Skipped: invalid recipient');
      return null;
    }

    console.log('[WhatsApp] sendMessage called | to:', sanitizedTo);

    console.log('[WA-NUM-DEBUG] client.sendMessage recipient:', { to: sanitizedTo, chatId });

    const result = await getClient().sendMessage(chatId, message);
    const messageId = result?.id?.id || result?.id || 'unknown';
    console.log(`[WhatsApp] Message sent successfully | id: ${messageId}`);
    return result;
  } catch (error) {
    console.error(`[WhatsApp] Failed to send message: ${error.message}`);
    return null;
  }
}

module.exports = { sendWhatsAppMessage };
