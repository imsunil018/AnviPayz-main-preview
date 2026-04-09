const {
    serializeProfileUser,
    updateProfile,
    requestEmailChange,
    verifyEmailChange
} = require('../services/userService');

function sendUserError(res, error, fallbackMessage) {
    const statusCode = error.statusCode || 500;
    const payload = {
        success: false,
        message: error.message || fallbackMessage
    };

    if (error.retryAfterSeconds) {
        payload.retryAfterSeconds = error.retryAfterSeconds;
    }

    if (error.remainingAttempts !== undefined) {
        payload.remainingAttempts = error.remainingAttempts;
    }

    console.error(fallbackMessage, error);
    return res.status(statusCode).json(payload);
}

async function getProfile(req, res) {
    try {
        return res.status(200).json({
            success: true,
            user: serializeProfileUser(req.user)
        });
    } catch (error) {
        return sendUserError(res, error, 'Profile fetch error:');
    }
}

async function patchProfile(req, res) {
    try {
        const user = await updateProfile(req.user, req.body || {});
        return res.status(200).json({
            success: true,
            message: 'Profile updated successfully.',
            user
        });
    } catch (error) {
        return sendUserError(res, error, 'Update profile error:');
    }
}

async function requestSecureEmailChange(req, res) {
    try {
        const data = await requestEmailChange(req.user, req.body || {});
        return res.status(200).json({
            success: true,
            ...data
        });
    } catch (error) {
        return sendUserError(res, error, 'Request email change error:');
    }
}

async function verifySecureEmailChange(req, res) {
    try {
        const data = await verifyEmailChange(req.user, req.body || {});
        return res.status(200).json({
            success: true,
            ...data
        });
    } catch (error) {
        return sendUserError(res, error, 'Verify email change error:');
    }
}

module.exports = {
    getProfile,
    patchProfile,
    requestSecureEmailChange,
    verifySecureEmailChange
};
