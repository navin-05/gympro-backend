const fs = require('fs');
const path = require('path');

const RENDER_PERSISTENT_CHROME_CACHE = '/opt/render/project/.chrome-cache';

if (!process.env.PUPPETEER_CACHE_DIR && fs.existsSync('/opt/render/project')) {
  process.env.PUPPETEER_CACHE_DIR = RENDER_PERSISTENT_CHROME_CACHE;
}

const QRCode = require('qrcode');
const puppeteer = require('puppeteer');
const { Client, LocalAuth } = require('whatsapp-web.js');
const http = require('http');

const DEBUG_INGEST = 'http://127.0.0.1:7436/ingest/5a101aa9-c48e-4af0-8939-73dc44d4c0e8';
const DEBUG_SESSION_ID = 'da54d2';
const DEBUG_LOG_PATH = path.resolve(__dirname, '..', '..', '..', 'debug-da54d2.log');
function debugLog({ runId, hypothesisId, location, message, data }) {
  // #region agent log
  try {
    const payload = JSON.stringify({
      sessionId: DEBUG_SESSION_ID,
      runId,
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    });

    // Always write a local NDJSON line as fallback (works on VPS too).
    try {
      fs.appendFileSync(DEBUG_LOG_PATH, `${payload}\n`, 'utf8');
    } catch (_) {}

    const u = new URL(DEBUG_INGEST);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'X-Debug-Session-Id': DEBUG_SESSION_ID,
        },
      },
      (res) => {
        res.resume();
      }
    );
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch (_) {}
  // #endregion
}

const STATE = {
  IDLE: 'idle',
  INITIALIZING: 'initializing',
  READY: 'ready',
  FAILED: 'failed',
  DISCONNECTED: 'disconnected',
};

/** Ready wait after QR — allow sync beyond authTimeoutMs without killing the process */
const CLIENT_READY_TIMEOUT_MS = 300000;

const PUPPETEER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--single-process',
  '--no-zygote',
];

let client = null;
let state = STATE.IDLE;
let initPromise = null;
let startupInitStarted = false;

const AUTH_DIR = path.resolve(__dirname, '..', '.wwebjs_auth');
const AUTH_LOCKFILE = path.join(AUTH_DIR, 'session', 'lockfile');

function tryCleanupStaleAuthLockfile() {
  // #region agent log
  try {
    if (fs.existsSync(AUTH_LOCKFILE)) {
      try {
        fs.rmSync(AUTH_LOCKFILE, { force: true });
        debugLog({
          runId: 'pre-fix',
          hypothesisId: 'B',
          location: 'backend/services/whatsappClient.js:tryCleanupStaleAuthLockfile',
          message: 'Removed stale auth lockfile (best-effort)',
          data: { lockfile: AUTH_LOCKFILE },
        });
      } catch (e) {
        debugLog({
          runId: 'pre-fix',
          hypothesisId: 'B',
          location: 'backend/services/whatsappClient.js:tryCleanupStaleAuthLockfile',
          message: 'Failed to remove auth lockfile (best-effort)',
          data: { lockfile: AUTH_LOCKFILE, error: String(e?.message || e || '') },
        });
      }
    }
  } catch (_) {}
  // #endregion
}

function getWhatsAppState() {
  return state;
}

function isWhatsAppReady() {
  return state === STATE.READY && client != null;
}

function isBrowserCrashError(err) {
  const msg = String(err?.message || err || '');
  return /Target closed|Session closed|Protocol error|Browser closed|crashed/i.test(msg);
}

