const express = require('express');
const {
    getProfile,
    patchProfile,
    requestSecureEmailChange,
    verifySecureEmailChange
} = require('../controllers/userController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

router.get('/profile', getProfile);
router.patch('/update-profile', patchProfile);
router.post('/request-email-change', requestSecureEmailChange);
router.post('/verify-email-change', verifySecureEmailChange);

module.exports = router;
