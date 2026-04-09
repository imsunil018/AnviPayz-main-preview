const crypto = require('crypto');
const User = require('../models/User');
const { sendOtpEmail } = require('./emailService');

const PROFILE_NAME_MIN = 3;
const PROFILE_NAME_MAX = 30;
const OTP_EXPIRY_MS = 5 * 60 * 1000;
const OTP_COOLDOWN_MS = 30 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const EMAIL_CHANGE_STAGE_WINDOW_MS = 15 * 60 * 1000;

function createHttpError(statusCode, message, extra = {}) {
    const error = new Error(message);
    error.statusCode = statusCode;
    Object.assign(error, extra);
    return error;
}

function sanitizeName(value) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim();
}

function sanitizeEmail(value) {
    return String(value || '')
        .trim()
        .toLowerCase();
}

function validateName(name) {
    if (!name) {
        throw createHttpError(422, 'Name is required.');
    }

    if (name.length < PROFILE_NAME_MIN || name.length > PROFILE_NAME_MAX) {
        throw createHttpError(422, `Name must be between ${PROFILE_NAME_MIN} and ${PROFILE_NAME_MAX} characters.`);
    }

    if (!/^[a-zA-Z][a-zA-Z0-9 .'-]{2,29}$/.test(name)) {
        throw createHttpError(422, 'Use only letters, numbers, spaces, dot, apostrophe, or hyphen in your name.');
    }
}

function validateEmail(email) {
    if (!email) {
        throw createHttpError(422, 'New email is required.');
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw createHttpError(422, 'Enter a valid email address.');
    }
}

function hashOtp(otp) {
    return crypto.createHash('sha256').update(String(otp)).digest('hex');
}

function generateOtp() {
    return crypto.randomInt(100000, 1000000).toString();
}

function maskEmail(email) {
    const [local, domain = ''] = String(email || '').split('@');
    if (!local || !domain) {
        return email || '';
    }

    const localVisible = local.length <= 2
        ? `${local[0] || ''}*`
        : `${local.slice(0, 2)}${'*'.repeat(Math.max(1, local.length - 2))}`;
    return `${localVisible}@${domain}`;
}

function serializeProfileUser(user) {
    return {
        id: user._id,
        email: user.email,
        name: user.name,
        phone: user.phone || '',
        points: user.points || 0,
        tokens: user.tokens || 0,
        referralCode: user.referralCode || '',
        joinedAt: user.joinedAt,
        lastLogin: user.lastLogin || null,
        emailVerifiedAt: user.emailVerifiedAt || user.joinedAt || null,
        avatarUrl: user.avatarUrl || '',
        mobileEnabled: false
    };
}

function prependActivity(user, activity) {
    user.activity = [
        {
            title: activity.title || 'Account activity',
            message: activity.message || '',
            amount: Number(activity.amount || 0),
            type: activity.type || 'profile',
            direction: activity.direction || 'credit',
            status: activity.status || 'completed',
            time: activity.time || new Date(),
            taskId: activity.taskId || ''
        },
        ...(Array.isArray(user.activity) ? user.activity : [])
    ].slice(0, 50);
}

function ensureCooldown(lastRequestedAt) {
    if (!lastRequestedAt) {
        return;
    }

    const elapsed = Date.now() - new Date(lastRequestedAt).getTime();
    if (elapsed < OTP_COOLDOWN_MS) {
        throw createHttpError(429, 'Please wait before requesting another OTP.', {
            retryAfterSeconds: Math.ceil((OTP_COOLDOWN_MS - elapsed) / 1000)
        });
    }
}

function ensureOtpWindow(expiresAt, fallbackMessage) {
    if (!expiresAt || new Date(expiresAt).getTime() <= Date.now()) {
        throw createHttpError(400, fallbackMessage);
    }
}

function ensureEmailChangeSession(user) {
    const verifiedAt = user.pendingEmailChange?.oldEmailVerifiedAt;
    if (!verifiedAt) {
        throw createHttpError(400, 'Verify your current email first.');
    }

    const age = Date.now() - new Date(verifiedAt).getTime();
    if (age > EMAIL_CHANGE_STAGE_WINDOW_MS) {
        user.clearPendingEmailChange();
        throw createHttpError(400, 'Your email change session expired. Start again from current email verification.');
    }
}

function verifyOtpAgainstHash(user, { hash, attemptsField, maxAttemptsMessage, invalidMessage }, otp) {
    const providedHash = hashOtp(otp);
    if (providedHash !== hash) {
        user.pendingEmailChange[attemptsField] = Number(user.pendingEmailChange?.[attemptsField] || 0) + 1;
        if (user.pendingEmailChange[attemptsField] >= OTP_MAX_ATTEMPTS) {
            throw createHttpError(429, maxAttemptsMessage);
        }

        throw createHttpError(400, invalidMessage, {
            remainingAttempts: OTP_MAX_ATTEMPTS - user.pendingEmailChange[attemptsField]
        });
    }
}

async function updateProfile(user, payload) {
    const nextName = sanitizeName(payload?.name);
    validateName(nextName);

    if (user.name !== nextName) {
        user.name = nextName;
        prependActivity(user, {
            title: 'Profile updated',
            message: 'Your display name was updated successfully.',
            type: 'profile',
            direction: 'credit',
            amount: 0
        });
        await user.save();
    }

    return serializeProfileUser(user);
}

async function requestEmailChange(user, payload) {
    const step = String(payload?.step || '').trim().toLowerCase();

    if (step === 'old-email') {
        ensureCooldown(user.pendingEmailChange?.oldEmailOtpRequestedAt);
        const otp = generateOtp();

        user.clearPendingEmailChange();
        user.pendingEmailChange.oldEmailOtpHash = hashOtp(otp);
        user.pendingEmailChange.oldEmailOtpExpiresAt = new Date(Date.now() + OTP_EXPIRY_MS);
        user.pendingEmailChange.oldEmailOtpRequestedAt = new Date();
        user.pendingEmailChange.oldEmailOtpAttempts = 0;

        await user.save();

        try {
            await sendOtpEmail({
                toEmail: user.email,
                otp,
                subject: 'Verify your current AnviPayz email',
                heading: 'Verify your current email',
                intro: `We received a request to change the email address on your AnviPayz account.`,
                purposeLine: 'Enter this OTP to confirm you still have access to your current email address.'
            });
        } catch (error) {
            user.clearPendingEmailChange();
            await user.save();
            throw createHttpError(500, error.message || 'Unable to send OTP right now.');
        }

        return {
            step: 'old-email',
            deliveryTarget: maskEmail(user.email),
            expiresInSeconds: OTP_EXPIRY_MS / 1000,
            cooldownSeconds: OTP_COOLDOWN_MS / 1000,
            message: 'Verification OTP sent to your current email.'
        };
    }

    if (step === 'new-email') {
        ensureEmailChangeSession(user);

        const newEmail = sanitizeEmail(payload?.newEmail);
        validateEmail(newEmail);

        if (newEmail === user.email) {
            throw createHttpError(422, 'Enter a different email address.');
        }

        ensureCooldown(user.pendingEmailChange?.newEmailOtpRequestedAt);

        const existingUser = await User.findOne({
            email: newEmail,
            _id: { $ne: user._id }
        }).select('_id');

        if (existingUser) {
            throw createHttpError(409, 'This email is already in use.');
        }

        const otp = generateOtp();
        user.pendingEmailChange.newEmail = newEmail;
        user.pendingEmailChange.newEmailOtpHash = hashOtp(otp);
        user.pendingEmailChange.newEmailOtpExpiresAt = new Date(Date.now() + OTP_EXPIRY_MS);
        user.pendingEmailChange.newEmailOtpRequestedAt = new Date();
        user.pendingEmailChange.newEmailOtpAttempts = 0;
        await user.save();

        try {
            await sendOtpEmail({
                toEmail: newEmail,
                otp,
                subject: 'Verify your new AnviPayz email',
                heading: 'Confirm your new email',
                intro: `You're almost done updating your AnviPayz login email.`,
                purposeLine: 'Enter this OTP to verify the new email address before we update your account.'
            });
        } catch (error) {
            user.pendingEmailChange.newEmail = '';
            user.pendingEmailChange.newEmailOtpHash = '';
            user.pendingEmailChange.newEmailOtpExpiresAt = null;
            user.pendingEmailChange.newEmailOtpAttempts = 0;
            user.pendingEmailChange.newEmailOtpRequestedAt = null;
            await user.save();
            throw createHttpError(500, error.message || 'Unable to send OTP right now.');
        }

        return {
            step: 'new-email',
            deliveryTarget: maskEmail(newEmail),
            expiresInSeconds: OTP_EXPIRY_MS / 1000,
            cooldownSeconds: OTP_COOLDOWN_MS / 1000,
            message: 'Verification OTP sent to your new email.'
        };
    }

    throw createHttpError(422, 'Invalid email change step.');
}

async function verifyEmailChange(user, payload) {
    const step = String(payload?.step || '').trim().toLowerCase();
    const otp = String(payload?.otp || '').trim();

    if (!/^\d{6}$/.test(otp)) {
        throw createHttpError(422, 'Enter a valid 6-digit OTP.');
    }

    if (step === 'old-email') {
        ensureOtpWindow(
            user.pendingEmailChange?.oldEmailOtpExpiresAt,
            'Current email OTP expired. Request a new OTP to continue.'
        );

        const currentAttempts = Number(user.pendingEmailChange?.oldEmailOtpAttempts || 0);
        if (currentAttempts >= OTP_MAX_ATTEMPTS) {
            throw createHttpError(429, 'Too many invalid attempts. Request a new OTP to continue.');
        }

        try {
            verifyOtpAgainstHash(user, {
                hash: user.pendingEmailChange?.oldEmailOtpHash,
                attemptsField: 'oldEmailOtpAttempts',
                maxAttemptsMessage: 'Too many invalid attempts. Request a new OTP to continue.',
                invalidMessage: 'Current email OTP is invalid.'
            }, otp);
        } catch (error) {
            await user.save();
            throw error;
        }

        user.pendingEmailChange.oldEmailOtpHash = '';
        user.pendingEmailChange.oldEmailOtpExpiresAt = null;
        user.pendingEmailChange.oldEmailOtpAttempts = 0;
        user.pendingEmailChange.oldEmailVerifiedAt = new Date();
        await user.save();

        return {
            step: 'old-email-verified',
            message: 'Current email verified. Now verify your new email.'
        };
    }

    if (step === 'new-email') {
        ensureEmailChangeSession(user);
        ensureOtpWindow(
            user.pendingEmailChange?.newEmailOtpExpiresAt,
            'New email OTP expired. Request a new OTP to continue.'
        );

        const currentAttempts = Number(user.pendingEmailChange?.newEmailOtpAttempts || 0);
        if (currentAttempts >= OTP_MAX_ATTEMPTS) {
            throw createHttpError(429, 'Too many invalid attempts. Request a new OTP to continue.');
        }

        try {
            verifyOtpAgainstHash(user, {
                hash: user.pendingEmailChange?.newEmailOtpHash,
                attemptsField: 'newEmailOtpAttempts',
                maxAttemptsMessage: 'Too many invalid attempts. Request a new OTP to continue.',
                invalidMessage: 'New email OTP is invalid.'
            }, otp);
        } catch (error) {
            await user.save();
            throw error;
        }

        const nextEmail = sanitizeEmail(user.pendingEmailChange?.newEmail);
        validateEmail(nextEmail);

        const existingUser = await User.findOne({
            email: nextEmail,
            _id: { $ne: user._id }
        }).select('_id');

        if (existingUser) {
            user.clearPendingEmailChange();
            await user.save();
            throw createHttpError(409, 'This email is already in use.');
        }

        const previousEmail = user.email;
        user.email = nextEmail;
        user.emailVerifiedAt = new Date();
        user.clearPendingEmailChange();
        prependActivity(user, {
            title: 'Email updated',
            message: `Primary email changed from ${previousEmail} to ${nextEmail}.`,
            type: 'profile',
            direction: 'credit',
            amount: 0
        });
        await user.save();

        return {
            step: 'completed',
            message: 'Email address updated successfully.',
            user: serializeProfileUser(user)
        };
    }

    throw createHttpError(422, 'Invalid email verification step.');
}

module.exports = {
    serializeProfileUser,
    updateProfile,
    requestEmailChange,
    verifyEmailChange
};
