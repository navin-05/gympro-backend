const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema({
  member: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'Member'
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'User'
  },
  checkInTime: {
    type: Date,
    default: Date.now
  },
  date: {
    type: String,
    required: true
  }
}, {
  timestamps: true
});

// Compound index to prevent duplicate check-ins on same day
attendanceSchema.index({ member: 1, date: 1 }, { unique: true });

const Attendance = mongoose.model('Attendance', attendanceSchema);
module.exports = Attendance;
