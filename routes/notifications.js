const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Member = require('../models/Member');
const auth = require('../middleware/auth');
const {
  classifyMembersByExpiry,
  generateAndSendMembershipExpiryWhatsApp,
} = require('../services/membershipExpiryNotificationService');
const {
  parseScheduledTime12h,
  formatScheduledTimeForStorage,
  normalizeTimezone,
  normalizeScheduledHourMinute,
} = require('../utils/notificationScheduleTime');

// GET /api/notifications
// Returns expiring and expired members for the authenticated owner
router.get('/', auth, async (req, res) => {
  try {
    console.log('GET /api/notifications');
    console.log('REQ USER:', req.user);
    console.log('USER ID:', req.user?._id);

    if (!req.user || !req.user._id) {
      return res.status(401).json({ error: 'User not authenticated', debug: 'Missing req.user or req.user._id' });
    }

    const ownerId = new mongoose.Types.ObjectId(req.user._id);

    const members = await Member.find({ owner: ownerId }).lean();

    console.log('TOTAL MEMBERS FOUND:', members.length);
    console.log('FIRST MEMBER:', members[0]);

    if (!members || members.length === 0) {
      return res.json({
        debug: 'No members found for this user',
        userId: req.user._id
      });
    }

    console.log('EXPIRY TYPE:', typeof members[0]?.expiryDate);
    console.log('EXPIRY VALUE:', members[0]?.expiryDate);

    const { expiring, expired } = classifyMembersByExpiry(members);

    console.log('FINAL EXPIRING:', expiring.length);
    console.log('FINAL EXPIRED:', expired.length);

    return res.json({
      expiring,
      expired
    });
  } catch (error) {
    console.error('ERROR IN GET /api/notifications:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// PUT /api/notifications/automation — WhatsApp automation schedule (per user)
router.put('/automation', auth, async (req, res) => {
  try {
    const { enabled, scheduledHour, scheduledMinute, scheduledTime, timezone } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }

    let hourMinute = normalizeScheduledHourMinute(scheduledHour, scheduledMinute);
    if (!hourMinute && typeof scheduledTime === 'string' && scheduledTime.trim()) {
      const parsed = parseScheduledTime12h(scheduledTime);
      if (parsed) {
        hourMinute = { hour: parsed.hour24, minute: parsed.minute };
      }
    }
    if (!hourMinute) {
      return res.status(400).json({
        error: 'scheduledHour and scheduledMinute (0–23, 0–59) are required',
      });
    }

    const normalizedTz = normalizeTimezone(
      typeof timezone === 'string' ? timezone : undefined
    );
    const displayTime = formatScheduledTimeForStorage(hourMinute.hour, hourMinute.minute);

    if (!req.user.notificationSettings) {
      req.user.notificationSettings = {};
    }
    req.user.notificationSettings.enabled = enabled;
    req.user.notificationSettings.scheduledHour = hourMinute.hour;
    req.user.notificationSettings.scheduledMinute = hourMinute.minute;
    req.user.notificationSettings.scheduledTime = displayTime;
    req.user.notificationSettings.timezone = normalizedTz;
    // Reset daily guard so a new/changed schedule is not blocked by a prior send date
    req.user.notificationSettings.lastNotificationSentDate = null;
    await req.user.save();

    // #region agent log
    const { debugTrace } = require('../utils/debugTrace');
    debugTrace('notifications.js:automation', '[AUTOMATION SAVED]', {
      userId: String(req.user._id),
      enabled,
      scheduledHour: hourMinute.hour,
      scheduledMinute: hourMinute.minute,
      timezone: normalizedTz,
      displayTime,
      lastNotificationSentDate: req.user.notificationSettings.lastNotificationSentDate ?? null,
    }, 'J');
    // #endregion

    return res.json({
      success: true,
      notificationSettings: {
        enabled: req.user.notificationSettings.enabled,
        scheduledHour: req.user.notificationSettings.scheduledHour,
        scheduledMinute: req.user.notificationSettings.scheduledMinute,
        scheduledTime: req.user.notificationSettings.scheduledTime,
        timezone: req.user.notificationSettings.timezone,
        lastNotificationSentDate: req.user.notificationSettings.lastNotificationSentDate ?? null,
      },
    });
  } catch (error) {
    console.error('ERROR IN PUT /api/notifications/automation:', error);
    return res.status(500).json({ success: false, message: error.message || 'Internal server error' });
  }
});

// POST /api/notifications/generate
// Scans members and returns expiring / expired summary (no cron dependency)
router.post('/generate', auth, async (req, res) => {
  try {
    console.log('POST /api/notifications/generate');
    console.log('REQ USER:', req.user);
    console.log('USER ID:', req.user?._id);

    if (!req.user || !req.user._id) {
      return res.status(401).json({ error: 'User not authenticated', debug: 'Missing req.user or req.user._id' });
    }

    const result = await generateAndSendMembershipExpiryWhatsApp(req.user._id, {
      skipEmptySend: false,
    });

    if (result.code === 'NO_ENV') {
      return res.json({ success: false, message: 'GYM_NOTIFICATION_WHATSAPP not configured' });
    }
    if (result.code === 'SENT') {
      return res.json({ success: true, message: 'WhatsApp notification sent successfully' });
    }
    return res.json({ success: false, message: 'Failed to send WhatsApp notification' });
  } catch (error) {
    console.error('ERROR IN POST /api/notifications/generate:', error);
    return res.status(500).json({ success: false, message: error.message || 'Internal server error' });
  }
});

module.exports = router;
