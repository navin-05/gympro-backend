const { Client, LocalAuth } = require('whatsapp-web.js');

// STEP 2 — readiness flag
let isWhatsAppReady = false;
let initializing = false;

// SINGLE shared client instance (do not create multiple).
const client = new Client({
  authStrategy: new LocalAuth(),
  qrMaxRetries: 2,
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  },
});

client.on('authenticated', () => {
  console.log('WhatsApp Authenticated');
});

client.on('ready', () => {
  // STEP 3 — proper ready event
  console.log('[WhatsApp] Ready');
  console.log('WhatsApp Ready');
  isWhatsAppReady = true;
  initializing = false;
});

client.on('auth_failure', (msg) => {
  console.log('WhatsApp Auth Failure:', msg);
  isWhatsAppReady = false;
  initializing = false;
});

client.on('disconnected', (reason) => {
  // STEP 4 — disconnected handler
  console.log('[WhatsApp] Disconnected:', reason);
  console.log('WhatsApp Disconnected:', reason);
  isWhatsAppReady = false;
  initializing = false;
});

function startWhatsAppClient() {
  if (isWhatsAppReady) {
    return;
  }
  if (initializing) {
    console.log('[WhatsApp] Duplicate initialization prevented (already initializing)');
    return;
  }
  initializing = true;

  try {
    console.log('[WhatsApp] Initializing...');
    // initialize() errors can be async; catch to avoid crash loops
    const p = client.initialize();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        console.log('WhatsApp Init Error:', err);
        initializing = false;
        isWhatsAppReady = false;
      });
    }
  } catch (err) {
    console.log('WhatsApp Init Error:', err);
    initializing = false;
    isWhatsAppReady = false;
  }
}

// Backward compatible getter
function isWhatsAppReadyFn() {
  return isWhatsAppReady === true;
}

function getClient() {
  return client;
}

module.exports = {
  startWhatsAppClient,
  getClient,
  isWhatsAppReady: isWhatsAppReadyFn,
  // Backward-compatible export name used elsewhere.
  initializeWhatsAppClient: () => startWhatsAppClient(),
};
