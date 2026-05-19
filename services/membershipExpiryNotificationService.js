const mongoose = require('mongoose');
const Member = require('../models/Member');
const User = require('../models/User');
const { sendWhatsAppMessage } = require('./whatsappService');

function resolveOwnerWhatsAppRecipient(notificationSettings) {
  const raw = notificationSettings?.whatsappNotificationNumber;
  if (!raw || !String(raw).trim()) {
    return null;
  }
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) {
    return `+91${digits}`;
  }
  if (digits.length === 12 && digits.startsWith('91')) {
    return `+${digits}`;
  }
  return null;
}

/**
 * Classify members into expiring (≤7 days) and expired vs today (local server date).
 */
function classifyMembersByExpiry(members) {
  const expiring = [];
  const expired = [];

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const member of members) {
    if (!member.expiryDate) {
      continue;
    }

    const expiry = new Date(member.expiryDate);
    if (isNaN(expiry.getTime())) {
      console.log('SKIPPING MEMBER WITH INVALID EXPIRY:', {
        memberId: member._id,
        name: member.name,
        rawExpiry: member.expiryDate,
      });
      continue;
    }

    const diffTime = expiry - today;
    const daysLeft = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (daysLeft < 0) {
      expired.push({ ...member, daysLeft });
    } else if (daysLeft <= 7) {
      expiring.push({ ...member, daysLeft });
    }
  }

  console.log('CLASSIFICATION RESULT:', {
    expiringCount: expiring.length,
    expiredCount: expired.length,
  });

  return { expiring, expired };
}

function buildWhatsAppMessage(expiring, expired) {
  if (expiring.length === 0 && expired.length === 0) {
    return 'No expiring or expired memberships found.';
  }

  let whatsAppMessage = '🏋️ *GymPro Membership Alert*\n';

  if (expiring.length > 0) {
    whatsAppMessage += '\n📅 *Expiring Soon:*\n';
    for (const m of expiring) {
      const d = Number(m.daysLeft);
      const label = d === 0 ? 'expires today'
        : d === 1 ? 'expires tomorrow'
          : `${d} days left`;
      whatsAppMessage += `• ${m.name} - ${m.mobile || 'N/A'} - ${label}\n`;
    }
  }

  if (expired.length > 0) {
    whatsAppMessage += '\n❌ *Expired Members:*\n';
    for (const m of expired) {
      const abs = Math.abs(Number(m.daysLeft));
      const label = abs === 0 ? 'expired today'
        : abs === 1 ? 'expired 1 day ago'
          : `expired ${abs} days ago`;
      whatsAppMessage += `• ${m.name} - ${m.mobile || 'N/A'} - ${label}\n`;
    }
  }

  whatsAppMessage += `\n📊 Total: ${expiring.length} expiring soon, ${expired.length} expired`;
  return whatsAppMessage;
}

/**
 * Same pipeline as manual Generate: classify members for owner, build message, send via WhatsApp.
 *
 * @param {mongoose.Types.ObjectId|string} ownerId
 * @param {{ skipEmptySend?: boolean }} options - When true (scheduled automation), do not send if there is nothing to report.
 * @returns {Promise<{ code: string, whatsappOk?: boolean }>}
 */
async function generateAndSendMembershipExpiryWhatsApp(ownerId, options = {}) {
  const { skipEmptySend = false } = options;

  const ownerObjectId = ownerId instanceof mongoose.Types.ObjectId
    ? ownerId
    : new mongoose.Types.ObjectId(String(ownerId));

  const owner = await User.findById(ownerObjectId)
    .select('notificationSettings')
    .lean();

  console.log('[WA-NUM-DEBUG] Automation fetch user:', JSON.stringify({
    ownerId: String(ownerObjectId),
    notificationSettings: owner?.notificationSettings ?? null,
    whatsappNotificationNumber: owner?.notificationSettings?.whatsappNotificationNumber ?? null,
  }));

  const notificationTo = resolveOwnerWhatsAppRecipient(owner?.notificationSettings);
  if (!notificationTo) {
    console.log('[WA-NUM-DEBUG] NO_RECIPIENT — could not resolve number from notificationSettings');
    return { code: 'NO_RECIPIENT' };
  }

  console.log('[WA-NUM-DEBUG] Recipient resolved for send:', notificationTo);

  const members = await Member.find({ owner: ownerObjectId }).lean();

  const { expiring, expired } = (!members || members.length === 0)
    ? { expiring: [], expired: [] }
    : classifyMembersByExpiry(members);

  if (expiring.length === 0 && expired.length === 0) {
    if (skipEmptySend) {
      return { code: 'SKIPPED_EMPTY' };
    }
    const whatsAppMessage = buildWhatsAppMessage(expiring, expired);
    const result = await sendWhatsAppMessage(notificationTo, whatsAppMessage);
    return { code: result ? 'SENT' : 'WHATSAPP_FAIL', whatsappOk: !!result };
  }

  const whatsAppMessage = buildWhatsAppMessage(expiring, expired);
  const result = await sendWhatsAppMessage(notificationTo, whatsAppMessage);
  return { code: result ? 'SENT' : 'WHATSAPP_FAIL', whatsappOk: !!result };
}

module.exports = {
  classifyMembersByExpiry,
  generateAndSendMembershipExpiryWhatsApp,
};
