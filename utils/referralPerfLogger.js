/**
 * Structured performance logging for referral endpoints.
 * Logs to console with [ReferralPerf] prefix for easy filtering in Render logs.
 */

const PREFIX = '[ReferralPerf]';

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function createTimer(label) {
  const start = nowMs();
  return {
    label,
    start,
    end() {
      const durationMs = nowMs() - start;
      return { label, durationMs: Math.round(durationMs * 100) / 100 };
    },
  };
}

async function timeAsync(label, fn) {
  const timer = createTimer(label);
  try {
    const result = await fn();
    const { durationMs } = timer.end();
    return { result, durationMs, label };
  } catch (err) {
    const { durationMs } = timer.end();
    err.perfDurationMs = durationMs;
    err.perfLabel = label;
    throw err;
  }
}

function byteSizeOfJson(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return 0;
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function isBase64Photo(value) {
  if (typeof value !== 'string' || !value) return false;
  return (
    value.startsWith('data:image/') ||
    (value.length > 500 && /^[A-Za-z0-9+/=]+$/.test(value.slice(0, 200)))
  );
}

function analyzePayload(referrals) {
  if (!Array.isArray(referrals) || referrals.length === 0) {
    return {
      recordCount: 0,
      totalBytes: 0,
      totalBytesFormatted: '0 B',
      avgRecordBytes: 0,
      topLevelKeys: [],
      photoAnalysis: {
        referrerBase64Count: 0,
        referredBase64Count: 0,
        referrerPhotoBytes: 0,
        referredPhotoBytes: 0,
        referrerUrlCount: 0,
        referredUrlCount: 0,
        referrerEmptyCount: 0,
        referredEmptyCount: 0,
      },
      fieldSizeBreakdown: {},
      sampleRecordKeys: [],
    };
  }

  const photoAnalysis = {
    referrerBase64Count: 0,
    referredBase64Count: 0,
    referrerPhotoBytes: 0,
    referredPhotoBytes: 0,
    referrerUrlCount: 0,
    referredUrlCount: 0,
    referrerEmptyCount: 0,
    referredEmptyCount: 0,
  };

  const fieldSizes = {};
  let totalRecordBytes = 0;

  const accumulateFieldSizes = (obj, prefix = '') => {
    if (!obj || typeof obj !== 'object') return;
    for (const [key, val] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const size = byteSizeOfJson(val);
      fieldSizes[path] = (fieldSizes[path] || 0) + size;
    }
  };

  for (const record of referrals) {
    totalRecordBytes += byteSizeOfJson(record);
    accumulateFieldSizes(record);

    const referrerPhoto = record.referrerId?.photo;
    const referredPhoto = record.referredMemberId?.photo;

    if (!referrerPhoto) photoAnalysis.referrerEmptyCount += 1;
    else if (isBase64Photo(referrerPhoto)) {
      photoAnalysis.referrerBase64Count += 1;
      photoAnalysis.referrerPhotoBytes += referrerPhoto.length;
    } else {
      photoAnalysis.referrerUrlCount += 1;
      photoAnalysis.referrerPhotoBytes += referrerPhoto.length;
    }

    if (!referredPhoto) photoAnalysis.referredEmptyCount += 1;
    else if (isBase64Photo(referredPhoto)) {
      photoAnalysis.referredBase64Count += 1;
      photoAnalysis.referredPhotoBytes += referredPhoto.length;
    } else {
      photoAnalysis.referredUrlCount += 1;
      photoAnalysis.referredPhotoBytes += referredPhoto.length;
    }
  }

  const totalBytes = byteSizeOfJson(referrals);
  const sortedFields = Object.entries(fieldSizes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([field, bytes]) => ({ field, bytes, formatted: formatBytes(bytes) }));

  return {
    recordCount: referrals.length,
    totalBytes,
    totalBytesFormatted: formatBytes(totalBytes),
    avgRecordBytes: Math.round(totalRecordBytes / referrals.length),
    topLevelKeys: Object.keys(referrals[0] || {}),
    photoAnalysis,
    fieldSizeBreakdown: sortedFields,
    sampleRecordKeys: Object.keys(referrals[0] || {}),
    sampleReferrerKeys: Object.keys(referrals[0]?.referrerId || {}),
    sampleReferredKeys: Object.keys(referrals[0]?.referredMemberId || {}),
  };
}

function logPerf(event, data) {
  console.log(PREFIX, event, JSON.stringify(data));
}

function logEndpointSummary({
  endpoint,
  ownerId,
  filter,
  timings,
  payloadAnalysis,
  extra = {},
}) {
  logPerf('endpoint-summary', {
    endpoint,
    ownerId: String(ownerId),
    filter,
    timings,
    payload: payloadAnalysis,
    ...extra,
  });
}

module.exports = {
  PREFIX,
  createTimer,
  timeAsync,
  byteSizeOfJson,
  formatBytes,
  isBase64Photo,
  analyzePayload,
  logPerf,
  logEndpointSummary,
  nowMs,
};
