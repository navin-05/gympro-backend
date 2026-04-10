/**
 * Per (owner, member) burst guard after member is validated.
 * Stops QR frame spam / double-submit from hitting Mongo repeatedly.
 */
const WINDOW_MS = 2500;
const recent = new Map();

function prune() {
  const now = Date.now();
  for (const [k, ts] of recent) {
    if (now - ts > 60_000) recent.delete(k);
  }
}

/**
 * @returns {{ ok: boolean }} ok false if same user+member within WINDOW_MS
 */
function recordCheckinAttempt(ownerId, memberId) {
  prune();
  const key = `${ownerId}:${memberId}`;
  const now = Date.now();
  const last = recent.get(key);
  if (last != null && now - last < WINDOW_MS) {
    return { ok: false };
  }
  recent.set(key, now);
  return { ok: true };
}

module.exports = { recordCheckinAttempt, WINDOW_MS };
