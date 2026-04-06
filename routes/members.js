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

// Simple in-memory cache for fast, repeated member list queries.
const MEMBERS_CACHE_TTL_MS = 15000;
const membersCache = new Map();

function getMembersCacheKey({
  owner,
}) {
  return JSON.stringify({
    owner: String(owner),
  });
}

function getCachedMembers(cacheKey) {
  const entry = membersCache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    membersCache.delete(cacheKey);
    return null;
  }
  return entry.data;
}

function setCachedMembers(cacheKey, data) {
  membersCache.set(cacheKey, {
    data,
    expiresAt: Date.now() + MEMBERS_CACHE_TTL_MS,
  });
}

function invalidateOwnerMembersCache(ownerId) {
  const owner = String(ownerId);
  for (const [key] of membersCache) {
    if (key.includes(`"owner":"${owner}"`)) {
      membersCache.delete(key);
    }
  }
}

// GET /api/members — list with search, filters, pagination
router.get('/', auth, async (req, res) => {
  try {
    const cacheKey = getMembersCacheKey({
      owner: req.user._id,
    });
    const cachedData = getCachedMembers(cacheKey);
    if (cachedData) {
      return res.json(cachedData);
    }

    const members = await Member.find({ owner: req.user._id })
      .select('_id name mobile planName expiryDate dueAmount photo')
      .lean()
      .sort({ createdAt: -1 })
      .limit(5000);

    setCachedMembers(cacheKey, members);
    res.json(members);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// ─── IMPORTANT: Specific sub-routes MUST come BEFORE generic /:id routes ───

// POST /api/members/:id/renewals
router.post('/:id/renewals', auth, async (req, res) => {
  console.log('[API] POST /members/:id/renewals — id:', req.params.id, 'body:', req.body);
  try {
    const planId = req.body.plan || req.body.planId;
    const paidAmount = req.body.paidAmount ?? req.body.amount ?? 0;

    const member = await Member.findOne({ _id: req.params.id, owner: req.user._id });
    if (!member) return res.status(404).json({ error: 'Member not found' });

    const plan = await MembershipPlan.findOne({ _id: planId, owner: req.user._id });
    if (!plan) return res.status(400).json({ error: 'Invalid membership plan' });

    const previousExpiry = new Date(member.expiryDate);

    const now = new Date();
    const baseDate = previousExpiry > now ? previousExpiry : now;

    const newExpiry = new Date(baseDate);
    newExpiry.setDate(newExpiry.getDate() + plan.durationDays);

    const paid = paidAmount || 0;
    const due = Math.max(0, plan.price - paid);

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

    member.plan = planId;
    member.planName = plan.planName;
    member.startDate = baseDate;
    member.expiryDate = newExpiry;
    member.paidAmount = paid;
    member.dueAmount = due;

    await member.save();
    invalidateOwnerMembersCache(req.user._id);

    const populatedMember = await Member.findById(member._id)
      .populate('plan', 'planName durationDays price');

    res.json({ member: populatedMember, renewal });

  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});


// GET /api/members/:id/renewals
router.get('/:id/renewals', auth, async (req, res) => {
  try {
    const renewals = await Renewal.find({
      member: req.params.id,
      owner: req.user._id,
    }).sort({ createdAt: -1 });

    res.json(renewals);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// GET /api/members/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const member = await Member.findOne({
      _id: req.params.id,
      owner: req.user._id
    }).populate('plan', 'planName durationDays price');

    if (!member) return res.status(404).json({ error: 'Member not found' });

    res.json(member);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// POST /api/members
router.post('/', auth, async (req, res) => {
  try {
    const { photo, name, mobile, email, plan: planId, startDate, paidAmount, referredBy } = req.body;

    const plan = await MembershipPlan.findOne({ _id: planId, owner: req.user._id });
    if (!plan) return res.status(400).json({ error: 'Invalid membership plan' });

    const start = new Date(startDate);
    const expiry = new Date(start);
    expiry.setDate(expiry.getDate() + plan.durationDays);

    const paid = paidAmount || 0;
    const due = Math.max(0, plan.price - paid);

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
      referralCode: generateReferralCode(name),
      referredBy: referredBy || ''
    });

    await member.save();
    invalidateOwnerMembersCache(req.user._id);

    const qrDataUrl = await QRCode.toDataURL(member._id.toString(), { width: 300, margin: 2 });
    member.qrCode = qrDataUrl;

    await member.save();
    invalidateOwnerMembersCache(req.user._id);

    res.status(201).json(member);

  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});


// PUT /api/members/:id
router.put('/:id', auth, async (req, res) => {
  try {
    const member = await Member.findOne({ _id: req.params.id, owner: req.user._id });
    if (!member) return res.status(404).json({ error: 'Member not found' });

    Object.assign(member, req.body);

    await member.save();
    invalidateOwnerMembersCache(req.user._id);

    res.json(member);

  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});


// DELETE /api/members/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    const member = await Member.findOneAndDelete({
      _id: req.params.id,
      owner: req.user._id
    });

    if (!member) return res.status(404).json({ error: 'Member not found' });

    await Renewal.deleteMany({ member: req.params.id });
    invalidateOwnerMembersCache(req.user._id);

    res.json({ message: 'Member deleted successfully' });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;