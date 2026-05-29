const mongoose = require('mongoose');

const referralSchema = new mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'User',
    index: true
  },
  referrerId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'Member'
  },
  referredMemberId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'Member'
  },
  referrerReward: {
    type: Number,
    default: 0,
    min: 0
  },
  joiningReward: {
    type: Number,
    default: 0,
    min: 0
  }
}, {
  timestamps: true
});

// Prevent duplicate referral rewards for the same referred member
referralSchema.index({ referredMemberId: 1 }, { unique: true });
referralSchema.index({ owner: 1, createdAt: -1 });
referralSchema.index({ referrerId: 1 });

const Referral = mongoose.model('Referral', referralSchema);
module.exports = Referral;
