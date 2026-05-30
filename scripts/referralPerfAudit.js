#!/usr/bin/env node
/**
 * Referral performance audit script.
 * Usage: node scripts/referralPerfAudit.js [--owner=<userId>]
 *
 * Requires MONGO_URI in backend/.env or environment.
 * Does NOT modify data — read-only benchmarks.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const { connectDB, disconnectDB } = require('../config/db');
const Referral = require('../models/Referral');
const Member = require('../models/Member');
const { syncReferralsForOwner } = require('../services/referralSyncService');
const {
  createTimer,
  analyzePayload,
  byteSizeOfJson,
  formatBytes,
  isBase64Photo,
} = require('../utils/referralPerfLogger');

function parseArgs() {
  const ownerArg = process.argv.find((a) => a.startsWith('--owner='));
  return {
    ownerId: ownerArg ? ownerArg.split('=')[1] : null,
  };
}

async function getIndexes() {
  const referralIndexes = await Referral.collection.getIndexes();
  const memberIndexes = await Member.collection.getIndexes();
  return { referralIndexes, memberIndexes };
}

async function findOwnerWithMostReferrals() {
  const result = await Referral.aggregate([
    { $group: { _id: '$owner', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 1 },
  ]);
  return result[0]?._id || null;
}

async function benchmarkListQuery(ownerId, filter, limit) {
  const query = { owner: new mongoose.Types.ObjectId(ownerId) };
  const now = new Date();
  if (filter === 'today') {
    query.createdAt = { $gte: new Date(now.getFullYear(), now.getMonth(), now.getDate()) };
  } else if (filter === 'month') {
    query.createdAt = { $gte: new Date(now.getFullYear(), now.getMonth(), 1) };
  }

  const timer = createTimer(`list-query-limit-${limit}`);
  const referrals = await Referral.find(query)
    .populate('referrerId', 'name referralCode photo')
    .populate('referredMemberId', 'name mobile photo')
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  const queryMs = timer.end().durationMs;

  const payload = analyzePayload(referrals);
  const totalBytes = byteSizeOfJson(referrals);

  return {
    limit,
    filter,
    queryMs,
    recordCount: referrals.length,
    totalBytes,
    totalBytesFormatted: formatBytes(totalBytes),
    payload,
    sampleRecord: referrals[0] || null,
  };
}

async function benchmarkSync(ownerId) {
  const timer = createTimer('syncReferralsForOwner');
  const synced = await syncReferralsForOwner(ownerId);
  return {
    syncMs: timer.end().durationMs,
    synced,
  };
}

async function analyzeMemberPhotos(ownerId) {
  const members = await Member.find({ owner: ownerId })
    .select('photo name')
    .lean();

  let base64Count = 0;
  let urlCount = 0;
  let emptyCount = 0;
  let totalPhotoBytes = 0;
  let maxPhotoBytes = 0;
  let maxPhotoMember = null;

  for (const m of members) {
    const photo = m.photo || '';
    if (!photo) {
      emptyCount += 1;
      continue;
    }
    totalPhotoBytes += photo.length;
    if (photo.length > maxPhotoBytes) {
      maxPhotoBytes = photo.length;
      maxPhotoMember = m.name;
    }
    if (isBase64Photo(photo)) base64Count += 1;
    else urlCount += 1;
  }

  return {
    totalMembers: members.length,
    base64Count,
    urlCount,
    emptyCount,
    totalPhotoBytes,
    totalPhotoBytesFormatted: formatBytes(totalPhotoBytes),
    avgPhotoBytes: members.length ? Math.round(totalPhotoBytes / members.length) : 0,
    maxPhotoBytes,
    maxPhotoBytesFormatted: formatBytes(maxPhotoBytes),
    maxPhotoMember,
  };
}

async function explainListQuery(ownerId) {
  const query = { owner: new mongoose.Types.ObjectId(ownerId) };
  try {
    const explanation = await Referral.find(query)
      .sort({ createdAt: -1 })
      .limit(200)
      .explain('executionStats');
    const stats = explanation?.executionStats || {};
    return {
      nReturned: stats.nReturned,
      totalDocsExamined: stats.totalDocsExamined,
      totalKeysExamined: stats.totalKeysExamined,
      executionTimeMillis: stats.executionTimeMillis,
      indexUsed: explanation?.queryPlanner?.winningPlan?.inputStage?.indexName
        || explanation?.queryPlanner?.winningPlan?.inputStage?.inputStage?.indexName
        || 'unknown',
    };
  } catch (err) {
    return { error: err.message };
  }
}

async function main() {
  const { ownerId: ownerArg } = parseArgs();

  console.log('=== Referral Performance Audit ===\n');

  await connectDB();

  const ownerId = ownerArg || (await findOwnerWithMostReferrals());
  if (!ownerId) {
    console.log('No referral data found in database.');
    await disconnectDB();
    process.exit(0);
  }

  console.log(`Auditing owner: ${ownerId}\n`);

  // 1. Indexes
  console.log('--- MongoDB Indexes ---');
  const { referralIndexes, memberIndexes } = await getIndexes();
  console.log('Referral indexes:', JSON.stringify(referralIndexes, null, 2));
  console.log('\nRelevant Member indexes (photo query uses _id from populate):');
  console.log(JSON.stringify(memberIndexes, null, 2));

  // 2. Query explain
  console.log('\n--- Query Explain Plan (list, limit 200) ---');
  const explain = await explainListQuery(ownerId);
  console.log(JSON.stringify(explain, null, 2));

  // 3. Sync benchmark
  console.log('\n--- syncReferralsForOwner Benchmark ---');
  const syncResult = await benchmarkSync(ownerId);
  console.log(JSON.stringify(syncResult, null, 2));

  // 4. List query benchmarks
  console.log('\n--- List Query Benchmarks ---');
  const limit200 = await benchmarkListQuery(ownerId, 'all', 200);
  const limit20 = await benchmarkListQuery(ownerId, 'all', 20);
  console.log('Limit 200:', JSON.stringify({
    queryMs: limit200.queryMs,
    recordCount: limit200.recordCount,
    totalBytesFormatted: limit200.totalBytesFormatted,
    photoAnalysis: limit200.payload.photoAnalysis,
    fieldSizeBreakdown: limit200.payload.fieldSizeBreakdown,
  }, null, 2));
  console.log('Limit 20:', JSON.stringify({
    queryMs: limit20.queryMs,
    recordCount: limit20.recordCount,
    totalBytesFormatted: limit20.totalBytesFormatted,
    photoAnalysis: limit20.payload.photoAnalysis,
  }, null, 2));

  // 5. Sample record structure
  console.log('\n--- Sample Referral Record Structure ---');
  if (limit200.sampleRecord) {
    const sample = { ...limit200.sampleRecord };
    if (sample.referrerId?.photo?.length > 100) {
      sample.referrerId.photo = `[TRUNCATED ${sample.referrerId.photo.length} chars, base64=${isBase64Photo(limit200.sampleRecord.referrerId.photo)}]`;
    }
    if (sample.referredMemberId?.photo?.length > 100) {
      sample.referredMemberId.photo = `[TRUNCATED ${sample.referredMemberId.photo.length} chars, base64=${isBase64Photo(limit200.sampleRecord.referredMemberId.photo)}]`;
    }
    console.log(JSON.stringify(sample, null, 2));
    console.log('Referrer keys:', Object.keys(limit200.sampleRecord.referrerId || {}));
    console.log('Referred keys:', Object.keys(limit200.sampleRecord.referredMemberId || {}));
  }

  // 6. Member photo analysis
  console.log('\n--- Member Photo Storage Analysis ---');
  const photoAnalysis = await analyzeMemberPhotos(ownerId);
  console.log(JSON.stringify(photoAnalysis, null, 2));

  // 7. Summary
  const referralCount = await Referral.countDocuments({ owner: ownerId });
  const referredMemberCount = await Member.countDocuments({
    owner: ownerId,
    $or: [
      { referredByMemberId: { $ne: null } },
      { referredBy: { $nin: ['', null] } },
    ],
  });

  console.log('\n=== Audit Summary ===');
  console.log(JSON.stringify({
    ownerId: String(ownerId),
    referralCount,
    referredMemberCount,
    syncMs: syncResult.syncMs,
    listQuery200Ms: limit200.queryMs,
    listQuery20Ms: limit20.queryMs,
    payload200: limit200.totalBytesFormatted,
    payload20: limit20.totalBytesFormatted,
    payloadReductionPct: limit200.totalBytes
      ? Math.round((1 - limit20.totalBytes / limit200.totalBytes) * 100)
      : 0,
    estimatedSyncPctOfTotal: syncResult.syncMs + limit200.queryMs > 0
      ? Math.round((syncResult.syncMs / (syncResult.syncMs + limit200.queryMs)) * 100)
      : 0,
  }, null, 2));

  await disconnectDB();
}

main().catch(async (err) => {
  console.error('Audit failed:', err);
  try {
    await disconnectDB();
  } catch {
    // ignore
  }
  process.exit(1);
});
