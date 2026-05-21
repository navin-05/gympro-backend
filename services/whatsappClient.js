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

const {
  installLibsignalLogGuards,
  attachMessageSessionDiagnostics,
  maybeRecoverBeforeSend,
  noteSendSuccess,
} = require('./signalSessionGuard');

installLibsignalLogGuards();

const silentLogger = pino({ level: 'silent' });

const DELIVERY_WARMUP_MS = 1200;
const POST_CONNECT_WARMUP_MS = 5000;
const PREVENTIVE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

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
let preventiveRefreshTimer = null;
let preventiveRefreshTimerStarted = false;
let preventiveRefreshInProgress = false;
let socketConnectedAt = null;

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

function isSendQueueIdle() {
  return sendQueue.pending === 0 && sendQueue.size === 0;
}

function getSocketUptimeMs() {
  return socketConnectedAt ? Date.now() - socketConnectedAt : 0;
}

function getQueueState() {
  return {
    pending: sendQueue.pending,
    size: sendQueue.size,
    idle: isSendQueueIdle(),
  };
}

function waitForWhatsAppReady(timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (isWhatsAppReady) return resolve();
      if (Date.now() - started > timeoutMs) {
        return reject(new Error('WhatsApp ready timeout after soft refresh'));
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}

function startPreventiveRefreshTimer() {
  if (preventiveRefreshTimerStarted) return;
  preventiveRefreshTimerStarted = true;

  preventiveRefreshTimer = setInterval(() => {
    runPreventiveSoftRefresh().catch((err) => {
      console.log(
        '[WhatsApp] Preventive soft refresh error (non-fatal):',
        err?.message || err
      );
    });
  }, PREVENTIVE_REFRESH_INTERVAL_MS);
}

async function runPreventiveSoftRefresh() {
  const uptimeMs = getSocketUptimeMs();
  const queueState = getQueueState();

  if (!isSendQueueIdle()) {
    console.log('[WhatsApp] Preventive soft refresh skipped (active send / queue busy):', {
      socketUptimeMs: uptimeMs,
      queueState,
    });
    return;
  }

  if (preventiveRefreshInProgress || socketInitializing || isConnecting) {
    console.log('[WhatsApp] Preventive soft refresh skipped (lifecycle busy):', {
      socketUptimeMs: uptimeMs,
      queueState,
      preventiveRefreshInProgress,
      socketInitializing,
      isConnecting,
    });
    return;
  }

  if (!sock) {
    console.log('[WhatsApp] Preventive soft refresh skipped (no active socket):', {
      socketUptimeMs: uptimeMs,
      queueState,
    });
    return;
  }

  console.log('[WhatsApp] Preventive soft refresh starting', {
    socketUptimeMs: uptimeMs,
    queueState,
  });

  preventiveRefreshInProgress = true;
  isWhatsAppReady = false;

  try {
    await clearReconnectTimer();
    endExistingSocket();
    await connectToWhatsApp();
    await waitForWhatsAppReady();

    console.log('[WhatsApp] Preventive soft refresh completed', {
      socketUptimeMs: getSocketUptimeMs(),
      queueState: getQueueState(),
    });
  } catch (err) {
    console.log(
      '[WhatsApp] Preventive soft refresh failed (non-fatal):',
      err?.message || err
    );
    scheduleReconnect();
  } finally {
    preventiveRefreshInProgress = false;
  }
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

  attachMessageSessionDiagnostics(s);

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
      socketConnectedAt = Date.now();
      console.log(hadSession ? '[WhatsApp] Session restored' : '[WhatsApp] Connected');
      console.log('[WhatsApp] Post-connect warmup (linked-device sync)...');
      await new Promise((r) => setTimeout(r, POST_CONNECT_WARMUP_MS));
      isWhatsAppReady = true;
      console.log('[WhatsApp] Ready for messaging');
      startPreventiveRefreshTimer();
      return;
    }

    if (connection === 'close') {
      isWhatsAppReady = false;

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log('[WhatsApp] Disconnected');
      isConnecting = false;
      socketInitializing = false;

      if (preventiveRefreshInProgress) {
        return;
      }

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
        await maybeRecoverBeforeSend(sock, jid);
        await sock.presenceSubscribe(jid);
        await new Promise((r) => setTimeout(r, DELIVERY_WARMUP_MS));
        const res = await sock.sendMessage(jid, { text: String(message ?? '') });
        noteSendSuccess(jid);
        const id = res?.key?.id || res?.messageTimestamp || 'unknown';
        return { id: { id }, key: res?.key, _raw: res };
      });
    },
  };
}

async function startWhatsAppClient() {
  if (isWhatsAppReady || preventiveRefreshInProgress) return;

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
