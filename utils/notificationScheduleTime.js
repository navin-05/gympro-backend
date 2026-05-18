/**
 * Parse strings like "09:00 PM" (server-local automation; 12-hour clock).
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

/** Normalize to "hh:mm AM/PM" for storage. */
function formatScheduledTimeForStorage(hour24, minute) {
  const ampm = hour24 >= 12 ? 'PM' : 'AM';
  let h12 = hour24 % 12;
  if (h12 === 0) {
    h12 = 12;
  }
  return `${String(h12).padStart(2, '0')}:${String(minute).padStart(2, '0')} ${ampm}`;
}

function getLocalDateKey(d) {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

function serverLocalTimeMatchesSchedule(now, parsed) {
  return now.getHours() === parsed.hour24 && now.getMinutes() === parsed.minute;
}

module.exports = {
  parseScheduledTime12h,
  formatScheduledTimeForStorage,
  getLocalDateKey,
  serverLocalTimeMatchesSchedule,
};
