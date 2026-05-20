const path = require('path');
const qrcode = require('qrcode-terminal');

const {
  default: makeWASocket,
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} = require('@whiskeysockets/baileys');

// Readiness flag (same external behavior as previous implementation)
let isWhatsAppReady = false;

// REQUIRED global state variables (auth/session safety)
let sock = null;
let isConnecting = false;

// Internal auth refs (kept to preserve existing exported surface)
let authState = null;
let saveCreds = null;

let reconnectTimer = null;

function authDir() {
  // Requirement: store auth session inside "/baileys_auth" (project-local)
  return path.join(__dirname, '..', 'baileys_auth');
}

function chatIdToJid(chatId) {
  // whatsapp-web.js uses `${digits}@c.us` for user chats.
  // Baileys uses `${digits}@s.whatsapp.net`.
  const s = String(chatId || '').trim();
  const digits = s.replace(/\D/g, '');
  if (!digits) return null;
  return `${digits}@s.whatsapp.net`;
}

async function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  console.log('[WhatsApp] Reconnecting...');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startWhatsAppClient().catch(() => {});
  }, 5000);
}

async function connectToWhatsApp() {
  if (isConnecting) {
    console.log('[WhatsApp] Connection already in progress');
    return;
  }

  isConnecting = true;

  console.log('[WhatsApp] Connecting...');

  const { state, saveCreds: save } = await useMultiFileAuthState(authDir());
  authState = state;
  saveCreds = save;

  const { version } = await fetchLatestBaileysVersion();
  const hadSession = !!authState?.creds?.registered;

  const s = makeWASocket({
    version,
    auth: authState,
    browser: Browsers.macOS('Desktop'),
    printQRInTerminal: false, // we render QR ourselves via qrcode-terminal
    syncFullHistory: false, // lower memory
    markOnlineOnConnect: false, // lower chatter
    keepAliveIntervalMs: 25000,
    generateHighQualityLinkPreview: false,
  });

  s.ev.on('creds.update', async () => {
    try {
      if (typeof saveCreds === 'function') {
        await saveCreds();
      }
    } catch (e) {
      console.error('[WhatsApp] Failed to persist auth state:', e?.message || e);
    }
  });

  s.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update || {};

    if (qr) {
      console.log('[WhatsApp] QR Code generated');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      isWhatsAppReady = true;
      await clearReconnectTimer();
      isConnecting = false;
      console.log(hadSession ? '[WhatsApp] Session restored' : '[WhatsApp] Connected');
      return;
    }

    if (connection === 'close') {
      isWhatsAppReady = false;

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log('[WhatsApp] Disconnected');
      isConnecting = false;

      if (!shouldReconnect) {
        // Logged out: do not spam reconnect. User must re-pair.
        console.log('[WhatsApp] Logged out. Delete /baileys_auth and re-pair if needed.');
        return;
      }

      scheduleReconnect();
    }
  });

  return s;
}

function getClient() {
  // Backward compatible "client" with sendMessage(chatId, message) signature.
  return {
    sendMessage: async (chatId, message) => {
      if (!sock) {
        throw new Error('WhatsApp client not initialized');
      }
      const jid = chatIdToJid(chatId);
      if (!jid) {
        throw new Error('Invalid recipient chat id');
      }
      const res = await sock.sendMessage(jid, { text: String(message ?? '') });
      const id = res?.key?.id || res?.messageTimestamp || 'unknown';
      return { id: { id }, key: res?.key, _raw: res };
    },
  };
}

async function startWhatsAppClient() {
  if (isWhatsAppReady) return;

  try {
    sock = await connectToWhatsApp();
  } catch (err) {
    console.error('[WhatsApp] Startup initialization failed:', err?.message || err);
    isWhatsAppReady = false;
    isConnecting = false;
    scheduleReconnect();
  }
}

function isWhatsAppReadyFn() {
  return isWhatsAppReady === true;
}

module.exports = {
  startWhatsAppClient,
  getClient,
  isWhatsAppReady: isWhatsAppReadyFn,
  // Backward-compatible export name used elsewhere.
  initializeWhatsAppClient: () => startWhatsAppClient(),
};
