const express = require('express');
const router = express.Router();
const Member = require('../models/Member');
const MembershipPlan = require('../models/MembershipPlan');
const Renewal = require('../models/Renewal');
const auth = require('../middleware/auth');
const QRCode = require('qrcode');

// Helper: generate unique referral code
function generateReferralCode(name) {
  const cleanName = name.replace(/\s+/g, '').substring(0, 4).toUpperCase();
  const random = Math.random().toString(36).substring(2, 7).toUpperCase();
  return `${cleanName}${random}`;
}

// GET /api/members — list with search and filters
router.get('/', auth, async (req, res) => {
  try {
    const { search, status, hasDues } = req.query;
    let query = { owner: req.user._id };

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { mobile: { $regex: search, $options: 'i' } }
      ];
    }

    let members = await Member.find(query)
      .populate('plan', 'planName durationDays price')
      .sort({ createdAt: -1 });

    if (status) {
      const now = new Date();
      members = members.filter(m => {
        const expiry = new Date(m.expiryDate);
        const daysLeft = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
        if (status === 'active') return daysLeft > 7;
        if (status === 'expiring') return daysLeft >= 0 && daysLeft <= 7;
        if (status === 'expired') return daysLeft < 0;
        return true;
      });
    }

    if (hasDues === 'true') {
      members = members.filter(m => m.dueAmount > 0);
    }

    res.json(members);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── IMPORTANT: Specific sub-routes MUST come BEFORE generic /:id routes ───

// POST /api/members/:id/renewals — Renew membership and save renewal record
router.post('/:id/renewals', auth, async (req, res) => {
  console.log('[API] POST /members/:id/renewals — id:', req.params.id, 'body:', req.body);
  try {
    const planId = req.body.plan || req.body.planId;
    const paidAmount = req.body.paidAmount ?? req.body.amount ?? 0;
    const member = await Member.findOne({ _id: req.params.id, owner: req.user._id });
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    const plan = await MembershipPlan.findOne({ _id: planId, owner: req.user._id });
    if (!plan) {
      return res.status(400).json({ error: 'Invalid membership plan' });
    }

    const previousExpiry = new Date(member.expiryDate);

    // If member is still active, extend from current expiry. Otherwise extend from today.
    const now = new Date();
    const baseDate = previousExpiry > now ? previousExpiry : now;
    const newExpiry = new Date(baseDate);
    newExpiry.setDate(newExpiry.getDate() + plan.durationDays);

    const paid = paidAmount || 0;
    const due = Math.max(0, plan.price - paid);

    // Save renewal record
    const renewal = new Renewal({
      member: member._id,
      owner: req.user._id,
      plan: planId,
      planName: plan.planName,
      duration: plan.durationDays,
      amount: paid,
      renewalDate: now,
      previousExpiryDate: previousExpiry,
      newExpiryDate: newExpiry,
    });
    await renewal.save();
    console.log('[API] Renewal saved:', renewal._id);

    // Update member
    member.plan = planId;
    member.planName = plan.planName;
    member.startDate = baseDate;
    member.expiryDate = newExpiry;
    member.paidAmount = paid;
    member.dueAmount = due;
    await member.save();
    console.log('[API] Member updated — new expiry:', newExpiry);

    const populatedMember = await Member.findById(member._id).populate('plan', 'planName durationDays price');
    res.json({ member: populatedMember, renewal });
  } catch (error) {
    console.log('[API] Renew error:', error.message);
    res.status(400).json({ error: error.message });
  }
});

// GET /api/members/:id/renewals — Get renewal history
router.get('/:id/renewals', auth, async (req, res) => {
  console.log('[API] GET /members/:id/renewals — id:', req.params.id);
  try {
    const renewals = await Renewal.find({
      member: req.params.id,
      owner: req.user._id,
    }).sort({ createdAt: -1 });
    console.log('[API] Found', renewals.length, 'renewal records');
    res.json(renewals);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/members/:id — single member
router.get('/:id', auth, async (req, res) => {
  try {
    const member = await Member.findOne({ _id: req.params.id, owner: req.user._id })
      .populate('plan', 'planName durationDays price');
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }
    res.json(member);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/members — create member
router.post('/', auth, async (req, res) => {
  try {
    const { photo, name, mobile, email, plan: planId, startDate, paidAmount, referredBy } = req.body;

    const plan = await MembershipPlan.findOne({ _id: planId, owner: req.user._id });
    if (!plan) {
      return res.status(400).json({ error: 'Invalid membership plan' });
    }

    const start = new Date(startDate);
    const expiry = new Date(start);
    expiry.setDate(expiry.getDate() + plan.durationDays);

    const paid = paidAmount || 0;
    const due = Math.max(0, plan.price - paid);
    const referralCode = generateReferralCode(name);

    const member = new Member({
      owner: req.user._id,
      photo: photo || '',
      name,
      mobile,
      email: email || '',
      plan: planId,
      planName: plan.planName,
      startDate: start,
      expiryDate: expiry,
      paidAmount: paid,
      dueAmount: due,
      referralCode,
      referredBy: referredBy || ''
    });

    await member.save();

    const qrDataUrl = await QRCode.toDataURL(member._id.toString(), { width: 300, margin: 2 });
    member.qrCode = qrDataUrl;
    await member.save();

    if (referredBy) {
      const referrer = await Member.findOne({ referralCode: referredBy, owner: req.user._id });
      if (referrer) {
        referrer.referralCount = (referrer.referralCount || 0) + 1;
        await referrer.save();
      }
    }

    const populatedMember = await Member.findById(member._id).populate('plan', 'planName durationDays price');
    res.status(201).json(populatedMember);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/members/:id — update member
router.put('/:id', auth, async (req, res) => {
  try {
    const updates = req.body;
    const member = await Member.findOne({ _id: req.params.id, owner: req.user._id });
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    if (updates.plan && updates.plan !== member.plan.toString()) {
      const plan = await MembershipPlan.findById(updates.plan);
      if (plan) {
        const start = new Date(updates.startDate || member.startDate);
        const expiry = new Date(start);
        expiry.setDate(expiry.getDate() + plan.durationDays);
        updates.expiryDate = expiry;
        updates.planName = plan.planName;
        const paid = updates.paidAmount != null ? updates.paidAmount : member.paidAmount;
        updates.dueAmount = Math.max(0, plan.price - paid);
      }
    }

    Object.keys(updates).forEach(key => {
      member[key] = updates[key];
    });
    await member.save();

    const populatedMember = await Member.findById(member._id).populate('plan', 'planName durationDays price');
    res.json(populatedMember);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// DELETE /api/members/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    const member = await Member.findOneAndDelete({ _id: req.params.id, owner: req.user._id });
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }
    await Renewal.deleteMany({ member: req.params.id });
    res.json({ message: 'Member deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
