const express = require('express');
const router = express.Router();
const Member = require('../models/Member');
const auth = require('../middleware/auth');

// GET /api/referrals/leaderboard
router.get('/leaderboard', auth, async (req, res) => {
  try {
    const leaderboard = await Member.find({
      owner: req.user._id,
      referralCount: { $gt: 0 }
    })
      .select('name referralCode referralCount photo')
      .sort({ referralCount: -1 })
      .limit(20);

    res.json(leaderboard);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/referrals/:memberId — get a member's referral info
router.get('/:memberId', auth, async (req, res) => {
  try {
    const member = await Member.findOne({
      _id: req.params.memberId,
      owner: req.user._id
    }).select('name referralCode referralCount referredBy');

    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    // Find members referred by this member
    const referredMembers = await Member.find({
      owner: req.user._id,
      referredBy: member.referralCode
    }).select('name mobile createdAt');

    res.json({
      member,
      referredMembers
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
