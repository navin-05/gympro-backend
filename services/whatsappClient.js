const fs = require('fs');

const RENDER_PERSISTENT_CHROME_CACHE = '/opt/render/project/.chrome-cache';

if (!process.env.PUPPETEER_CACHE_DIR && fs.existsSync('/opt/render/project')) {
  process.env.PUPPETEER_CACHE_DIR = RENDER_PERSISTENT_CHROME_CACHE;
}

const QRCode = require('qrcode');
const puppeteer = require('puppeteer');
const { Client, LocalAuth } = require('whatsapp-web.js');

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
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--single-process',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-sync',
  '--metrics-recording-only',
  '--disable-default-apps',
];

let client = null;
let state = STATE.IDLE;
let initPromise = null;
let startupInitStarted = false;

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
  });

  c.on('authenticated', () => {
    console.log('[WhatsApp] Auth completion: authenticated (sync may still be running)');
  });

  c.on('ready', () => {
    state = STATE.READY;
    console.log('[WhatsApp] Client ready state: ready — automated messages can be sent');
  });

  c.on('auth_failure', (msg) => {
    state = STATE.FAILED;
    console.error('[WhatsApp] Auth timeout/failure reason:', msg);
  });

  c.on('change_state', (waState) => {
    console.log('[WhatsApp] Auth state change:', waState);
  });

  c.on('disconnected', (reason) => {
    state = STATE.DISCONNECTED;
    console.log('[WhatsApp] Disconnected:', reason);
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
      dataPath: './.wwebjs_auth',
    }),
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
