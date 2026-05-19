const User = require('../models/User');
const { generateAndSendMembershipExpiryWhatsApp } = require('../services/membershipExpiryNotificationService');
const {
  getDateKeyInTimezone,
  getZonedTimeParts,
  resolveScheduleFromNotificationSettings,
  cronTimeMatchesUserSchedule,
  wasNotificationSentToday,
  normalizeLastSentDateKey,
} = require('../utils/notificationScheduleTime');
const { debugTrace } = require('../utils/debugTrace');

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
    // #region agent log
    debugTrace('scheduledUserNotificationsJob.js:fetch', '[USER FETCH FAILED]', { error: error.message }, 'D');
    // #endregion
    return;
  }

  // #region agent log
  debugTrace('scheduledUserNotificationsJob.js:fetch', '[USER FETCHED]', {
    enabledCount: users?.length ?? 0,
    utc: now.toISOString(),
  }, 'D');
  // #endregion

  if (!users || users.length === 0) {
    return;
  }

  for (const u of users) {
    try {
      const ns = u.notificationSettings || {};
      const { scheduledHour, scheduledMinute, timezone } = resolveScheduleFromNotificationSettings(ns);
      const zonedNow = getZonedTimeParts(now, timezone);
      const todayKey = getDateKeyInTimezone(now, timezone);
      const lastKey = normalizeLastSentDateKey(ns.lastNotificationSentDate, timezone);
      const timeMatch = cronTimeMatchesUserSchedule(now, scheduledHour, scheduledMinute, timezone);
      const alreadySentToday = wasNotificationSentToday(ns.lastNotificationSentDate, now, timezone);

      const scheduleDebug = {
        userId: String(u._id),
        utc: now.toISOString(),
        timezone,
        stored: {
          scheduledHour: ns.scheduledHour,
          scheduledMinute: ns.scheduledMinute,
          scheduledTime: ns.scheduledTime,
          timezone: ns.timezone,
          lastNotificationSentDate: ns.lastNotificationSentDate,
        },
        resolved: { scheduledHour, scheduledMinute, timezone },
        userLocalNow: {
          hour: zonedNow.hour,
          minute: zonedNow.minute,
          dateKey: todayKey,
        },
        scheduledLocalTime: `${String(scheduledHour).padStart(2, '0')}:${String(scheduledMinute).padStart(2, '0')}`,
        timeMatch,
        alreadySentToday,
        lastSentNormalized: lastKey,
        willSend: timeMatch && !alreadySentToday,
      };

      console.log('[SCHEDULE CHECK]', JSON.stringify(scheduleDebug));
      debugTrace('scheduledUserNotificationsJob.js:decision', '[SCHEDULE CHECK]', scheduleDebug, 'C');

      if (!timeMatch) {
        continue;
      }
      if (alreadySentToday) {
        // #region agent log
        debugTrace('scheduledUserNotificationsJob.js:skip', '[SKIPPED - ALREADY SENT TODAY]', {
          userId: String(u._id),
          lastKey,
          todayKey,
          rawLastSent: ns.lastNotificationSentDate,
        }, 'B');
        // #endregion
        continue;
      }

      console.log('[WHATSAPP SEND START]', JSON.stringify({
        userId: String(u._id),
        todayKey,
        timeMatch,
        whatsappNotificationNumber: ns.whatsappNotificationNumber ?? null,
      }));

      // #region agent log
      debugTrace('scheduledUserNotificationsJob.js:send', '[WHATSAPP SEND START]', {
        userId: String(u._id),
        todayKey,
      }, 'G');
      // #endregion

      const outcome = await generateAndSendMembershipExpiryWhatsApp(u._id, {
        skipEmptySend: true,
      });

      // #region agent log
      debugTrace('scheduledUserNotificationsJob.js:outcome', '[WHATSAPP OUTCOME]', {
        userId: String(u._id),
        code: outcome.code,
      }, 'G');
      // #endregion

      if (outcome.code === 'NO_RECIPIENT') {
        continue;
      }
      if (outcome.code === 'WHATSAPP_FAIL') {
        console.log('[ScheduledNotify] WhatsApp send failed for user:', u._id);
        continue;
      }

      if (outcome.code === 'SENT' || outcome.code === 'SKIPPED_EMPTY') {
        const updateResult = await User.updateOne(
          { _id: u._id },
          { $set: { 'notificationSettings.lastNotificationSentDate': todayKey } }
        );
        // #region agent log
        debugTrace('scheduledUserNotificationsJob.js:update', '[LAST SENT DATE UPDATE]', {
          userId: String(u._id),
          todayKey,
          matchedCount: updateResult.matchedCount,
          modifiedCount: updateResult.modifiedCount,
          outcomeCode: outcome.code,
        }, 'E');
        // #endregion
      }
    } catch (error) {
      console.error('[ScheduledNotify] User tick error:', u._id, error.message);
      // #region agent log
      debugTrace('scheduledUserNotificationsJob.js:userError', '[USER TICK ERROR]', {
        userId: String(u._id),
        error: error.message,
      }, 'F');
      // #endregion
    }
  }
}

module.exports = { runScheduledUserNotificationsJob };
