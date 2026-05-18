const User = require('../models/User');
const { generateAndSendMembershipExpiryWhatsApp } = require('../services/membershipExpiryNotificationService');
const {
  getDateKeyInTimezone,
  resolveScheduleFromNotificationSettings,
  cronTimeMatchesUserSchedule,
} = require('../utils/notificationScheduleTime');

/**
 * Global once-per-minute tick: compare UTC "now" → user timezone wall clock
 * against stored scheduledHour / scheduledMinute (numeric only).
 */
async function runScheduledUserNotificationsJob() {
  const now = new Date();

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
      const { scheduledHour, scheduledMinute, timezone } = resolveScheduleFromNotificationSettings(ns);
      const todayKey = getDateKeyInTimezone(now, timezone);

      if (!cronTimeMatchesUserSchedule(now, scheduledHour, scheduledMinute, timezone)) {
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
