#!/usr/bin/env node
/**
 * Phase 2: Query-level timing + explain plans for referral endpoints.
 * Usage: node scripts/referralPerfAuditPhase2.js [--owner=<userId>]
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const { connectDB, disconnectDB } = require('../config/db');
const Referral = require('../models/Referral');
const Member = require('../models/Member');
const WalletTransaction = require('../models/WalletTransaction');
const { syncReferralsForOwner } = require('../services/referralSyncService');
const { createTimer } = require('../utils/referralPerfLogger');

function parseArgs() {
  const ownerArg = process.argv.find((a) => a.startsWith('--owner='));
  return { ownerId: ownerArg ? ownerArg.split('=')[1] : null };
}

function extractIndexName(explanation) {
  const plan = explanation?.queryPlanner?.winningPlan;
  if (!plan) return 'unknown';
  const walk = (stage) => {
    if (!stage) return null;
    if (stage.indexName) return stage.indexName;
    return walk(stage.inputStage) || walk(stage.inputStage?.inputStage);
  };
  return walk(plan) || plan.stage || 'unknown';
}

function summarizeExplain(explanation, label) {
  const stats = explanation?.executionStats;
  if (!stats) {
    return { label, error: 'no executionStats' };
  }
  return {
    label,
    executionTimeMillis: stats.executionTimeMillis,
    totalDocsExamined: stats.totalDocsExamined,
    totalKeysExamined: stats.totalKeysExamined,
    nReturned: stats.nReturned,
    stage: explanation?.queryPlanner?.winningPlan?.stage,
    indexUsed: extractIndexName(explanation),
    collectionScan: stats.totalDocsExamined > 0
      && stats.totalKeysExamined === 0
      && stats.executionTimeMillis > 0,
  };
}

async function findOwnerWithMostReferrals() {
  const result = await Referral.aggregate([
    { $group: { _id: '$owner', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 1 },
  ]);
  return result[0]?._id || null;
}

async function timed(label, fn) {
  const t = createTimer(label);
  const result = await fn();
  return { label, durationMs: t.end().durationMs, result };
}

async function benchmarkStatsQueries(ownerId) {
  const owner = new mongoose.Types.ObjectId(ownerId);
  return Promise.all([
    timed('stats-total-referrals-count', () => Referral.countDocuments({ owner })),
    timed('stats-total-rewards-aggregate', () =>
      WalletTransaction.aggregate([
        { $match: { owner, type: { $in: ['referral_reward', 'joining_bonus'] } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ])
    ),
    timed('stats-top-referrer-find', () =>
      Member.findOne({ owner, referralCount: { $gt: 0 } })
        .select('name referralCode referralCount photo')
        .sort({ referralCount: -1 })
        .lean()
    ),
    timed('stats-members-via-referrals-count', () =>
      Member.countDocuments({ owner, referredByMemberId: { $ne: null } })
    ),
  ]);
}

async function benchmarkListQuerySplit(ownerId, limit) {
  const query = { owner: new mongoose.Types.ObjectId(ownerId) };

  const findResult = await timed('referrals-find-only', () =>
    Referral.find(query).sort({ createdAt: -1 }).limit(limit).lean()
  );

  const docs = findResult.result;
  const populateResult = await timed('referrals-populate', () =>
    Referral.populate(docs, [
      { path: 'referrerId', select: 'name referralCode photo' },
      { path: 'referredMemberId', select: 'name mobile photo' },
    ])
  );

  return {
    limit,
    findOnlyMs: findResult.durationMs,
    populateMs: populateResult.durationMs,
    combinedMs: findResult.durationMs + populateResult.durationMs,
    recordCount: docs.length,
  };
}

async function runExplainPlans(ownerId) {
  const owner = new mongoose.Types.ObjectId(ownerId);
  const explains = [];

  explains.push(summarizeExplain(
    await Referral.find({ owner }).sort({ createdAt: -1 }).limit(200).explain('executionStats'),
    'list-Referral.find+sort+limit'
  ));

  explains.push(summarizeExplain(
    await Referral.aggregate([
      { $match: { owner } },
      { $count: 'n' },
    ]).explain('executionStats'),
    'stats-Referral.countDocuments-equivalent'
  ));

  explains.push(summarizeExplain(
    await WalletTransaction.aggregate([
      { $match: { owner, type: { $in: ['referral_reward', 'joining_bonus'] } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]).explain('executionStats'),
    'stats-WalletTransaction.aggregate'
  ));

  explains.push(summarizeExplain(
    await Member.findOne({ owner, referralCount: { $gt: 0 } })
      .sort({ referralCount: -1 })
      .explain('executionStats'),
    'stats-Member.findOne-topReferrer'
  ));

  explains.push(summarizeExplain(
    await Member.find({ owner, referredByMemberId: { $ne: null } }).explain('executionStats'),
    'stats-Member.count-referredByMemberId-equivalent'
  ));

  explains.push(summarizeExplain(
    await Member.find({
      owner,
      $or: [
        { referredByMemberId: { $ne: null } },
        { referredBy: { $nin: ['', null] } },
      ],
    }).explain('executionStats'),
    'sync-Member.findReferredMembers'
  ));

  const sampleIds = await Referral.find({ owner }).limit(5).select('referrerId referredMemberId').lean();
  const memberIds = [
    ...new Set(
      sampleIds.flatMap((r) => [r.referrerId, r.referredMemberId].filter(Boolean).map(String))
    ),
  ].map((id) => new mongoose.Types.ObjectId(id));

  if (memberIds.length > 0) {
    explains.push(summarizeExplain(
      await Member.find({ _id: { $in: memberIds } })
        .select('name referralCode photo mobile')
        .explain('executionStats'),
      'populate-Member.findByIds'
    ));
  }

  return explains;
}

async function main() {
  const { ownerId: ownerArg } = parseArgs();
  console.log('=== Referral Performance Audit — Phase 2 ===\n');

  await connectDB();

  const ownerId = ownerArg || (await findOwnerWithMostReferrals());
  if (!ownerId) {
    console.log('No referral data found.');
    await disconnectDB();
    process.exit(0);
  }

  console.log(`Owner: ${ownerId}\n`);

  const WalletTransactionModel = WalletTransaction;
  const walletIndexes = await WalletTransactionModel.collection.getIndexes();
  const referralIndexes = await Referral.collection.getIndexes();
  const memberIndexes = await Member.collection.getIndexes();

  console.log('--- INDEXES: Referral ---');
  console.log(JSON.stringify(referralIndexes, null, 2));
  console.log('\n--- INDEXES: Member (subset) ---');
  console.log(JSON.stringify(memberIndexes, null, 2));
  console.log('\n--- INDEXES: WalletTransaction ---');
  console.log(JSON.stringify(walletIndexes, null, 2));

  console.log('\n--- EXPLAIN PLANS ---');
  const explains = await runExplainPlans(ownerId);
  console.log(JSON.stringify(explains, null, 2));

  console.log('\n--- ISOLATED STATS QUERIES (no sync) ---');
  const statsQueries = await benchmarkStatsQueries(ownerId);
  const statsParallelMs = statsQueries.reduce((max, q) => Math.max(max, q.durationMs), 0);
  console.log(JSON.stringify({
    queries: statsQueries.map(({ label, durationMs }) => ({ op: label, durationMs })),
    parallelWallMs: statsParallelMs,
    note: 'parallelWallMs = max of parallel ops (same as Promise.all)',
  }, null, 2));

  console.log('\n--- ISOLATED LIST QUERY (no sync) ---');
  const listSplit = await benchmarkListQuerySplit(ownerId, 200);
  console.log(JSON.stringify(listSplit, null, 2));

  console.log('\n--- syncReferralsForOwner ONLY ---');
  const syncOnly = await timed('syncReferralsForOwner', () => syncReferralsForOwner(ownerId));
  console.log(JSON.stringify({ syncMs: syncOnly.durationMs, synced: syncOnly.result }, null, 2));

  console.log('\n--- SIMULATED ENDPOINT WALL TIMES ---');
  const statsSimulated = syncOnly.durationMs + statsParallelMs;
  const listSimulated = syncOnly.durationMs + listSplit.combinedMs;
  console.log(JSON.stringify({
    'GET /referrals/stats (sync + stats queries)': {
      syncMs: syncOnly.durationMs,
      statsQueriesParallelMs: statsParallelMs,
      estimatedServerMs: statsSimulated,
      observedClientMs: '~9930 (user report)',
    },
    'GET /referrals/list (sync + list queries)': {
      syncMs: syncOnly.durationMs,
      listFindMs: listSplit.findOnlyMs,
      listPopulateMs: listSplit.populateMs,
      listCombinedMs: listSplit.combinedMs,
      estimatedServerMs: listSimulated,
      observedClientMs: '~12420 (user report)',
    },
  }, null, 2));

  console.log('\n--- INDEX FIELD CHECK ---');
  console.log(JSON.stringify({
    createdAt: {
      indexed: Boolean(referralIndexes.owner_1_createdAt_-1),
      indexName: 'owner_1_createdAt_-1',
    },
    referrerId: {
      indexed: Boolean(referralIndexes.referrerId_1),
      indexName: 'referrerId_1',
    },
    referredMemberId: {
      indexed: Boolean(referralIndexes.referredMemberId_1),
      indexName: 'referredMemberId_1',
    },
    missingReferralIndexes: [],
  }, null, 2));

  await disconnectDB();
}

main().catch(async (err) => {
  console.error(err);
  try { await disconnectDB(); } catch { /* ignore */ }
  process.exit(1);
});
