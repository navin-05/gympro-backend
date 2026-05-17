const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Member = require('../models/Member');
const auth = require('../middleware/auth');
const { sendWhatsAppMessage } = require('../services/whatsappService');

// Helper to classify members into expiring / expired based on expiryDate
const classifyMembersByExpiry = (members) => {
  const expiring = [];
  const expired = [];

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const member of members) {
    if (!member.expiryDate) {
      continue;
    }

    const expiry = new Date(member.expiryDate);
    if (isNaN(expiry)) {
      console.log('SKIPPING MEMBER WITH INVALID EXPIRY:', {
        memberId: member._id,
        name: member.name,
        rawExpiry: member.expiryDate
      });
      continue;
    }

    const diffTime = expiry - today;
    const daysLeft = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (daysLeft < 0) {
      expired.push({ ...member, daysLeft });
    } else if (daysLeft <= 7) {
      expiring.push({ ...member, daysLeft });
    }
  }

  console.log('CLASSIFICATION RESULT:', {
    expiringCount: expiring.length,
    expiredCount: expired.length
  });

  return { expiring, expired };
};

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

    const ownerId = new mongoose.Types.ObjectId(req.user._id);

    const members = await Member.find({ owner: ownerId }).lean();

    console.log('TOTAL MEMBERS FOUND:', members.length);
    console.log('FIRST MEMBER:', members[0]);

    const { expiring, expired } = (!members || members.length === 0)
      ? { expiring: [], expired: [] }
      : classifyMembersByExpiry(members);

    console.log('FINAL EXPIRING:', expiring.length);
    console.log('FINAL EXPIRED:', expired.length);

    // Build WhatsApp message
    const notificationTo = process.env.GYM_NOTIFICATION_WHATSAPP;
    if (!notificationTo) {
      return res.json({ success: false, message: 'GYM_NOTIFICATION_WHATSAPP not configured' });
    }

    let whatsAppMessage;

    if (expiring.length === 0 && expired.length === 0) {
      whatsAppMessage = 'No expiring or expired memberships found.';
    } else {
      whatsAppMessage = '🏋️ *GymPro Membership Alert*\n';

      if (expiring.length > 0) {
        whatsAppMessage += '\n📅 *Expiring Soon:*\n';
        for (const m of expiring) {
          const d = Number(m.daysLeft);
          const label = d === 0 ? 'expires today'
            : d === 1 ? 'expires tomorrow'
            : `${d} days left`;
          whatsAppMessage += `• ${m.name} - ${m.mobile || 'N/A'} - ${label}\n`;
        }
      }

      if (expired.length > 0) {
        whatsAppMessage += '\n❌ *Expired Members:*\n';
        for (const m of expired) {
          const abs = Math.abs(Number(m.daysLeft));
          const label = abs === 0 ? 'expired today'
            : abs === 1 ? 'expired 1 day ago'
            : `expired ${abs} days ago`;
          whatsAppMessage += `• ${m.name} - ${m.mobile || 'N/A'} - ${label}\n`;
        }
      }

      whatsAppMessage += `\n📊 Total: ${expiring.length} expiring soon, ${expired.length} expired`;
    }

    const result = await sendWhatsAppMessage(notificationTo, whatsAppMessage);

    if (result) {
      return res.json({ success: true, message: 'WhatsApp notification sent successfully' });
    } else {
      return res.json({ success: false, message: 'Failed to send WhatsApp notification' });
    }
  } catch (error) {
    console.error('ERROR IN POST /api/notifications/generate:', error);
    return res.status(500).json({ success: false, message: error.message || 'Internal server error' });
  }
});

module.exports = router;
