const Member = require('../models/Member');
const Referral = require('../models/Referral');
const WalletTransaction = require('../models/WalletTransaction');
const User = require('../models/User');
const { createTimer, logPerf } = require('../utils/referralPerfLogger');
const { emitReferralCreated } = require('./referralRealtime');

async function populateReferralDoc(referralId) {
  return Referral.findById(referralId)
    .populate('referrerId', 'name referralCode photo')
    .populate('referredMemberId', 'name mobile photo')
    .lean();
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function resolveReferrer(ownerId, referredMember) {
  if (referredMember.referredByMemberId) {
    const byId = await Member.findOne({
      _id: referredMember.referredByMemberId,
      owner: ownerId,
    });
    if (byId) return byId;
  }

  const code = String(referredMember.referredBy || '').trim();
  if (!code) return null;

  let referrer = await Member.findOne({
    owner: ownerId,
    referralCode: code,
  });
  if (referrer) return referrer;

  referrer = await Member.findOne({
    owner: ownerId,
    referralCode: new RegExp(`^${escapeRegex(code)}$`, 'i'),
  });
  if (referrer) return referrer;

  const members = await Member.find({ owner: ownerId })
    .select('_id name referralCode')
    .lean();
  const codeLower = code.toLowerCase();
  const fuzzy = members.find((m) => {
    if (!m.referralCode && !m.name) return false;
    const refCode = (m.referralCode || '').toLowerCase();
    const name = (m.name || '').toLowerCase();
    return (
      refCode.startsWith(codeLower) ||
      name.startsWith(codeLower) ||
      name.includes(codeLower)
    );
  });
  return fuzzy ? await Member.findById(fuzzy._id) : null;
}

async function getReferralSettings(ownerId) {
  const ownerUser = await User.findById(ownerId).select('referralSettings');
  const settings = ownerUser?.referralSettings || {};
  return {
    referralReward: settings.referralReward ?? 200,
    joiningReward: settings.joiningReward ?? 100,
  };
}

async function processReferralForMember(ownerId, referredMember, referrer, settings) {
  if (!referrer || String(referrer._id) === String(referredMember._id)) {
    return null;
  }

  let referral = await Referral.findOne({ referredMemberId: referredMember._id });
  const isNewReferral = !referral;
  const referrerRewardAmt = settings.referralReward || 0;
  const joiningRewardAmt = settings.joiningReward || 0;

  if (!referral) {
    referral = await Referral.create({
      owner: ownerId,
      referrerId: referrer._id,
      referredMemberId: referredMember._id,
      referrerReward: referrerRewardAmt,
      joiningReward: joiningRewardAmt,
    });
  }

  if (!referredMember.referredByMemberId) {
    await Member.updateOne(
      { _id: referredMember._id },
      {
        $set: {
          referredByMemberId: referrer._id,
          referredBy: referrer.referralCode || referredMember.referredBy,
        },
      }
    );
  }

  const hasReferrerReward = await WalletTransaction.exists({
    owner: ownerId,
    memberId: referrer._id,
    type: 'referral_reward',
    relatedReferralId: referral._id,
  });

  const hasJoiningBonus = await WalletTransaction.exists({
    owner: ownerId,
    memberId: referredMember._id,
    type: 'joining_bonus',
    relatedReferralId: referral._id,
  });

  if (!hasReferrerReward && referrerRewardAmt > 0) {
    await WalletTransaction.create({
      owner: ownerId,
      memberId: referrer._id,
      type: 'referral_reward',
      amount: referrerRewardAmt,
      description: `${referredMember.name} joined using your referral`,
      relatedReferralId: referral._id,
    });
    const inc = { walletBalance: referrerRewardAmt };
    if (isNewReferral) inc.referralCount = 1;
    await Member.updateOne({ _id: referrer._id }, { $inc: inc });
  } else if (isNewReferral && !hasReferrerReward) {
    await Member.updateOne(
      { _id: referrer._id },
      { $inc: { referralCount: 1 } }
    );
  }

  if (!hasJoiningBonus && joiningRewardAmt > 0) {
    await WalletTransaction.create({
      owner: ownerId,
      memberId: referredMember._id,
      type: 'joining_bonus',
      amount: joiningRewardAmt,
      description: 'Welcome Referral Bonus',
      relatedReferralId: referral._id,
    });
    await Member.updateOne(
      { _id: referredMember._id },
      { $inc: { walletBalance: joiningRewardAmt } }
    );
  }

  if (isNewReferral && referral?._id) {
    try {
      const populated = await populateReferralDoc(referral._id);
      if (populated) {
        emitReferralCreated(ownerId, populated);
      }
    } catch (err) {
      console.log('[ReferralRealtime] emit failed:', err.message);
    }
  }

  return referral;
}

/**
 * Create missing Referral records and wallet credits for members who have
 * referredBy / referredByMemberId but were never fully processed.
 */
async function syncReferralsForOwner(ownerId) {
  const endpointTimer = createTimer('syncReferralsForOwner-total');
  const settingsTimer = createTimer('sync-getReferralSettings');
  const settings = await getReferralSettings(ownerId);
  const settingsMs = settingsTimer.end().durationMs;

  const findReferredTimer = createTimer('sync-findReferredMembers');
  const referredMembers = await Member.find({
    owner: ownerId,
    $or: [
      { referredByMemberId: { $ne: null } },
      { referredBy: { $nin: ['', null] } },
    ],
  });
  const findReferredMs = findReferredTimer.end().durationMs;

  let synced = 0;
  let resolveReferrerMs = 0;
  let processReferralMs = 0;
  let resolveReferrerCalls = 0;
  let processReferralCalls = 0;

  for (const referredMember of referredMembers) {
    const resolveTimer = createTimer('sync-resolveReferrer');
    const referrer = await resolveReferrer(ownerId, referredMember);
    resolveReferrerMs += resolveTimer.end().durationMs;
    resolveReferrerCalls += 1;
    if (!referrer) continue;

    const processTimer = createTimer('sync-processReferralForMember');
    const result = await processReferralForMember(
      ownerId,
      referredMember,
      referrer,
      settings
    );
    processReferralMs += processTimer.end().durationMs;
    processReferralCalls += 1;
    if (result) synced += 1;
  }

  const totalMs = endpointTimer.end().durationMs;
  logPerf('syncReferralsForOwner', {
    ownerId: String(ownerId),
    referredMemberCount: referredMembers.length,
    synced,
    timingsMs: {
      total: totalMs,
      getReferralSettings: settingsMs,
      findReferredMembers: findReferredMs,
      resolveReferrerTotal: Math.round(resolveReferrerMs * 100) / 100,
      resolveReferrerAvg: resolveReferrerCalls
        ? Math.round((resolveReferrerMs / resolveReferrerCalls) * 100) / 100
        : 0,
      processReferralTotal: Math.round(processReferralMs * 100) / 100,
      processReferralAvg: processReferralCalls
        ? Math.round((processReferralMs / processReferralCalls) * 100) / 100
        : 0,
    },
    callCounts: {
      resolveReferrer: resolveReferrerCalls,
      processReferralForMember: processReferralCalls,
    },
  });

  return synced;
}

module.exports = {
  resolveReferrer,
  getReferralSettings,
  processReferralForMember,
  syncReferralsForOwner,
};
