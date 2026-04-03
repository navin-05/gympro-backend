const express = require('express');
const router = express.Router();
const Member = require('../models/Member');
const auth = require('../middleware/auth');

// GET /api/payments/:memberId
router.get('/:memberId', auth, async (req, res) => {
  try {
    const member = await Member.findOne({ _id: req.params.memberId, owner: req.user._id })
      .populate('plan', 'planName price');
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    res.json({
      memberId: member._id,
      memberName: member.name,
      planName: member.planName,
      totalPrice: member.plan ? member.plan.price : 0,
      paidAmount: member.paidAmount,
      dueAmount: member.dueAmount
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/payments/:memberId — update payment (add payment to existing)
router.put('/:memberId', auth, async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Please provide a valid payment amount' });
    }

    const member = await Member.findOne({ _id: req.params.memberId, owner: req.user._id })
      .populate('plan', 'planName price');
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    member.paidAmount = (member.paidAmount || 0) + amount;
    member.dueAmount = Math.max(0, (member.plan ? member.plan.price : 0) - member.paidAmount);
    await member.save();

    res.json({
      memberId: member._id,
      memberName: member.name,
      planName: member.planName,
      totalPrice: member.plan ? member.plan.price : 0,
      paidAmount: member.paidAmount,
      dueAmount: member.dueAmount,
      message: `Payment of ₹${amount} recorded successfully`
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
