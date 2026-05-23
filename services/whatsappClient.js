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
  runPreSendSessionRevalidation,
  noteSendSuccess,
} = require('./signalSessionGuard');

installLibsignalLogGuards();

const silentLogger = pino({ level: 'silent' });

const DELIVERY_WARMUP_MS = 1200;
const POST_CONNECT_WARMUP_MS = 5000;
const KEEPALIVE_INTERVAL_MS = 2.5 * 60 * 1000;
const FALLBACK_REFRESH_INTERVAL_MS = 25 * 60 * 1000;
const MIN_SOCKET_UPTIME_FOR_FALLBACK_MS = 20 * 60 * 1000;
const MIN_IDLE_SINCE_SEND_FOR_FALLBACK_MS = 10 * 60 * 1000;
const MD_RECOVERY_BASE_DELAY_MS = 5000;
const MD_RECOVERY_COOLDOWN_MS = 30000;
const MD_RECOVERY_MAX_ATTEMPTS = 8;
const LONG_IDLE_MS = 60 * 60 * 1000;

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
let keepaliveTimer = null;
let fallbackRefreshTimer = null;
let mdMaintenanceTimersStarted = false;
let preventiveRefreshInProgress = false;
let socketConnectedAt = null;
let lastSendActivityAt = null;
let mdRecoveryTimer = null;
let mdRecoveryInProgress = false;
let mdRecoveryFailureCount = 0;
let mdRecoveryCooldownUntil = 0;

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

function clearMdRecoveryTimer() {
  if (mdRecoveryTimer) {
    clearTimeout(mdRecoveryTimer);
    mdRecoveryTimer = null;
  }
}

function disconnectReasonLabel(statusCode) {
  if (statusCode == null) return 'unknown';
  const entry = Object.entries(DisconnectReason).find(([, code]) => code === statusCode);
  return entry ? entry[0] : String(statusCode);
}

function isRecoverableMdDisconnect(statusCode) {
  if (statusCode === DisconnectReason.loggedOut) return false;
  if (statusCode === DisconnectReason.badSession) return false;
  if (statusCode === DisconnectReason.forbidden) return false;
  if (statusCode === DisconnectReason.multideviceMismatch) return false;
  return true;
}

function likelyPhoneOffline() {
  const idleSinceSendMs = msSinceLastSend();
  const uptimeMs = getSocketUptimeMs();
  return (
    (idleSinceSendMs !== null && idleSinceSendMs >= LONG_IDLE_MS) ||
    uptimeMs >= LONG_IDLE_MS
  );
}

function scheduleAutomaticLinkedDeviceRecovery(context) {
  if (mdRecoveryTimer) return;

  const now = Date.now();
  if (now < mdRecoveryCooldownUntil) {
    const waitMs = mdRecoveryCooldownUntil - now;
    mdRecoveryTimer = setTimeout(() => {
      mdRecoveryTimer = null;
      scheduleAutomaticLinkedDeviceRecovery(context);
    }, waitMs);
    return;
  }

  if (
    preventiveRefreshInProgress ||
    mdRecoveryInProgress ||
    socketInitializing ||
    isConnecting
  ) {
    console.log('[WhatsApp] Recovery skipped (lifecycle busy)', context);
    mdRecoveryTimer = setTimeout(() => {
      mdRecoveryTimer = null;
      scheduleAutomaticLinkedDeviceRecovery(context);
    }, MD_RECOVERY_BASE_DELAY_MS);
    return;
  }

  const backoffMs = Math.min(mdRecoveryFailureCount * 2000, 30000);
  const delayMs = MD_RECOVERY_BASE_DELAY_MS + backoffMs;

  mdRecoveryTimer = setTimeout(() => {
    mdRecoveryTimer = null;
    runAutomaticLinkedDeviceRecovery(context).catch((err) => {
      console.log(
        '[WhatsApp] Automatic linked-device recovery error (non-fatal):',
        err?.message || err
      );
    });
  }, delayMs);
}