function attachClientEvents(c) {
  c.on('qr', async (qr) => {
    console.log('[WhatsApp] QR generated — scan with admin account (first-time setup only)');
    debugLog({
      runId: 'pre-fix',
      hypothesisId: 'B',
      location: 'backend/services/whatsappClient.js:qr',
      message: 'QR generated',
      data: { state, authDir: AUTH_DIR, cwd: process.cwd(), rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024) },
    });
    try {
      console.log(await QRCode.toString(qr, { type: 'terminal', small: true }));
    } catch (err) {
      console.log('[WhatsApp] QR terminal render failed:', err.message);
    }
  });

  c.on('code', () => {
    console.log('[WhatsApp] QR scanned — pairing code flow started');
  });

  c.on('loading_screen', (percent, message) => {
    console.log('[WhatsApp] QR scanned / auth sync in progress:', percent, message || '');
    debugLog({
      runId: 'pre-fix',
      hypothesisId: 'A',
      location: 'backend/services/whatsappClient.js:loading_screen',
      message: 'Loading screen progress',
      data: { percent, message: message || '', rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024) },
    });
  });

  c.on('authenticated', () => {
    console.log('[WhatsApp] Auth completion: authenticated (sync may still be running)');
    debugLog({
      runId: 'pre-fix',
      hypothesisId: 'B',
      location: 'backend/services/whatsappClient.js:authenticated',
      message: 'Authenticated event fired',
      data: { authDir: AUTH_DIR, cwd: process.cwd() },
    });
  });

  c.on('ready', () => {
    state = STATE.READY;
    console.log('[WhatsApp] Client ready state: ready — automated messages can be sent');
    debugLog({
      runId: 'pre-fix',
      hypothesisId: 'B',
      location: 'backend/services/whatsappClient.js:ready',
      message: 'Ready event fired',
      data: { state, authDir: AUTH_DIR, rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024) },
    });
  });

  c.on('auth_failure', (msg) => {
    state = STATE.FAILED;
    console.error('[WhatsApp] Auth timeout/failure reason:', msg);
    debugLog({
      runId: 'pre-fix',
      hypothesisId: 'E',
      location: 'backend/services/whatsappClient.js:auth_failure',
      message: 'Auth failure event fired',
      data: { msg: String(msg || ''), state, authDir: AUTH_DIR },
    });
  });

  c.on('change_state', (waState) => {
    console.log('[WhatsApp] Auth state change:', waState);
  });

  c.on('disconnected', (reason) => {
    state = STATE.DISCONNECTED;
    console.log('[WhatsApp] Disconnected:', reason);
    debugLog({
      runId: 'pre-fix',
      hypothesisId: 'C',
      location: 'backend/services/whatsappClient.js:disconnected',
      message: 'Disconnected event fired',
      data: { reason: String(reason || ''), state, rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024) },
    });
    if (isBrowserCrashError(reason)) {
      console.error('[WhatsApp] Browser crash detected (disconnect):', reason);
    }
    console.log('[WhatsApp] Shared client offline; restart server to re-initialize (no auto-relaunch)');
  });
}

async function resolvePuppeteerExecutablePath() {
  console.log('[WhatsApp] PUPPETEER_CACHE_DIR:', process.env.PUPPETEER_CACHE_DIR || '(default)');

  const executablePath = await puppeteer.executablePath();
  const binaryExists = fs.existsSync(executablePath);

  console.log('[WhatsApp] Resolved executablePath:', executablePath);
  console.log('[WhatsApp] Chrome binary exists:', binaryExists);

  if (!binaryExists) {
    throw new Error(
      `Chrome binary not found at ${executablePath}. `
      + 'Run: PUPPETEER_CACHE_DIR=/opt/render/project/.chrome-cache npx puppeteer browsers install chrome'
    );
  }

  return executablePath;
}

function createClient(executablePath) {
  return new Client({
    authStrategy: new LocalAuth({
      dataPath: AUTH_DIR,
    }),
    qrMaxRetries: 2,
    authTimeoutMs: 180000,
    webVersionCache: {
      type: 'none',
    },
    puppeteer: {
      executablePath,
      headless: true,
      args: PUPPETEER_ARGS,
    },
  });
}

function runStartupInitialization() {
  return (async () => {
    console.log('[WhatsApp] Initialization start (single global instance, background)');
    debugLog({
      runId: 'pre-fix',
      hypothesisId: 'B',
      location: 'backend/services/whatsappClient.js:runStartupInitialization',
      message: 'Startup init begin',
      data: { cwd: process.cwd(), authDir: AUTH_DIR, rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024) },
    });

    // #region agent log
    try {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
      fs.accessSync(AUTH_DIR, fs.constants.R_OK | fs.constants.W_OK);
      debugLog({
        runId: 'pre-fix',
        hypothesisId: 'B',
        location: 'backend/services/whatsappClient.js:authDirAccess',
        message: 'Auth dir ok (read/write)',
        data: { authDir: AUTH_DIR },
      });
    } catch (e) {
      debugLog({
        runId: 'pre-fix',
        hypothesisId: 'B',
        location: 'backend/services/whatsappClient.js:authDirAccess',
        message: 'Auth dir NOT writable/readable',
        data: { authDir: AUTH_DIR, error: String(e?.message || e || '') },
      });
    }
    // #endregion
    tryCleanupStaleAuthLockfile();

    const executablePath = await resolvePuppeteerExecutablePath();

    if (!client) {
      client = createClient(executablePath);
      attachClientEvents(client);
    } else {
      console.log('[WhatsApp] Duplicate browser create prevented — reusing instance');
    }

    if (state === STATE.READY) {
      console.log('[WhatsApp] Client already ready — skipping initialize()');
      return client;
    }

    try {
      await new Promise((resolve, reject) => {
        const readyTimeout = setTimeout(() => {
          state = STATE.FAILED;
          const err = new Error('WhatsApp client ready timeout after auth/sync window');
          console.error('[WhatsApp] Auth timeout reason (ready):', err.message);
          reject(err);
        }, CLIENT_READY_TIMEOUT_MS);

        const onReady = () => {
          clearTimeout(readyTimeout);
          state = STATE.READY;
          resolve(client);
        };

        client.once('ready', onReady);
        client.initialize().catch((err) => {
          clearTimeout(readyTimeout);
          state = STATE.FAILED;
          debugLog({
            runId: 'pre-fix',
            hypothesisId: isBrowserCrashError(err) ? 'C' : 'D',
            location: 'backend/services/whatsappClient.js:initialize.catch',
            message: 'initialize() rejected',
            data: { error: String(err?.message || err || ''), state },
          });
          if (isBrowserCrashError(err)) {
            console.error('[WhatsApp] Browser crash detected (initialize):', err.message);
          }
          if (/auth|timeout|Timeout/i.test(String(err.message))) {
            console.error('[WhatsApp] Auth timeout reason (initialize):', err.message);
          }
          reject(err);
        });
      });
    } catch (error) {
      console.error(
        '[WhatsApp] Initialization failed (non-fatal, server continues):',
        error.message
      );
      debugLog({
        runId: 'pre-fix',
        hypothesisId: isBrowserCrashError(error) ? 'C' : 'D',
        location: 'backend/services/whatsappClient.js:runStartupInitialization.catch',
        message: 'Startup initialization failed',
        data: { error: String(error?.message || error || ''), state },
      });
      return null;
    }

    return client;
  })();
}

