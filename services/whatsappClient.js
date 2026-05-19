const path = require('path');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const AUTH_PATH = process.env.WWEBJS_AUTH_PATH
  || path.join(__dirname, '..', '.wwebjs_auth');

let client = null;
let ready = false;
let initPromise = null;

function getClient() {
  if (!client) {
    client = new Client({
      authStrategy: new LocalAuth({ dataPath: AUTH_PATH }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
    });

    client.on('qr', async (qr) => {
      console.log('[WhatsApp] Scan QR with the admin WhatsApp account (first-time setup only):');
      try {
        console.log(await QRCode.toString(qr, { type: 'terminal', small: true }));
      } catch (err) {
        console.log('[WhatsApp] QR received (open logs if terminal QR fails):', err.message);
      }
    });

    client.on('authenticated', () => {
      console.log('[WhatsApp] Session authenticated');
    });

    client.on('ready', () => {
      ready = true;
      console.log('[WhatsApp] Client ready — automated messages can be sent');
    });

    client.on('auth_failure', (msg) => {
      ready = false;
      console.error('[WhatsApp] Authentication failed:', msg);
    });

    client.on('disconnected', (reason) => {
      ready = false;
      initPromise = null;
      console.log('[WhatsApp] Disconnected:', reason);
    });
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

  const c = getClient();
  initPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      initPromise = null;
      reject(new Error('WhatsApp client ready timeout'));
    }, 180000);

    const finish = () => {
      clearTimeout(timeout);
      resolve(c);
    };

    if (ready) {
      finish();
      return;
    }

    c.once('ready', finish);
    c.initialize().catch((err) => {
      clearTimeout(timeout);
      initPromise = null;
      reject(err);
    });
  });

  return initPromise;
}

module.exports = {
  getClient,
  initializeWhatsAppClient,
  isWhatsAppReady,
};
