const express = require('express');
const router = express.Router();
const WalletTransaction = require('../models/WalletTransaction');
const Member = require('../models/Member');
const auth = require('../middleware/auth');
const { syncReferralsForOwner } = require('../services/referralSyncService');

const USAGE_TRANSACTION_TYPES = new Set([
  'membership_discount',
  'manual_debit',
  'wallet_used',
  'wallet_debit',
]);

function isWalletUsageTransaction(txn) {
  const type = txn.type || '';
  const amount = Number(txn.amount) || 0;
  if (USAGE_TRANSACTION_TYPES.has(type)) return true;
  if (amount < 0 && type !== 'referral_reward' && type !== 'joining_bonus') return true;
  return false;
}

function paymentTypeFromTransaction(txn) {
  const desc = (txn.description || '').toLowerCase();
  if (desc.includes('upgrade')) return 'Plan Upgrade';
  if (desc.includes('extension')) return 'Plan Extension';
  if (txn.type === 'membership_discount' || desc.includes('renewal')) {
    return 'Membership Renewal';
  }
  if (txn.type === 'manual_debit') return 'Wallet Payment';
  return 'Membership Renewal';
}

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

// GET /api/wallet/:memberId/usage — wallet deductions with balance-after each use
router.get('/:memberId/usage', auth, async (req, res) => {
  try {
    const { memberId } = req.params;
    const member = await Member.findOne({
      _id: memberId,
      owner: req.user._id,
    }).select('walletBalance');

    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    const allTransactions = await WalletTransaction.find({
      memberId,
      owner: req.user._id,
    })
      .sort({ createdAt: 1 })
      .lean();

    let runningBalance = 0;
    const balanceAfterById = new Map();
    for (const txn of allTransactions) {
      runningBalance += Number(txn.amount) || 0;
      balanceAfterById.set(String(txn._id), runningBalance);
    }

    const usage = allTransactions
      .filter(isWalletUsageTransaction)
      .map((txn) => ({
        _id: txn._id,
        type: txn.type,
        amount: txn.amount,
        description: txn.description || '',
        createdAt: txn.createdAt,
        walletUsed: Math.abs(Number(txn.amount) || 0),
        balanceAfter: balanceAfterById.get(String(txn._id)) ?? 0,
        paymentType: paymentTypeFromTransaction(txn),
        reference: txn.description || '',
      }))
      .reverse();

    res.json({
      usage,
      walletBalance: member.walletBalance || 0,
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
