const fs = require('fs');
const path = require('path');

const RENDER_PERSISTENT_CHROME_CACHE = '/opt/render/project/.chrome-cache';

// Use persistent project cache on Render (not ephemeral /opt/render/.cache/puppeteer)
if (!process.env.PUPPETEER_CACHE_DIR && fs.existsSync('/opt/render/project')) {
  process.env.PUPPETEER_CACHE_DIR = RENDER_PERSISTENT_CHROME_CACHE;
}

const QRCode = require('qrcode');
const puppeteer = require('puppeteer');
const { Client, LocalAuth } = require('whatsapp-web.js');

let client = null;
let ready = false;
let initPromise = null;

function attachClientEvents(c) {
  c.on('qr', async (qr) => {
    console.log('[WhatsApp] QR RECEIVED');
    console.log('[WhatsApp] Scan QR with the admin WhatsApp account (first-time setup only):');
    try {
      console.log(await QRCode.toString(qr, { type: 'terminal', small: true }));
    } catch (err) {
      console.log('[WhatsApp] QR received (open logs if terminal QR fails):', err.message);
    }
  });

  c.on('authenticated', () => {
    console.log('[WhatsApp] Session authenticated');
  });

  c.on('ready', () => {
    ready = true;
    console.log('[WhatsApp] Client ready');
    console.log('[WhatsApp] Client ready — automated messages can be sent');
  });

  c.on('auth_failure', (msg) => {
    ready = false;
    console.error('[WhatsApp] Authentication failed:', msg);
  });

  c.on('disconnected', (reason) => {
    ready = false;
    initPromise = null;
    console.log('[WhatsApp] Disconnected:', reason);
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

function getClient() {
  if (!client) {
    throw new Error('[WhatsApp] Client not initialized. Call initializeWhatsAppClient() first.');
  }
  return client;
}

function isWhatsAppReady() {
  return ready;
}

function initializeWhatsAppClient() {
  if (ready) {
    return Promise.resolve(getClient());
  }
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    console.log('[WhatsApp] Initializing client...');

    let executablePath;
    try {
      executablePath = await resolvePuppeteerExecutablePath();
    } catch (error) {
      console.error('[WhatsApp] Failed to resolve executablePath:', error.message);
      throw error;
    }

    if (!client) {
      client = createClient(executablePath);
      attachClientEvents(client);
    }

    const c = client;

    if (ready) {
      return c;
    }

    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          initPromise = null;
          reject(new Error('WhatsApp client ready timeout'));
        }, 180000);

        const finish = () => {
          clearTimeout(timeout);
          resolve(c);
        };

        c.once('ready', finish);
        c.initialize().catch((err) => {
          clearTimeout(timeout);
          initPromise = null;
          reject(err);
        });
      });
    } catch (error) {
      console.error('[WhatsApp] Initialization failed:', error.message);
      throw error;
    }

    return c;
  })();

  return initPromise;
}

module.exports = {
  getClient,
  initializeWhatsAppClient,
  isWhatsAppReady,
};
