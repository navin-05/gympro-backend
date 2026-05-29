const express = require('express');
const router = express.Router();
const Member = require('../models/Member');
const MembershipPlan = require('../models/MembershipPlan');
const Renewal = require('../models/Renewal');
const WalletTransaction = require('../models/WalletTransaction');
const User = require('../models/User');
const auth = require('../middleware/auth');
const QRCode = require('qrcode');
const {
  resolveReferrer,
  getReferralSettings,
  processReferralForMember,
} = require('../services/referralSyncService');

// Helper: generate unique referral code
function generateReferralCode(name) {
  const cleanName = name.replace(/\s+/g, '').substring(0, 4).toUpperCase();
  const random = Math.random().toString(36).substring(2, 7).toUpperCase();
  return `${cleanName}${random}`;
}

// Backfill referral codes for members created before codes were assigned
async function ensureReferralCodesForOwner(ownerId) {
  const membersWithoutCode = await Member.find({
    owner: ownerId,
    $or: [
      { referralCode: { $exists: false } },
      { referralCode: null },
      { referralCode: '' },
    ],
  }).select('_id name').lean();

  if (membersWithoutCode.length === 0) return false;

  for (const member of membersWithoutCode) {
    let code;
    let saved = false;
    for (let attempt = 0; attempt < 10 && !saved; attempt++) {
      code = generateReferralCode(member.name);
      const exists = await Member.exists({ referralCode: code });
      if (!exists) {
        await Member.updateOne({ _id: member._id }, { $set: { referralCode: code } });
        saved = true;
      }
    }
  }

  invalidateOwnerMembersCache(ownerId);
  return true;
}

// Simple in-memory cache for fast, repeated member list queries.
const MEMBERS_CACHE_TTL_MS = 15000;
const membersCache = new Map();

function getMembersCacheKey({
  owner,
  mode = 'list',
}) {
  return JSON.stringify({
    owner: String(owner),
    mode: String(mode),
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
    const mode = req.query.mode === 'analytics' ? 'analytics' : 'list';
    const cacheKey = getMembersCacheKey({
      owner: req.user._id,
      mode,
    });
    await ensureReferralCodesForOwner(req.user._id);
    const cachedData = getCachedMembers(cacheKey);
    if (cachedData && !cachedData.some((m) => !m.referralCode)) {
      return res.json(cachedData);
    }

    const selectFields = mode === 'analytics'
      ? '_id name mobile photo planName startDate expiryDate paidAmount dueAmount createdAt updatedAt referralCode'
      : '_id name mobile planName expiryDate dueAmount photo referralCode';

    const members = await Member.find({ owner: req.user._id })
      .select(selectFields)
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
    const walletDiscount = Math.max(0, parseFloat(req.body.walletDiscount) || 0);

    const member = await Member.findOne({ _id: req.params.id, owner: req.user._id });
    if (!member) return res.status(404).json({ error: 'Member not found' });

    const plan = await MembershipPlan.findOne({ _id: planId, owner: req.user._id });
    if (!plan) return res.status(400).json({ error: 'Invalid membership plan' });

    // Validate wallet discount
    if (walletDiscount > 0) {
      if (walletDiscount > (member.walletBalance || 0)) {
        return res.status(400).json({ error: 'Wallet discount exceeds available balance' });
      }
      if (walletDiscount > plan.price) {
        return res.status(400).json({ error: 'Wallet discount exceeds plan price' });
      }
    }

    const previousExpiry = new Date(member.expiryDate);

    const now = new Date();
    const baseDate = previousExpiry > now ? previousExpiry : now;

    const newExpiry = new Date(baseDate);
    newExpiry.setDate(newExpiry.getDate() + plan.durationDays);

    const paid = (paidAmount || 0) + walletDiscount;
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
    member.paidAmount = paidAmount || 0;
    member.dueAmount = due;

    // Wallet discount deduction
    if (walletDiscount > 0) {
      await new WalletTransaction({
        owner: req.user._id,
        memberId: member._id,
        type: 'membership_discount',
        amount: -walletDiscount,
        description: `Wallet used for ${plan.planName} renewal`
      }).save();
      member.walletBalance = Math.max(0, (member.walletBalance || 0) - walletDiscount);
    }

    await member.save();
    invalidateOwnerMembersCache(req.user._id);

    const populatedMember = await Member.findById(member._id)
      .populate('plan', 'planName durationDays price');

    res.json({ member: populatedMember, renewal, walletDiscount });

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
    await ensureReferralCodesForOwner(req.user._id);

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

    // ─── Referral Processing (runs after successful member creation) ───
    if (referredBy) {
      try {
        const referrer = await resolveReferrer(req.user._id, {
          referredBy,
          referredByMemberId: null,
        });

        if (referrer) {
          const settings = await getReferralSettings(req.user._id);
          await processReferralForMember(req.user._id, member, referrer, settings);
          invalidateOwnerMembersCache(req.user._id);
        }
      } catch (refErr) {
        // Don't fail member creation if referral processing fails
        console.log('[Members] Referral processing error (non-fatal):', refErr.message);
      }
    }

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

    const {
      name,
      mobile,
      email,
      photo,
      plan: planId,
      startDate,
      paidAmount,
      paid,
      due,
    } = req.body;

    if (typeof name !== 'undefined') member.name = name;
    if (typeof mobile !== 'undefined') member.mobile = mobile;
    if (typeof email !== 'undefined') member.email = email;
    if (typeof photo !== 'undefined') member.photo = photo;

    const nextPaidAmount = typeof paidAmount !== 'undefined'
      ? Number(paidAmount)
      : (typeof paid !== 'undefined' ? Number(paid) : member.paidAmount);

    if (!Number.isFinite(nextPaidAmount) || nextPaidAmount < 0) {
      return res.status(400).json({ error: 'Invalid paid amount' });
    }

    let planDoc = null;
    if (typeof planId !== 'undefined' && String(planId).trim() !== '') {
      planDoc = await MembershipPlan.findOne({ _id: planId, owner: req.user._id });
      if (!planDoc) return res.status(400).json({ error: 'Invalid membership plan' });
      member.plan = planDoc._id;
      member.planName = planDoc.planName;
    } else if (member.plan) {
      planDoc = await MembershipPlan.findOne({ _id: member.plan, owner: req.user._id });
    }

    if (typeof startDate !== 'undefined') {
      const parsedStartDate = new Date(startDate);
      if (Number.isNaN(parsedStartDate.getTime())) {
        return res.status(400).json({ error: 'Invalid start date' });
      }
      member.startDate = parsedStartDate;
    }

    if (planDoc) {
      const nextExpiryDate = new Date(member.startDate);
      nextExpiryDate.setDate(nextExpiryDate.getDate() + planDoc.durationDays);
      member.expiryDate = nextExpiryDate;
    }

    member.paidAmount = nextPaidAmount;
    if (typeof due !== 'undefined') {
      const dueAmount = Number(due);
      if (!Number.isFinite(dueAmount) || dueAmount < 0) {
        return res.status(400).json({ error: 'Invalid due amount' });
      }
      member.dueAmount = dueAmount;
    } else if (planDoc) {
      member.dueAmount = Math.max(0, Number(planDoc.price || 0) - member.paidAmount);
    }

    await member.save();
    invalidateOwnerMembersCache(req.user._id);

    const updatedMember = await Member.findById(member._id)
      .populate('plan', 'planName durationDays price');
    res.json(updatedMember);

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