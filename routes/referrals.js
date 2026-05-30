const express = require('express');
const router = express.Router();
const Member = require('../models/Member');
const Referral = require('../models/Referral');
const WalletTransaction = require('../models/WalletTransaction');
const auth = require('../middleware/auth');
const { syncReferralsForOwner } = require('../services/referralSyncService');
const {
  createTimer,
  analyzePayload,
  byteSizeOfJson,
  formatBytes,
  logPerf,
  logEndpointSummary,
} = require('../utils/referralPerfLogger');

const PERF_BENCHMARK = process.env.REFERRAL_PERF_BENCHMARK === '1';

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

function buildListQuery(ownerId, filter) {
  const query = { owner: ownerId };
  const now = new Date();
  if (filter === 'today') {
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    query.createdAt = { $gte: startOfDay };
  } else if (filter === 'month') {
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    query.createdAt = { $gte: startOfMonth };
  }
  return query;
}

async function runReferralsListQuery(query, limit) {
  const findTimer = createTimer('referrals-find');
  const findQuery = Referral.find(query)
    .sort({ createdAt: -1 })
    .limit(limit);

  const populateReferrerTimer = createTimer('referrals-populate-referrerId');
  findQuery.populate('referrerId', 'name referralCode photo');
  const populateReferrerMs = populateReferrerTimer.end().durationMs;

  const populateReferredTimer = createTimer('referrals-populate-referredMemberId');
  findQuery.populate('referredMemberId', 'name mobile photo');
  const populateReferredMs = populateReferredTimer.end().durationMs;

  const referrals = await findQuery.lean();
  const findMs = findTimer.end().durationMs;

  return {
    referrals,
    timings: {
      findAndPopulateMs: findMs,
      populateSetupReferrerMs: populateReferrerMs,
      populateSetupReferredMs: populateReferredMs,
      note: 'findAndPopulateMs includes MongoDB find + populate lookups + sort',
    },
  };
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
  const endpointTimer = createTimer('GET /referrals/list-total');
  const ownerId = req.user._id;
  const filter = req.query.filter || 'all';

  try {
    const syncTimer = createTimer('referrals-syncReferralsForOwner');
    await syncReferralsForOwner(ownerId);
    const syncMs = syncTimer.end().durationMs;

    const query = buildListQuery(ownerId, filter);

    const queryTimer = createTimer('referrals-query');
    const { referrals, timings: queryTimings } = await runReferralsListQuery(query, 200);
    const queryMs = queryTimer.end().durationMs;

    const serializeTimer = createTimer('referrals-serialize');
    const payloadAnalysis = analyzePayload(referrals);
    const serialized = JSON.stringify(referrals);
    const serializeMs = serializeTimer.end().durationMs;
    const responseBytes = Buffer.byteLength(serialized, 'utf8');

    const totalMs = endpointTimer.end().durationMs;

    logEndpointSummary({
      endpoint: 'GET /referrals/list',
      ownerId,
      filter,
      timings: {
        totalMs,
        syncReferralsForOwnerMs: syncMs,
        referralsQueryMs: queryMs,
        ...queryTimings,
        serializationMs: serializeMs,
        responseBytes,
        responseSizeFormatted: formatBytes(responseBytes),
      },
      payloadAnalysis,
    });

    if (PERF_BENCHMARK) {
      const benchmarkTimer = createTimer('referrals-benchmark-limit20');
      const { referrals: referrals20, timings: timings20 } = await runReferralsListQuery(query, 20);
      const benchmarkMs = benchmarkTimer.end().durationMs;
      const benchmarkPayload = analyzePayload(referrals20);
      logPerf('benchmark-limit-comparison', {
        ownerId: String(ownerId),
        filter,
        limit200: {
          queryMs,
          responseBytes,
          responseSizeFormatted: formatBytes(responseBytes),
          recordCount: referrals.length,
        },
        limit20: {
          queryMs: benchmarkMs,
          responseBytes: byteSizeOfJson(referrals20),
          responseSizeFormatted: formatBytes(byteSizeOfJson(referrals20)),
          recordCount: referrals20.length,
          ...timings20,
        },
        payloadAnalysisLimit20: benchmarkPayload,
      });
    }

    res.json(referrals);
  } catch (error) {
    const totalMs = endpointTimer.end().durationMs;
    logPerf('endpoint-error', {
      endpoint: 'GET /referrals/list',
      ownerId: String(ownerId),
      filter,
      totalMs,
      error: error.message,
    });
    res.status(500).json({ error: error.message });
  }
});

// GET /api/referrals/stats — analytics
router.get('/stats', auth, async (req, res) => {
  const endpointTimer = createTimer('GET /referrals/stats-total');
  const ownerId = req.user._id;

  try {
    const syncTimer = createTimer('stats-syncReferralsForOwner');
    await syncReferralsForOwner(ownerId);
    const syncMs = syncTimer.end().durationMs;

    const statsTimer = createTimer('stats-query');
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
    const statsQueryMs = statsTimer.end().durationMs;

    const response = {
      totalReferrals,
      totalRewardsPaid: totalRewardsPaid[0]?.total || 0,
      topReferrer: topReferrer || null,
      membersViaReferrals
    };

    const serializeTimer = createTimer('stats-serialize');
    const serialized = JSON.stringify(response);
    const serializeMs = serializeTimer.end().durationMs;
    const responseBytes = Buffer.byteLength(serialized, 'utf8');
    const totalMs = endpointTimer.end().durationMs;

    logEndpointSummary({
      endpoint: 'GET /referrals/stats',
      ownerId,
      filter: null,
      timings: {
        totalMs,
        syncReferralsForOwnerMs: syncMs,
        statsQueryMs,
        serializationMs: serializeMs,
        responseBytes,
        responseSizeFormatted: formatBytes(responseBytes),
      },
      payloadAnalysis: {
        totalReferrals,
        membersViaReferrals,
        topReferrerPhotoBytes: topReferrer?.photo?.length || 0,
        topReferrerHasBase64Photo: Boolean(
          topReferrer?.photo && topReferrer.photo.startsWith('data:image/')
        ),
      },
    });

    res.json(response);
  } catch (error) {
    const totalMs = endpointTimer.end().durationMs;
    logPerf('endpoint-error', {
      endpoint: 'GET /referrals/stats',
      ownerId: String(ownerId),
      totalMs,
      error: error.message,
    });
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
