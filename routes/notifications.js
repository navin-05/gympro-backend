const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Member = require('../models/Member');
const auth = require('../middleware/auth');

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

    if (!members || members.length === 0) {
      return res.json({
        success: true,
        debug: 'No members found for this user',
        userId: req.user._id,
        expiringCount: 0,
        expiredCount: 0,
        expiring: [],
        expired: []
      });
    }

    console.log('EXPIRY TYPE:', typeof members[0]?.expiryDate);
    console.log('EXPIRY VALUE:', members[0]?.expiryDate);

    const { expiring, expired } = classifyMembersByExpiry(members);

    console.log('FINAL EXPIRING:', expiring.length);
    console.log('FINAL EXPIRED:', expired.length);

    return res.json({
      success: true,
      expiringCount: expiring.length,
      expiredCount: expired.length,
      expiring,
      expired
    });
  } catch (error) {
    console.error('ERROR IN POST /api/notifications/generate:', error);
    return res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
});

module.exports = router;
