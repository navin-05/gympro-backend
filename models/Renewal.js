const mongoose = require('mongoose');

const renewalSchema = new mongoose.Schema({
  member: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'Member',
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'User',
  },
  plan: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'MembershipPlan',
  },
  planName: {
    type: String,
    required: true,
  },
  duration: {
    type: Number,
    required: true,
  },
  amount: {
    type: Number,
    required: true,
    default: 0,
  },
  renewalDate: {
    type: Date,
    required: true,
    default: Date.now,
  },
  previousExpiryDate: {
    type: Date,
  },
  newExpiryDate: {
    type: Date,
    required: true,
  },
}, {
  timestamps: true,
});

renewalSchema.index({ member: 1, createdAt: -1 });

const Renewal = mongoose.model('Renewal', renewalSchema);
module.exports = Renewal;
