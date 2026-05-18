/**
 * Local verification: simulates day-1 send + day-2 re-send decision chain.
 * Writes to debug-caa0a5.log via debugTrace.
 */
const path = require('path');
process.chdir(path.join(__dirname, '..', '..'));

const {
  cronTimeMatchesUserSchedule,
  wasNotificationSentToday,
  getDateKeyInTimezone,
} = require('../utils/notificationScheduleTime');
const { debugTrace } = require('../utils/debugTrace');

const tz = 'Asia/Kolkata';
const scheduledHour = 21;
const scheduledMinute = 0;

const day1 = new Date('2026-05-18T15:30:00.000Z'); // 9:00 PM IST
const day2 = new Date('2026-05-19T15:30:00.000Z');
const day2Late = new Date('2026-05-19T15:33:00.000Z'); // 9:03 PM IST (grace)

let lastSent = null;

function tick(label, now) {
  const timeMatch = cronTimeMatchesUserSchedule(now, scheduledHour, scheduledMinute, tz);
  const blocked = wasNotificationSentToday(lastSent, now, tz);
  const wouldSend = timeMatch && !blocked;
  debugTrace('verifyCronDailyFlow.js', label, {
    utc: now.toISOString(),
    timeMatch,
    blocked,
    wouldSend,
    lastSent,
    todayKey: getDateKeyInTimezone(now, tz),
  }, 'verify');
  if (wouldSend) {
    lastSent = getDateKeyInTimezone(now, tz);
  }
  return wouldSend;
}

tick('day1-9pm', day1);
tick('day1-9pm-retry-same-day', day1);
tick('day2-9pm', day2);
tick('day2-9:03pm-grace', day2Late);

console.log('Verification complete. See debug-caa0a5.log');