async function runAutomaticLinkedDeviceRecovery(context) {
  if (
    preventiveRefreshInProgress ||
    mdRecoveryInProgress ||
    socketInitializing ||
    isConnecting
  ) {
    console.log('[WhatsApp] Recovery skipped (lifecycle busy)', context);
    scheduleAutomaticLinkedDeviceRecovery(context);
    return;
  }

  console.log('[WhatsApp] Automatic linked-device recovery starting', context);

  mdRecoveryInProgress = true;
  isWhatsAppReady = false;

  try {
    await clearReconnectTimer();
    clearMdRecoveryTimer();
    endExistingSocket();
    await connectToWhatsApp();
    await waitForWhatsAppReady();

    mdRecoveryFailureCount = 0;
    mdRecoveryCooldownUntil = 0;

    console.log('[WhatsApp] Automatic linked-device recovery completed', {
      socketUptimeMs: getSocketUptimeMs(),
      queueState: getQueueState(),
      disconnectReason: context?.disconnectReason,
    });
  } catch (err) {
    mdRecoveryFailureCount += 1;
    mdRecoveryCooldownUntil = Date.now() + MD_RECOVERY_COOLDOWN_MS;

    console.log('[WhatsApp] Automatic linked-device recovery failed (non-fatal):', {
      attempt: mdRecoveryFailureCount,
      error: err?.message || err,
      disconnectReason: context?.disconnectReason,
    });

    if (mdRecoveryFailureCount < MD_RECOVERY_MAX_ATTEMPTS) {
      scheduleAutomaticLinkedDeviceRecovery(context);
    } else {
      scheduleReconnect();
    }
  } finally {
    mdRecoveryInProgress = false;
  }
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

function getWsDiagnostics() {
  const ws = sock?.ws;
  return {
    wsOpen: ws?.isOpen === true,
    readyState: ws?.socket?.readyState ?? null,
  };
}

function msSinceLastSend() {
  return lastSendActivityAt ? Date.now() - lastSendActivityAt : null;
}

async function runLightweightKeepalive() {
  if (!sock || !isWhatsAppReady || preventiveRefreshInProgress) return;

  const uptimeMs = getSocketUptimeMs();
  const queueState = getQueueState();
  const wsDiag = getWsDiagnostics();

  try {
    if (typeof sock.sendPresenceUpdate === 'function') {
      await sock.sendPresenceUpdate('available');
    }

    const ws = sock.ws;
    if (ws?.isOpen && ws.socket?.readyState === 1 && typeof ws.socket.ping === 'function') {
      ws.socket.ping();
    }

    console.log('[WhatsApp] Lightweight keepalive sent', {
      socketUptimeMs: uptimeMs,
      queueState,
      ...wsDiag,
    });
  } catch (err) {
    console.log('[WhatsApp] Keepalive failed:', err?.message || err, {
      socketUptimeMs: uptimeMs,
      queueState,
      ...wsDiag,
    });
  }
}

function startMdMaintenanceTimers() {
  if (mdMaintenanceTimersStarted) return;
  mdMaintenanceTimersStarted = true;

  keepaliveTimer = setInterval(() => {
    runLightweightKeepalive().catch(() => {});
  }, KEEPALIVE_INTERVAL_MS);

  fallbackRefreshTimer = setInterval(() => {
    runPreventiveSoftRefresh().catch((err) => {
      console.log(
        '[WhatsApp] Fallback soft refresh error (non-fatal):',
        err?.message || err
      );
    });
  }, FALLBACK_REFRESH_INTERVAL_MS);
}

async function runPreventiveSoftRefresh() {
  const uptimeMs = getSocketUptimeMs();
  const queueState = getQueueState();
  const idleSinceSendMs = msSinceLastSend();

  if (!isSendQueueIdle()) {
    console.log('[WhatsApp] Fallback soft refresh skipped (active send / queue busy):', {
      socketUptimeMs: uptimeMs,
      queueState,
      idleSinceSendMs,
    });
    return;
  }

  if (preventiveRefreshInProgress || socketInitializing || isConnecting) {
    console.log('[WhatsApp] Fallback soft refresh skipped (lifecycle busy):', {
      socketUptimeMs: uptimeMs,
      queueState,
      preventiveRefreshInProgress,
      socketInitializing,
      isConnecting,
    });
    return;
  }

  if (!sock || !isWhatsAppReady) {
    console.log('[WhatsApp] Fallback soft refresh skipped (no active ready socket):', {
      socketUptimeMs: uptimeMs,
      queueState,
    });
    return;
  }

  if (uptimeMs < MIN_SOCKET_UPTIME_FOR_FALLBACK_MS) {
    console.log('[WhatsApp] Fallback soft refresh skipped (uptime too short):', {
      socketUptimeMs: uptimeMs,
      requiredUptimeMs: MIN_SOCKET_UPTIME_FOR_FALLBACK_MS,
      queueState,
    });
    return;
  }

  if (
    lastSendActivityAt &&
    idleSinceSendMs !== null &&
    idleSinceSendMs < MIN_IDLE_SINCE_SEND_FOR_FALLBACK_MS
  ) {
    console.log('[WhatsApp] Fallback soft refresh skipped (recent send activity):', {
      socketUptimeMs: uptimeMs,
      idleSinceSendMs,
      requiredIdleMs: MIN_IDLE_SINCE_SEND_FOR_FALLBACK_MS,
      queueState,
    });
    return;
  }

  console.log('[WhatsApp] Preventive soft refresh starting', {
    socketUptimeMs: uptimeMs,
    queueState,
    idleSinceSendMs,
    reason: 'rare-fallback',
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
      mode: 'rare-fallback',
    });
  } catch (err) {
    console.log(
      '[WhatsApp] Fallback soft refresh failed (non-fatal):',
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
      clearMdRecoveryTimer();
      mdRecoveryFailureCount = 0;
      mdRecoveryCooldownUntil = 0;
      isConnecting = false;
      socketInitializing = false;
      socketConnectedAt = Date.now();
      console.log(hadSession ? '[WhatsApp] Session restored' : '[WhatsApp] Connected');
      console.log('[WhatsApp] Post-connect warmup (linked-device sync)...');
      await new Promise((r) => setTimeout(r, POST_CONNECT_WARMUP_MS));
      isWhatsAppReady = true;
      console.log('[WhatsApp] Ready for messaging');
      startMdMaintenanceTimers();
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

      if (mdRecoveryInProgress) {
        return;
      }

      if (!shouldReconnect) {
        // Logged out: do not spam reconnect. User must re-pair.
        console.log('[WhatsApp] Logged out. Delete /baileys_auth and re-pair if needed.');
        return;
      }

      if (isRecoverableMdDisconnect(statusCode)) {
        const recoveryContext = {
          statusCode,
          disconnectReason: disconnectReasonLabel(statusCode),
          socketUptimeMs: getSocketUptimeMs(),
          idleSinceSendMs: msSinceLastSend(),
          likelyPhoneOffline: likelyPhoneOffline(),
          lastDisconnectMessage: lastDisconnect?.error?.message || null,
        };
        console.log('[WhatsApp] Recoverable MD disconnect detected', recoveryContext);
        scheduleAutomaticLinkedDeviceRecovery(recoveryContext);
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
        await runPreSendSessionRevalidation(sock, jid, {
          socketUptimeMs: getSocketUptimeMs(),
          queueState: getQueueState(),
          idleSinceSendMs: msSinceLastSend(),
        });
        await sock.presenceSubscribe(jid);
        await new Promise((r) => setTimeout(r, DELIVERY_WARMUP_MS));
        const res = await sock.sendMessage(jid, { text: String(message ?? '') });
        lastSendActivityAt = Date.now();
        noteSendSuccess(jid);
        const id = res?.key?.id || res?.messageTimestamp || 'unknown';
        return { id: { id }, key: res?.key, _raw: res };
      });
    },
  };
}

async function startWhatsAppClient() {
  if (isWhatsAppReady || preventiveRefreshInProgress || mdRecoveryInProgress) return;

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
