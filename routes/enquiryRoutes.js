const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { createEnquiry, getEnquiries } = require('../controllers/enquiryController');

// POST /api/enquiries
router.post('/', auth, createEnquiry);

// GET /api/enquiries
router.get('/', auth, getEnquiries);

module.exports = router;
