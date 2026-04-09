const Enquiry = require('../models/Enquiry');

const createEnquiry = async (req, res) => {
  try {
    const enquiry = new Enquiry({
      owner: req.user._id,
      ...req.body
    });

    await enquiry.save();
    return res.status(201).json(enquiry);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
};

const getEnquiries = async (req, res) => {
  try {
    const enquiries = await Enquiry.find({ owner: req.user._id }).sort({ createdAt: -1 });
    return res.json(enquiries);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

module.exports = {
  createEnquiry,
  getEnquiries
};
