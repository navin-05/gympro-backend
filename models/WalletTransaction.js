const mongoose = require('mongoose');

const walletTransactionSchema = new mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'User',
    index: true
  },
  memberId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'Member'
  },
  type: {
    type: String,
    required: true,
    enum: ['referral_reward', 'joining_bonus', 'membership_discount', 'manual_credit', 'manual_debit']
  },
  amount: {
    type: Number,
    required: true
  },
  description: {
    type: String,
    default: ''
  },
  relatedReferralId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Referral',
    default: null
  }
}, {
  timestamps: true
});

walletTransactionSchema.index({ memberId: 1, createdAt: -1 });
walletTransactionSchema.index({ owner: 1, type: 1 });
walletTransactionSchema.index({ owner: 1, createdAt: -1 });

const WalletTransaction = mongoose.model('WalletTransaction', walletTransactionSchema);
module.exports = WalletTransaction;
