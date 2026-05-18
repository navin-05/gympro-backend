const cron = require('node-cron');
const { runMembershipExpiryJob } = require('../jobs/membershipExpiryJob');
const { runScheduledUserNotificationsJob } = require('../jobs/scheduledUserNotificationsJob');

// Schedule: daily at 9:00 AM
cron.schedule('0 9 * * *', async () => {
  console.log('[Cron] Triggering daily membership expiry check...');
  try {
    await runMembershipExpiryJob();
  } catch (error) {
    console.error(`[Cron] Membership expiry job failed: ${error.message}`);
  }
});

// Per-user automated WhatsApp: single global job, server-local time match
cron.schedule('* * * * *', async () => {
  try {
    await runScheduledUserNotificationsJob();
  } catch (error) {
    console.error(`[Cron] Scheduled user notifications failed: ${error.message}`);
  }
});

console.log('[Cron] Membership expiry cron scheduled — daily at 9:00 AM');
console.log('[Cron] Per-user WhatsApp automation — every minute (server local time)');
