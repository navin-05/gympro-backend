const express = require('express');
const router = express.Router();
const WalletTransaction = require('../models/WalletTransaction');
const Member = require('../models/Member');
const auth = require('../middleware/auth');
const { syncReferralsForOwner } = require('../services/referralSyncService');

// GET /api/wallet/:memberId — wallet balance + all transactions
router.get('/:memberId', auth, async (req, res) => {
  try {
    await syncReferralsForOwner(req.user._id);
    const member = await Member.findOne({
      _id: req.params.memberId,
      owner: req.user._id
    }).select('walletBalance name');

    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    const transactions = await WalletTransaction.find({
      memberId: req.params.memberId,
      owner: req.user._id
    }).sort({ createdAt: -1 }).limit(100);

    res.json({
      walletBalance: member.walletBalance || 0,
      memberName: member.name,
      transactions
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/wallet/:memberId/referred — rewards earned as a referrer
router.get('/:memberId/referred', auth, async (req, res) => {
  try {
    const transactions = await WalletTransaction.find({
      memberId: req.params.memberId,
      owner: req.user._id,
      type: 'referral_reward'
    }).sort({ createdAt: -1 });

    res.json(transactions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/wallet/:memberId/bonus — rewards earned as a referee (joining bonus)
router.get('/:memberId/bonus', auth, async (req, res) => {
  try {
    const transactions = await WalletTransaction.find({
      memberId: req.params.memberId,
      owner: req.user._id,
      type: 'joining_bonus'
    }).sort({ createdAt: -1 });

    res.json(transactions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
