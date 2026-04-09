const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const {
  createEnquiry,
  getEnquiries,
  updateEnquiry,
  deleteEnquiry
} = require('../controllers/enquiryController');

// POST /api/enquiries
router.post('/', auth, createEnquiry);

// GET /api/enquiries
router.get('/', auth, getEnquiries);

// PUT /api/enquiries/:id
router.put('/:id', auth, updateEnquiry);

// DELETE /api/enquiries/:id
router.delete('/:id', auth, deleteEnquiry);

module.exports = router;
