const { jidEncode, proto } = require('@whiskeysockets/baileys');

const SESSION_RECOVERY_COOLDOWN_MS = 45000;
const sessionDiagnostics = new Map();

const LIBSIGNAL_NOISE_RE =
  /Closing session:\s*SessionEntry|Closing open session in favor of incoming prekey bundle|Failed to decrypt message with any known session|Session error:|Bad MAC/i;

let guardsInstalled = false;

function normalizePeerJid(jid) {
  if (!jid) return null;
  const userPart = String(jid).split('@')[0] || '';
  const digits = userPart.split(':')[0].replace(/\D/g, '');
  return digits ? `${digits}@s.whatsapp.net` : String(jid);
}

function getSessionDiag(jid) {
  const key = normalizePeerJid(jid);
  if (!sessionDiagnostics.has(key)) {
    sessionDiagnostics.set(key, {
      failures: 0,
      lastFailureAt: null,
      lastFailureReason: null,
      lastRecoveryAt: null,
      recoveryAttempts: 0,
      lastSendSuccessAt: null,
      needsRecovery: false,
    });
  }
  return { key, diag: sessionDiagnostics.get(key) };
}

function noteDecryptFailure(jid, reason, { fromMe = false } = {}) {
  const peerJid = normalizePeerJid(jid);
  if (!peerJid) return;

  if (fromMe) {
    console.log('[WhatsApp][session][info] Self-echo decrypt (ignored, no recovery):', {
      jid: peerJid,
      reason: String(reason || '').slice(0, 160),
    });
    return;
  }

  const { diag } = getSessionDiag(peerJid);
  diag.failures += 1;
  diag.lastFailureAt = Date.now();
  diag.lastFailureReason = String(reason || '').slice(0, 200);
  diag.needsRecovery = true;

  console.log('[WhatsApp][session] Decrypt instability noted (non-fatal, per-JID tracking):', {
    jid: peerJid,
    failures: diag.failures,
    reason: diag.lastFailureReason,
  });
}

function noteSendSuccess(jid) {
  const peerJid = normalizePeerJid(jid);
  if (!peerJid) return;

  const { diag } = getSessionDiag(peerJid);
  const hadPriorFailure = diag.failures > 0 || diag.needsRecovery;

  diag.lastSendSuccessAt = Date.now();
  diag.needsRecovery = false;

  if (hadPriorFailure) {
    console.log('[WhatsApp][session] Send OK after prior decrypt issues — monitor recipient decrypt:', {
      jid: peerJid,
      priorFailures: diag.failures,
      lastRecoveryAt: diag.lastRecoveryAt,
      recoveryAttempts: diag.recoveryAttempts,
    });
  }
}

function installLibsignalLogGuards() {
  if (guardsInstalled) return;
  guardsInstalled = true;

  const _info = console.info.bind(console);
  const _warn = console.warn.bind(console);
  const _error = console.error.bind(console);

  const isNoise = (text) => LIBSIGNAL_NOISE_RE.test(text);

  console.info = (...args) => {
    const text = args.map((a) => String(a)).join(' ');
    if (isNoise(text)) {
      console.log('[WhatsApp][session][info] libsignal (non-fatal):', text.slice(0, 200));
      return;
    }
    _info(...args);
  };

  console.warn = (...args) => {
    const text = args.map((a) => String(a)).join(' ');
    if (isNoise(text)) {
      console.log('[WhatsApp][session][info] libsignal (non-fatal):', text.slice(0, 200));
      return;
    }
    _warn(...args);
  };

  console.error = (...args) => {
    const text = args.map((a) => String(a)).join(' ');
    if (isNoise(text)) {
      console.log('[WhatsApp][session][info] libsignal decrypt noise (non-fatal):', text.slice(0, 240));
      return;
    }
    _error(...args);
  };
}

async function collectDeviceJids(sock, jid) {
  const jids = [jid];
  if (typeof sock.getUSyncDevices !== 'function') return jids;

  try {
    const devices = await sock.getUSyncDevices([jid], false, true);
    for (const { user, device } of devices) {
      jids.push(jidEncode(user, 's.whatsapp.net', device));
    }
  } catch (e) {
    console.log('[WhatsApp][session] getUSyncDevices skipped (non-fatal):', jid, e?.message || e);
  }

  return [...new Set(jids)];
}

async function lightweightSessionRecovery(sock, jid) {
  if (!sock || typeof sock.assertSessions !== 'function') return false;

  const { key: peerJid, diag } = getSessionDiag(jid);
  const now = Date.now();

  if (diag.lastRecoveryAt && now - diag.lastRecoveryAt < SESSION_RECOVERY_COOLDOWN_MS) {
    console.log('[WhatsApp][session] Recovery cooldown active:', { jid: peerJid });
    return false;
  }

  console.log('[WhatsApp][session] Per-JID recovery start (no socket/auth reset):', {
    jid: peerJid,
    failures: diag.failures,
    lastFailureAt: diag.lastFailureAt,
  });

  try {
    const deviceJids = await collectDeviceJids(sock, peerJid);
    await sock.assertSessions(deviceJids, true);
    diag.lastRecoveryAt = now;
    diag.recoveryAttempts += 1;
    console.log('[WhatsApp][session] Per-JID recovery complete:', {
      jid: peerJid,
      deviceCount: deviceJids.length,
      recoveryAttempts: diag.recoveryAttempts,
    });
    return true;
  } catch (e) {
    console.log('[WhatsApp][session] Per-JID recovery failed (non-fatal):', peerJid, e?.message || e);
    return false;
  }
}

async function maybeRecoverBeforeSend(sock, jid) {
  const { diag } = getSessionDiag(jid);
  if (!diag.needsRecovery && diag.failures === 0) return;
  await lightweightSessionRecovery(sock, jid);
}

function attachMessageSessionDiagnostics(sock) {
  const cipherStub = proto.WebMessageInfo.StubType.CIPHERTEXT;

  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const msg of messages || []) {
      const remoteJid = msg?.key?.remoteJid;
      if (!remoteJid) continue;

      const stubParams = (msg.messageStubParameters || []).join(' ');
      const stubDecrypt =
        msg.messageStubType === cipherStub ||
        (!msg.message && msg.messageStubType != null) ||
        /Bad MAC|decrypt|SessionError/i.test(stubParams);

      if (!stubDecrypt) continue;

      noteDecryptFailure(remoteJid, stubParams || `stub:${msg.messageStubType}`, {
        fromMe: !!msg.key?.fromMe,
      });
    }
  });
}

module.exports = {
  installLibsignalLogGuards,
  attachMessageSessionDiagnostics,
  maybeRecoverBeforeSend,
  noteSendSuccess,
  normalizePeerJid,
};
