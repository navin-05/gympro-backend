/**
 * Parse strings like "09:00 PM" (12-hour clock) — legacy / display only.
 * @returns {{ hour24: number, minute: number } | null}
 */
function parseScheduledTime12h(str) {
  if (!str || typeof str !== 'string') {
    return null;
  }
  const s = str.trim().replace(/\s+/g, ' ');
  const m = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) {
    return null;
  }
  const h12 = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  const ap = m[3].toUpperCase();
  if (Number.isNaN(h12) || Number.isNaN(minute) || minute < 0 || minute > 59 || h12 < 1 || h12 > 12) {
    return null;
  }
  let hour24;
  if (ap === 'AM') {
    hour24 = h12 === 12 ? 0 : h12;
  } else if (ap === 'PM') {
    hour24 = h12 === 12 ? 12 : h12 + 12;
  } else {
    return null;
  }
  return { hour24, minute };
}

/** Normalize to "hh:mm AM/PM" for display storage. */
function formatScheduledTimeForStorage(hour24, minute) {
  const ampm = hour24 >= 12 ? 'PM' : 'AM';
  let h12 = hour24 % 12;
  if (h12 === 0) {
    h12 = 12;
  }
  return `${String(h12).padStart(2, '0')}:${String(minute).padStart(2, '0')} ${ampm}`;
}

/** @returns {{ hour: number, minute: number } | null} */
function normalizeScheduledHourMinute(hour, minute) {
  const h = Number(hour);
  const m = Number(minute);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    return null;
  }
  return { hour: h, minute: m };
}

function getLocalDateKey(d) {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

/** Validate IANA timezone; fallback to UTC. */
function normalizeTimezone(tz) {
  if (!tz || typeof tz !== 'string' || !tz.trim()) {
    return 'UTC';
  }
  const trimmed = tz.trim();
  try {
    Intl.DateTimeFormat(undefined, { timeZone: trimmed });
    return trimmed;
  } catch {
    return 'UTC';
  }
}

/**
 * Current instant expressed in the user's timezone (wall clock).
 * Converts UTC server "now" → user timezone; does NOT convert user time to UTC.
 */
function getZonedTimeParts(date, timeZone) {
  const tz = normalizeTimezone(timeZone);
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date);

    const pick = (type) => {
      const p = parts.find((x) => x.type === type);
      return p ? parseInt(p.value, 10) : 0;
    };

    let hour = pick('hour');
    if (hour === 24) {
      hour = 0;
    }

    return {
      year: pick('year'),
      month: pick('month'),
      day: pick('day'),
      hour,
      minute: pick('minute'),
    };
  } catch {
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
    };
  }
}

/** Calendar date in the user's timezone (duplicate-send guard). */
function getDateKeyInTimezone(date, timeZone) {
  const p = getZonedTimeParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * Resolve numeric schedule from stored settings (preferred) or legacy string.
 * @returns {{ scheduledHour: number, scheduledMinute: number, timezone: string }}
 */
function resolveScheduleFromNotificationSettings(ns) {
  const timezone = normalizeTimezone(ns?.timezone);
  const numeric = normalizeScheduledHourMinute(ns?.scheduledHour, ns?.scheduledMinute);
  if (numeric) {
    return {
      scheduledHour: numeric.hour,
      scheduledMinute: numeric.minute,
      timezone,
    };
  }

  const rawTime = ns?.scheduledTime && String(ns.scheduledTime).trim()
    ? String(ns.scheduledTime).trim()
    : '09:00 PM';
  const parsed = parseScheduledTime12h(rawTime);
  if (parsed) {
    return {
      scheduledHour: parsed.hour24,
      scheduledMinute: parsed.minute,
      timezone,
    };
  }

  return { scheduledHour: 21, scheduledMinute: 0, timezone };
}

/**
 * Cron match: compare current wall-clock in user TZ (numbers only).
 */
function cronTimeMatchesUserSchedule(now, scheduledHour, scheduledMinute, timeZone) {
  const target = normalizeScheduledHourMinute(scheduledHour, scheduledMinute);
  if (!target) {
    return false;
  }
  const current = getZonedTimeParts(now, timeZone);
  return current.hour === target.hour && current.minute === target.minute;
}

module.exports = {
  parseScheduledTime12h,
  formatScheduledTimeForStorage,
  normalizeScheduledHourMinute,
  getLocalDateKey,
  normalizeTimezone,
  getZonedTimeParts,
  getDateKeyInTimezone,
  resolveScheduleFromNotificationSettings,
  cronTimeMatchesUserSchedule,
};
