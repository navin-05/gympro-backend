const Member = require('../models/Member');
const User = require('../models/User');
const { sendWhatsAppMessage } = require('../services/whatsappService');

/**
 * Run membership expiry check for all gym owners and notify via WhatsApp.
 */
async function runMembershipExpiryJob() {
  try {
    console.log('[ExpiryJob] Starting membership expiry check...');

    const notificationTo = process.env.GYM_NOTIFICATION_WHATSAPP;
    if (!notificationTo) {
      console.log('[ExpiryJob] Skipped: GYM_NOTIFICATION_WHATSAPP not configured');
      return;
    }

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const sevenDaysLater = new Date(today);
    sevenDaysLater.setDate(sevenDaysLater.getDate() + 7);

    // Fetch members expiring within 7 days (today <= expiryDate <= today+7)
    const expiringSoon = await Member.find({
      expiryDate: { $gte: today, $lte: sevenDaysLater },
    }).select('name mobile expiryDate owner').lean();

    // Fetch already expired members (expiryDate < today)
    const expired = await Member.find({
      expiryDate: { $lt: today },
    }).select('name mobile expiryDate owner').lean();

    if (expiringSoon.length === 0 && expired.length === 0) {
      console.log('[ExpiryJob] No expiring or expired members found. No message sent.');
      return;
    }

    // Build message
    let message = '🏋️ *GymPro Membership Alert*\n';

    if (expiringSoon.length > 0) {
      message += '\n📅 *Expiring Soon:*\n';
      for (const member of expiringSoon) {
        const daysLeft = Math.ceil((new Date(member.expiryDate) - today) / (1000 * 60 * 60 * 24));
        const label = daysLeft === 0 ? 'expires today'
          : daysLeft === 1 ? 'expires tomorrow'
          : `${daysLeft} days left`;
        message += `• ${member.name} - ${member.mobile} - ${label}\n`;
      }
    }

    if (expired.length > 0) {
      message += '\n❌ *Expired Members:*\n';
      for (const member of expired) {
        const daysAgo = Math.floor((today - new Date(member.expiryDate)) / (1000 * 60 * 60 * 24));
        const label = daysAgo === 0 ? 'expired today'
          : daysAgo === 1 ? 'expired 1 day ago'
          : `expired ${daysAgo} days ago`;
        message += `• ${member.name} - ${member.mobile} - ${label}\n`;
      }
    }

    message += `\n📊 Total: ${expiringSoon.length} expiring soon, ${expired.length} expired`;

    await sendWhatsAppMessage(notificationTo, message);
    console.log('[ExpiryJob] Membership expiry check completed.');
  } catch (error) {
    console.error(`[ExpiryJob] Error: ${error.message}`);
  }
}

module.exports = { runMembershipExpiryJob };
