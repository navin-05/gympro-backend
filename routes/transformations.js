const express = require('express');
const router = express.Router();
const Transformation = require('../models/Transformation');
const auth = require('../middleware/auth');

// GET /api/transformations
router.get('/', auth, async (req, res) => {
  try {
    const transformations = await Transformation.find({ owner: req.user._id })
      .sort({ createdAt: -1 });
    res.json(transformations);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/transformations
router.post('/', auth, async (req, res) => {
  try {
    const transformation = new Transformation({
      owner: req.user._id,
      ...req.body
    });
    await transformation.save();
    res.status(201).json(transformation);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// DELETE /api/transformations/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    const transformation = await Transformation.findOneAndDelete({
      _id: req.params.id,
      owner: req.user._id
    });
    if (!transformation) {
      return res.status(404).json({ error: 'Transformation not found' });
    }
    res.json({ message: 'Transformation deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
