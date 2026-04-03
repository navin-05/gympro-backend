const express = require('express');
const router = express.Router();
const MembershipPlan = require('../models/MembershipPlan');
const auth = require('../middleware/auth');

// GET /api/plans
router.get('/', auth, async (req, res) => {
  try {
    const plans = await MembershipPlan.find({ owner: req.user._id }).sort({ durationDays: 1 });
    res.json(plans);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/plans
router.post('/', auth, async (req, res) => {
  try {
    const plan = new MembershipPlan({
      owner: req.user._id,
      ...req.body
    });
    await plan.save();
    res.status(201).json(plan);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/plans/:id
router.put('/:id', auth, async (req, res) => {
  try {
    const plan = await MembershipPlan.findOneAndUpdate(
      { _id: req.params.id, owner: req.user._id },
      req.body,
      { new: true, runValidators: true }
    );
    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' });
    }
    res.json(plan);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// DELETE /api/plans/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    const plan = await MembershipPlan.findOneAndDelete({
      _id: req.params.id,
      owner: req.user._id
    });
    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' });
    }
    res.json({ message: 'Plan deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