/**
 * Start WhatsApp once at server startup (non-blocking). Do not call from routes/cron/send.
 */
function startWhatsAppClient() {
  if (startupInitStarted) {
    console.log('[WhatsApp] Duplicate initialization prevented — startup already began');
    return initPromise || Promise.resolve(client);
  }

  startupInitStarted = true;
  state = STATE.INITIALIZING;
  console.log('[WhatsApp] Startup initialization scheduled (background)');
  // #region agent log
  try {
    process.once('SIGTERM', () => {
      debugLog({
        runId: 'pre-fix',
        hypothesisId: 'A',
        location: 'backend/services/whatsappClient.js:process.SIGTERM',
        message: 'Process received SIGTERM',
        data: { rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024) },
      });
    });
    process.once('SIGINT', () => {
      debugLog({
        runId: 'pre-fix',
        hypothesisId: 'A',
        location: 'backend/services/whatsappClient.js:process.SIGINT',
        message: 'Process received SIGINT',
        data: { rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024) },
      });
    });
    process.once('exit', (code) => {
      debugLog({
        runId: 'pre-fix',
        hypothesisId: 'A',
        location: 'backend/services/whatsappClient.js:process.exit',
        message: 'Process exit',
        data: { code, rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024) },
      });
    });
    process.once('uncaughtException', (err) => {
      debugLog({
        runId: 'pre-fix',
        hypothesisId: 'A',
        location: 'backend/services/whatsappClient.js:process.uncaughtException',
        message: 'Uncaught exception',
        data: { error: String(err?.message || err || '') },
      });
    });
  } catch (_) {}
  // #endregion

  initPromise = runStartupInitialization()
    .then((c) => {
      console.log('[WhatsApp] Startup initialization finished, state:', state);
      return c;
    })
    .catch((err) => {
      state = STATE.FAILED;
      console.error(
        '[WhatsApp] Startup initialization error (non-fatal, server continues):',
        err?.message || err
      );
      return null;
    });

  return initPromise;
}

/**
 * Wait for startup init without launching a new browser. Used by send only.
 */
async function waitForWhatsAppReady(maxWaitMs = 8000) {
  if (state === STATE.READY) {
    return true;
  }
  if (state === STATE.FAILED || state === STATE.DISCONNECTED) {
    return false;
  }
  if (!initPromise) {
    console.log('[WhatsApp] waitForWhatsAppReady: no startup init in progress');
    return false;
  }

  try {
    await Promise.race([
      initPromise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('waitForWhatsAppReady timeout')), maxWaitMs);
      }),
    ]);
    return state === STATE.READY;
  } catch (error) {
    console.log('[WhatsApp] waitForWhatsAppReady:', error.message, '| state:', state);
    return false;
  }
}

function getClient() {
  if (state !== STATE.READY || !client) {
    throw new Error(`[WhatsApp] Client not ready (state: ${state})`);
  }
  console.log('[WhatsApp] Reusing shared client instance for sendMessage');
  return client;
}

/** @deprecated Use startWhatsAppClient at server startup only */
function initializeWhatsAppClient() {
  console.log('[WhatsApp] initializeWhatsAppClient() — delegating to startup init (no relaunch)');
  return startWhatsAppClient();
}

module.exports = {
  STATE,
  getWhatsAppState,
  startWhatsAppClient,
  waitForWhatsAppReady,
  getClient,
  isWhatsAppReady,
  initializeWhatsAppClient,
};
