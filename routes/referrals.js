const express = require('express');
const router = express.Router();
const Member = require('../models/Member');
const Referral = require('../models/Referral');
const WalletTransaction = require('../models/WalletTransaction');
const auth = require('../middleware/auth');
const { syncReferralsForOwner } = require('../services/referralSyncService');

function generateReferralCode(name) {
  const cleanName = name.replace(/\s+/g, '').substring(0, 4).toUpperCase();
  const random = Math.random().toString(36).substring(2, 7).toUpperCase();
  return `${cleanName}${random}`;
}

async function ensureReferralCodesForOwner(ownerId) {
  const membersWithoutCode = await Member.find({
    owner: ownerId,
    $or: [
      { referralCode: { $exists: false } },
      { referralCode: null },
      { referralCode: '' },
    ],
  }).select('_id name').lean();

  if (membersWithoutCode.length === 0) return;

  for (const member of membersWithoutCode) {
    let saved = false;
    for (let attempt = 0; attempt < 10 && !saved; attempt++) {
      const code = generateReferralCode(member.name);
      const exists = await Member.exists({ referralCode: code });
      if (!exists) {
        await Member.updateOne({ _id: member._id }, { $set: { referralCode: code } });
        saved = true;
      }
    }
  }
}

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

// GET /api/referrals/select-members
// All members for referral picker — always backfills missing codes, bypasses members cache
router.get('/select-members', auth, async (req, res) => {
  try {
    await ensureReferralCodesForOwner(req.user._id);

    const members = await Member.find({ owner: req.user._id })
      .select('_id name mobile referralCode photo')
      .sort({ name: 1 })
      .limit(5000)
      .lean();

    res.json(members);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/referrals/search-members?q=<query>
// Search members by name, mobile, or referralCode for referral selection
router.get('/search-members', auth, async (req, res) => {
  try {
    await ensureReferralCodesForOwner(req.user._id);

    const q = (req.query.q || '').trim();
    if (!q) {
      return res.json([]);
    }

    const regex = new RegExp(q, 'i');
    const members = await Member.find({
      owner: req.user._id,
      $or: [
        { name: regex },
        { mobile: regex },
        { referralCode: regex }
      ]
    })
      .select('name mobile referralCode photo')
      .limit(20)
      .lean();

    res.json(members);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/referrals/list?filter=today|month|all
// Paginated referral records
router.get('/list', auth, async (req, res) => {
  try {
    await syncReferralsForOwner(req.user._id);

    const filter = req.query.filter || 'all';
    const query = { owner: req.user._id };

    const now = new Date();
    if (filter === 'today') {
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      query.createdAt = { $gte: startOfDay };
    } else if (filter === 'month') {
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      query.createdAt = { $gte: startOfMonth };
    }

    const referrals = await Referral.find(query)
      .populate('referrerId', 'name referralCode photo')
      .populate('referredMemberId', 'name mobile photo')
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    res.json(referrals);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/referrals/stats — analytics
router.get('/stats', auth, async (req, res) => {
  try {
    await syncReferralsForOwner(req.user._id);

    const [
      totalReferrals,
      totalRewardsPaid,
      topReferrer,
      membersViaReferrals
    ] = await Promise.all([
      Referral.countDocuments({ owner: req.user._id }),

      WalletTransaction.aggregate([
        {
          $match: {
            owner: req.user._id,
            type: { $in: ['referral_reward', 'joining_bonus'] }
          }
        },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),

      Member.findOne({
        owner: req.user._id,
        referralCount: { $gt: 0 }
      })
        .select('name referralCode referralCount photo')
        .sort({ referralCount: -1 })
        .lean(),

      Member.countDocuments({
        owner: req.user._id,
        referredByMemberId: { $ne: null }
      })
    ]);

    res.json({
      totalReferrals,
      totalRewardsPaid: totalRewardsPaid[0]?.total || 0,
      topReferrer: topReferrer || null,
      membersViaReferrals
    });
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
    }).select('name referralCode referralCount referredBy walletBalance');

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
