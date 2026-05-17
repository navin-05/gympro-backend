const cron = require('node-cron');
const { runMembershipExpiryJob } = require('../jobs/membershipExpiryJob');

// Schedule: daily at 9:00 AM
cron.schedule('0 9 * * *', async () => {
  console.log('[Cron] Triggering daily membership expiry check...');
  try {
    await runMembershipExpiryJob();
  } catch (error) {
    console.error(`[Cron] Membership expiry job failed: ${error.message}`);
  }
});

console.log('[Cron] Membership expiry cron scheduled — daily at 9:00 AM');
