const mongoose = require('mongoose');

const transformationSchema = new mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'User'
  },
  memberName: {
    type: String,
    required: true,
    trim: true
  },
  beforePhoto: {
    type: String,
    default: ''
  },
  afterPhoto: {
    type: String,
    default: ''
  },
  duration: {
    type: String,
    required: true,
    trim: true
  }
}, {
  timestamps: true
});

const Transformation = mongoose.model('Transformation', transformationSchema);
module.exports = Transformation;
