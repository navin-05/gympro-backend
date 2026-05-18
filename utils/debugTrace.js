const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, '..', '..', 'debug-caa0a5.log');
const INGEST = 'http://127.0.0.1:7436/ingest/5a101aa9-c48e-4af0-8939-73dc44d4c0e8';
const SESSION_ID = 'caa0a5';

/**
 * Temporary cron debug trace (session caa0a5). Remove after root cause confirmed.
 */
function debugTrace(location, message, data = {}, hypothesisId = '') {
  const payload = {
    sessionId: SESSION_ID,
    timestamp: Date.now(),
    location,
    message,
    data,
    hypothesisId,
  };
  try {
    fs.appendFileSync(LOG_PATH, `${JSON.stringify(payload)}\n`);
  } catch {
    // ignore file errors
  }
  console.log(`[debug ${hypothesisId}]`, message, JSON.stringify(data));
  // #region agent log
  fetch(INGEST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': SESSION_ID },
    body: JSON.stringify(payload),
  }).catch(() => {});
  // #endregion
}

module.exports = { debugTrace };
