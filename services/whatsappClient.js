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

function attachClientEvents(c) {
  c.on('qr', async (qr) => {
    console.log('[WhatsApp] QR RECEIVED (auth state: awaiting scan)');
    console.log('[WhatsApp] Scan QR with the admin WhatsApp account (first-time setup only):');
    try {
      console.log(await QRCode.toString(qr, { type: 'terminal', small: true }));
    } catch (err) {
      console.log('[WhatsApp] QR received (open logs if terminal QR fails):', err.message);
    }
  });

  c.on('authenticated', () => {
    console.log('[WhatsApp] Auth state: authenticated');
  });

  c.on('ready', () => {
    state = STATE.READY;
    console.log('[WhatsApp] Client ready');
    console.log('[WhatsApp] Client ready — automated messages can be sent');
  });

  c.on('auth_failure', (msg) => {
    state = STATE.FAILED;
    console.error('[WhatsApp] Auth state: failed —', msg);
  });

  c.on('disconnected', (reason) => {
    state = STATE.DISCONNECTED;
    console.log('[WhatsApp] Auth state: disconnected —', reason);
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
    authTimeoutMs: 120000,
    puppeteer: {
      executablePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
      ],
    },
  });
}

function runStartupInitialization() {
  return (async () => {
    console.log('[WhatsApp] Initializing client (startup, single global instance)...');

    const executablePath = await resolvePuppeteerExecutablePath();

    if (!client) {
      client = createClient(executablePath);
      attachClientEvents(client);
    } else {
      console.log('[WhatsApp] Reusing existing browser instance (duplicate create prevented)');
    }

    if (state === STATE.READY) {
      console.log('[WhatsApp] Client already ready — skipping initialize()');
      return client;
    }

    await new Promise((resolve, reject) => {
      const readyTimeout = setTimeout(() => {
        state = STATE.FAILED;
        reject(new Error('WhatsApp client ready timeout'));
      }, 180000);

      const onReady = () => {
        clearTimeout(readyTimeout);
        state = STATE.READY;
        resolve(client);
      };

      client.once('ready', onReady);
      client.initialize().catch((err) => {
        clearTimeout(readyTimeout);
        state = STATE.FAILED;
        reject(err);
      });
    });

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
      console.log('[WhatsApp] Startup initialization completed, state:', state);
      return c;
    })
    .catch((err) => {
      state = STATE.FAILED;
      console.error('[WhatsApp] Startup initialization failed:', err.message);
      throw err;
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
