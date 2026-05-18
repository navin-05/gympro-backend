const mongoose = require('mongoose');
const { runScheduledUserNotificationsJob } = require('../jobs/scheduledUserNotificationsJob');

let lastRunAt = 0;
let running = false;
const MIN_INTERVAL_MS = 55 * 1000;

/**
 * Run the same per-user schedule check as the minute cron (debounced).
 * Used when Render wakes via health pings, API traffic, or after saving automation.
 */
async function triggerScheduledNotificationsIfDue(source = 'unknown') {
  if (mongoose.connection.readyState !== 1) {
    return;
  }
  const now = Date.now();
  if (running || now - lastRunAt < MIN_INTERVAL_MS) {
    return;
  }
  running = true;
  lastRunAt = now;
  try {
    // #region agent log
    const { debugTrace } = require('./debugTrace');
    debugTrace('triggerScheduledNotifications.js', '[SCHEDULE TRIGGER]', { source }, 'A');
    // #endregion
    await runScheduledUserNotificationsJob();
  } catch (error) {
    console.error('[ScheduledNotify] Trigger failed:', error.message);
  } finally {
    running = false;
  }
}

module.exports = { triggerScheduledNotificationsIfDue };
