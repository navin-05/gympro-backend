const path = require('path');
const qrcode = require('qrcode-terminal');
const PQueue = require('p-queue').default;
const pino = require('pino');

const {
  default: makeWASocket,
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} = require('@whiskeysockets/baileys');

const silentLogger = pino({ level: 'silent' });

const DELIVERY_WARMUP_MS = 1200;
const POST_CONNECT_WARMUP_MS = 5000;

// libsignal session rotation logs (e.g. "Closing session: SessionEntry") are internal only
const _consoleInfo = console.info.bind(console);
console.info = (...args) => {
  const text = args.map((a) => String(a)).join(' ');
  if (/Closing session:\s*SessionEntry/i.test(text)) return;
  _consoleInfo(...args);
};

const sendQueue = new PQueue({ concurrency: 1 });

// Readiness flag (same external behavior as previous implementation)
let isWhatsAppReady = false;

// REQUIRED global state variables (auth/session safety)
let sock = null;
let isConnecting = false;
let socketInitializing = false;

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

function endExistingSocket() {
  if (!sock) return;
  try {
    sock.ev.removeAllListeners();
    sock.end(undefined);
  } catch (e) {
    // ignore teardown errors
  }
  sock = null;
}

async function connectToWhatsApp() {
  if (socketInitializing) {
    console.log('[WhatsApp] Socket init already running');
    return;
  }

  if (isConnecting) {
    console.log('[WhatsApp] Connection already in progress');
    return;
  }

  socketInitializing = true;
  isConnecting = true;

  console.log('[WhatsApp] Connecting...');

  const { state, saveCreds: save } = await useMultiFileAuthState(authDir());
  authState = state;
  saveCreds = save;

  const { version } = await fetchLatestBaileysVersion();
  const hadSession = !!authState?.creds?.registered;

  endExistingSocket();

  global.__SOCKET_CREATE_COUNT = (global.__SOCKET_CREATE_COUNT || 0) + 1;
  console.log('SOCKET CREATED:', global.__SOCKET_CREATE_COUNT);

  const s = makeWASocket({
    version,
    auth: authState,
    browser: Browsers.macOS('Desktop'),
    printQRInTerminal: false, // we render QR ourselves via qrcode-terminal
    syncFullHistory: false, // lower memory
    markOnlineOnConnect: false, // lower chatter
    keepAliveIntervalMs: 25000,
    generateHighQualityLinkPreview: false,
    logger: silentLogger,
  });

  sock = s;

  s.ev.on('creds.update', saveCreds);

  s.ev.on('messages.upsert', ({ messages }) => {
    for (const msg of messages || []) {
      if (!msg?.key?.fromMe) continue;
      const hasDecryptStub = msg.messageStubType != null && !msg.message;
      if (!hasDecryptStub) continue;
      console.log('[WhatsApp][info] Self-echo decrypt/sync event (ignored, no lifecycle action):', {
        id: msg.key?.id,
        remoteJid: msg.key?.remoteJid,
        stubType: msg.messageStubType,
      });
    }
  });

  s.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update || {};

    if (qr) {
      console.log('[WhatsApp] QR Code generated');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      await clearReconnectTimer();
      isConnecting = false;
      socketInitializing = false;
      console.log(hadSession ? '[WhatsApp] Session restored' : '[WhatsApp] Connected');
      console.log('[WhatsApp] Post-connect warmup (linked-device sync)...');
      await new Promise((r) => setTimeout(r, POST_CONNECT_WARMUP_MS));
      isWhatsAppReady = true;
      console.log('[WhatsApp] Ready for messaging');
      return;
    }

    if (connection === 'close') {
      isWhatsAppReady = false;

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log('[WhatsApp] Disconnected');
      isConnecting = false;
      socketInitializing = false;

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

      return sendQueue.add(async () => {
        await sock.presenceSubscribe(jid);
        await new Promise((r) => setTimeout(r, DELIVERY_WARMUP_MS));
        const res = await sock.sendMessage(jid, { text: String(message ?? '') });
        const id = res?.key?.id || res?.messageTimestamp || 'unknown';
        return { id: { id }, key: res?.key, _raw: res };
      });
    },
  };
}

async function startWhatsAppClient() {
  if (isWhatsAppReady) return;

  try {
    await connectToWhatsApp();
  } catch (err) {
    console.error('[WhatsApp] Startup initialization failed:', err?.message || err);
    isWhatsAppReady = false;
    isConnecting = false;
    socketInitializing = false;
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
