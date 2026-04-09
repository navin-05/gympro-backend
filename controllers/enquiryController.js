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

const updateEnquiry = async (req, res) => {
  try {
    const existing = await Enquiry.findById(req.params.id);
    if (!existing || String(existing.owner) !== String(req.user._id)) {
      return res.status(404).json({ error: 'Enquiry not found' });
    }

    const enquiry = await Enquiry.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );

    return res.status(200).json(enquiry);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
};

const deleteEnquiry = async (req, res) => {
  try {
    const enquiry = await Enquiry.findById(req.params.id);
    if (!enquiry || String(enquiry.owner) !== String(req.user._id)) {
      return res.status(404).json({ error: 'Enquiry not found' });
    }

    await Enquiry.findByIdAndDelete(req.params.id);
    return res.status(200).json({ message: 'Enquiry deleted successfully' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

module.exports = {
  createEnquiry,
  getEnquiries,
  updateEnquiry,
  deleteEnquiry
};
