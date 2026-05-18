const User = require('../models/User');
const { generateAndSendMembershipExpiryWhatsApp } = require('../services/membershipExpiryNotificationService');
const {
  parseScheduledTime12h,
  getLocalDateKey,
  serverLocalTimeMatchesSchedule,
} = require('../utils/notificationScheduleTime');

/**
 * Global once-per-minute tick: users with automation enabled whose scheduled
 * server-local time matches "now" receive the same WhatsApp flow as manual Generate.
 */
async function runScheduledUserNotificationsJob() {
  const now = new Date();
  const todayKey = getLocalDateKey(now);

  let users;
  try {
    users = await User.find({ 'notificationSettings.enabled': true })
      .select('_id notificationSettings')
      .lean();
  } catch (error) {
    console.error('[ScheduledNotify] Failed to load users:', error.message);
    return;
  }

  if (!users || users.length === 0) {
    return;
  }

  for (const u of users) {
    try {
      const ns = u.notificationSettings || {};
      const rawTime = ns.scheduledTime && String(ns.scheduledTime).trim()
        ? String(ns.scheduledTime).trim()
        : '09:00 PM';
      const parsed = parseScheduledTime12h(rawTime);
      if (!parsed) {
        console.log('[ScheduledNotify] Skip user (invalid time):', u._id);
        continue;
      }
      if (!serverLocalTimeMatchesSchedule(now, parsed)) {
        continue;
      }
      if (ns.lastNotificationSentDate === todayKey) {
        continue;
      }

      const outcome = await generateAndSendMembershipExpiryWhatsApp(u._id, {
        skipEmptySend: true,
      });

      if (outcome.code === 'NO_ENV') {
        continue;
      }
      if (outcome.code === 'TWILIO_FAIL') {
        console.log('[ScheduledNotify] Twilio failed for user:', u._id);
        continue;
      }

      if (outcome.code === 'SENT' || outcome.code === 'SKIPPED_EMPTY') {
        await User.updateOne(
          { _id: u._id },
          { $set: { 'notificationSettings.lastNotificationSentDate': todayKey } }
        );
      }
    } catch (error) {
      console.error('[ScheduledNotify] User tick error:', u._id, error.message);
    }
  }
}

module.exports = { runScheduledUserNotificationsJob };
