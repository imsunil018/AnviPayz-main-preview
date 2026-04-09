const express = require('express');
const router = express.Router();
const { sendOTP, registerSendOTP, verifyOTP, registerVerifyOTP, getMe, restoreAccount } = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');

router.post('/send-otp', sendOTP);
router.post('/register-send-otp', registerSendOTP);
router.post('/verify-otp', verifyOTP);
router.post('/register-verify-otp', registerVerifyOTP);
router.post('/account/restore', restoreAccount);
router.get('/me', protect, getMe);

module.exports = router;
