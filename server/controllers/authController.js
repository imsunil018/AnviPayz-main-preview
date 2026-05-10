const User = require('../models/User');
const OTP = require('../models/Otp');
const Notification = require('../models/Notification');
const nodemailer = require('nodemailer');
const { createOtpEmail } = require('../../api/_lib/otp-email');
const {
    RECOVERY_WINDOW_DAYS,
    createRestoreToken,
    getDeletionMetadata,
    isPendingDeletion,
    purgeUserIfExpired,
    restoreUserAccount,
    verifyRestoreToken
} = require('../utils/accountLifecycle');

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
const SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || 'anvipayz@gmail.com';
const SENDER_NAME = process.env.BREVO_SENDER_NAME || 'AnviPayz';
const WELCOME_POINTS = 50;
const REFERRAL_REFERRER_POINTS = 250;
const REFERRAL_NEW_USER_POINTS = 150;
const REFERRAL_MILESTONE_SIZE = 15;
const REFERRAL_MILESTONE_BONUS_POINTS = 1000;
const REFERRAL_DAILY_LIMIT = 10;
const INDIA_TIME_ZONE = 'Asia/Kolkata';
const INDIA_TIME_ZONE_OFFSET = '+05:30';
const POLICY_VERSION = '2026-03-31';

function indiaDateKey(value = Date.now()) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: INDIA_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(new Date(value));
}

function indiaDayRange(value = Date.now()) {
    const key = indiaDateKey(value);
    const start = new Date(`${key}T00:00:00.000${INDIA_TIME_ZONE_OFFSET}`);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return { start, end, key };
}

const readBrevoError = async (response) => {
    const rawBody = await response.text();

    try {
        const parsed = JSON.parse(rawBody);
        return parsed.message || parsed.code || rawBody;
    } catch (error) {
        return rawBody;
    }
};

const serializeUser = (user, extra = {}) => ({
    id: user._id,
    email: user.email,
    name: user.name,
    phone: user.phone || '',
    points: user.points || 0,
    tokens: user.tokens || 0,
    referralEarnings: user.referralEarnings || 0,
    taskEarnings: user.taskEarnings || 0,
    surveyEarnings: user.surveyEarnings || 0,
    referralCode: user.referralCode,
    joinedAt: user.joinedAt,
    lastLogin: user.lastLogin,
    emailVerifiedAt: user.emailVerifiedAt || user.joinedAt || null,
    avatarUrl: user.avatarUrl || '',
    referredByCode: user.referredByCode || '',
    termsAcceptedAt: user.termsAcceptedAt || null,
    acceptedPolicyVersion: user.acceptedPolicyVersion || '',
    ...getDeletionMetadata(user),
    ...extra
});

const appendActivity = (user, activity) => {
    user.activity = [
        {
            title: activity.title || 'Account activity',
            message: activity.message || '',
            amount: Number(activity.amount || 0),
            type: activity.type || 'wallet',
            direction: activity.direction || 'credit',
            status: activity.status || 'completed',
            time: activity.time || new Date(),
            taskId: activity.taskId || ''
        },
        ...(Array.isArray(user.activity) ? user.activity : [])
    ].slice(0, 50);
};

const sendEmailViaSmtp = async (toEmail, emailContent) => {
    if (!process.env.BREVO_API_KEY) {
        throw new Error('BREVO_API_KEY is missing. Add it in .env to send OTP emails.');
    }

    const transporter = nodemailer.createTransport({
        host: 'smtp-relay.brevo.com',
        port: 587,
        secure: false,
        auth: {
            user: 'apikey',
            pass: process.env.BREVO_API_KEY
        }
    });

    await transporter.sendMail({
        from: `"${SENDER_NAME}" <${SENDER_EMAIL}>`,
        to: toEmail,
        replyTo: `"AnviPayz Support" <${SENDER_EMAIL}>`,
        subject: emailContent.subject,
        html: emailContent.html,
        text: emailContent.text
    });
};

const sendEmailViaBrevo = async (toEmail, otp, mode = 'login') => {
    const emailContent = createOtpEmail(mode === 'register'
        ? {
            otp,
            subject: 'Complete your AnviPayz sign up',
            heading: 'Confirm your email to continue',
            intro: 'Use the verification code below to verify your email address and finish creating your AnviPayz account.',
            purposeLine: 'Enter this code only on the AnviPayz registration screen.'
        }
        : {
            otp,
            subject: 'Your AnviPayz login code',
            heading: 'Your sign-in code is ready',
            intro: 'Use the verification code below to complete your AnviPayz login.',
            purposeLine: 'Enter this code only on the AnviPayz login screen.'
        });

    if (typeof fetch !== 'function') {
        await sendEmailViaSmtp(toEmail, emailContent);
        return { success: true, via: 'smtp' };
    }

    try {
        const response = await fetch(BREVO_API_URL, {
            method: 'POST',
            headers: {
                'api-key': process.env.BREVO_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                sender: {
                    email: SENDER_EMAIL,
                    name: SENDER_NAME
                },
                replyTo: {
                    email: SENDER_EMAIL,
                    name: 'AnviPayz Support'
                },
                to: [{ email: toEmail }],
                subject: emailContent.subject,
                htmlContent: emailContent.html,
                textContent: emailContent.text
            })
        });

        if (!response.ok) {
            const errorMessage = await readBrevoError(response);
            const isSenderInvalid = /sender.+not valid|validate your sender/i.test(errorMessage);

            if (isSenderInvalid) {
                throw new Error(`Brevo sender "${SENDER_EMAIL}" is not validated. Verify this sender or domain in Brevo before sending OTP emails.`);
            }

            try {
                await sendEmailViaSmtp(toEmail, emailContent);
                return { success: true, via: 'smtp-fallback' };
            } catch (smtpError) {
                throw new Error(errorMessage || smtpError.message || 'Failed to send email');
            }
        }

        return { success: true, via: 'api' };
    } catch (error) {
        if (!/sender.+not valid|validate your sender/i.test(error.message || '')) {
            try {
                await sendEmailViaSmtp(toEmail, emailContent);
                return { success: true, via: 'smtp-fallback' };
            } catch (smtpError) {
                // fall through to throw below
            }
        }

        console.error('Brevo Email Error:', error);
        throw new Error(error.message || 'Failed to send OTP email');
    }
};

const sendOTP = async (req, res) => {
    try {
        const email = req.body?.email?.trim().toLowerCase();

        if (!email) {
            return res.status(400).json({
                success: false,
                message: 'Email is required'
            });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({
                success: false,
                message: 'Please enter a valid email address'
            });
        }

        const canRequest = await OTP.canRequestOTP(email);
        if (!canRequest) {
            return res.status(429).json({
                success: false,
                message: 'Please wait 30 seconds before requesting new OTP',
                retryAfter: 30
            });
        }

        const otp = OTP.generateOTP();
        const otpHash = OTP.hashOTP(otp);
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
        const otpRecord = await OTP.create({
            email,
            otpHash,
            expiresAt
        });

        try {
            await sendEmailViaBrevo(email, otp, 'login');
        } catch (emailError) {
            await OTP.deleteOne({ _id: otpRecord._id });
            throw emailError;
        }

        res.status(200).json({
            success: true,
            message: 'OTP sent successfully',
            email
        });
    } catch (error) {
        console.error('Send OTP Error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to send OTP'
        });
    }
};

const registerSendOTP = async (req, res) => {
    try {
        const email = req.body?.email?.trim().toLowerCase();
        const name = req.body?.name?.trim();
        const acceptedTerms = Boolean(req.body?.acceptedTerms);
        let referCode = req.body?.referCode?.trim().toUpperCase() || null;

        if (!email || !name) {
            return res.status(400).json({ success: false, message: 'Email and Name are required' });
        }

        if (!acceptedTerms) {
            return res.status(400).json({ success: false, message: 'Please accept the Terms & Conditions to continue.' });
        }

        const isValidReferralCode = (code) => {
            const normalized = String(code || '').trim().toUpperCase();
            if (!normalized) {
                return false;
            }
            return /^[0-9]{4,5}ANVI[0-9]{4,5}$/.test(normalized) || /^ANVI[A-Z][0-9]{4}$/.test(normalized);
        };

        // Validate referral code format if provided
        if (referCode) {
            if (!isValidReferralCode(referCode)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid referral code format. Use format like: ANVIA1234'
                });
            }

            // Only keep referral code if the referrer exists.
            let referrer = await User.findOne({ referralCode: referCode });
            if (referrer && await purgeUserIfExpired(referrer)) {
                referrer = null;
            }

            if (referrer && isPendingDeletion(referrer)) {
                referrer = null;
            }

            if (!referrer) {
                console.warn(`Unknown referral code provided during registration: ${referCode}`);
                referCode = null;
            } else {
                const { start, end } = indiaDayRange();
                const todayCount = await User.countDocuments({
                    referredByCode: referCode,
                    joinedAt: { $gte: start, $lt: end }
                });

                if (todayCount >= REFERRAL_DAILY_LIMIT) {
                    return res.status(400).json({
                        success: false,
                        message: 'This referral code has reached the daily limit. Try again tomorrow.'
                    });
                }
            }
        }

        let existingUser = await User.findOne({ email });
        if (existingUser && await purgeUserIfExpired(existingUser)) {
            existingUser = null;
        }

        if (existingUser) {
            if (isPendingDeletion(existingUser)) {
                return res.status(409).json({
                    success: false,
                    message: `This account is scheduled for permanent deletion in ${RECOVERY_WINDOW_DAYS} days. Please login to restore it instead.`,
                    code: 'ACCOUNT_PENDING_DELETION',
                    recovery: getDeletionMetadata(existingUser)
                });
            }

            return res.status(400).json({ success: false, message: 'Email already registered. Please login.' });
        }

        const canRequest = await OTP.canRequestOTP(email);
        if (!canRequest) {
            return res.status(429).json({ success: false, message: 'Please wait 30s before retrying' });
        }

        const otp = OTP.generateOTP();
        const otpHash = OTP.hashOTP(otp);
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
        const otpRecord = await OTP.create({
            email,
            otpHash,
            expiresAt,
            referCode: referCode || undefined  // Store referCode for verification phase
        });

        try {
            await sendEmailViaBrevo(email, otp, 'register');
        } catch (emailError) {
            await OTP.deleteOne({ _id: otpRecord._id });
            throw emailError;
        }

        res.status(200).json({
            success: true,
            message: 'Registration OTP sent successfully'
        });
    } catch (error) {
        console.error('Register Send OTP Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

const verifyOTP = async (req, res) => {
    try {
        const email = req.body?.email?.trim().toLowerCase();
        const otp = req.body?.otp?.trim();

        if (!email || !otp) {
            return res.status(400).json({
                success: false,
                message: 'Email and OTP are required'
            });
        }

        const otpRecord = await OTP.findValidOTP(email);

        if (!otpRecord) {
            return res.status(400).json({
                success: false,
                message: 'OTP expired or not found. Please request new OTP.'
            });
        }

        const verification = await otpRecord.verifyOTP(otp);

        if (!verification.success) {
            const remainingAttempts = 5 - otpRecord.attempts;
            return res.status(400).json({
                success: false,
                message: verification.message,
                remainingAttempts: Math.max(0, remainingAttempts)
            });
        }

        let user = await User.findOne({ email });
        if (user && await purgeUserIfExpired(user)) {
            user = null;
        }

        const isNewUser = !user;

        if (user && isPendingDeletion(user)) {
            await OTP.deleteOne({ _id: otpRecord._id });
            return res.status(200).json({
                success: true,
                restoreRequired: true,
                message: 'This account is scheduled for permanent deletion. Restore it to continue.',
                restoreToken: createRestoreToken(user),
                recovery: getDeletionMetadata(user),
                user: serializeUser(user)
            });
        }

        if (!user) {
            user = await User.create({
                email,
                name: req.body.name || email.split('@')[0],
                points: WELCOME_POINTS,
                emailVerifiedAt: new Date()
            });
            appendActivity(user, {
                title: 'Welcome bonus',
                message: 'Welcome bonus credited after your first login.',
                amount: WELCOME_POINTS,
                type: 'register'
            });
        }

        user.lastLogin = new Date();
        user.loginCount = Number(user.loginCount || 0) + 1;
        user.emailVerifiedAt = user.emailVerifiedAt || new Date();

        // Ensure user has referral code
        if (!user.referralCode) {
            await user.ensureReferralCode();
        }

        await user.save();

        const token = user.generateAuthToken();

        const response = {
            success: true,
            message: 'Login successful',
            token,
            user: serializeUser(user, { isNewUser })
        };

        if (isNewUser) {
            response.welcomeReward = {
                message: `Welcome! You earned ${WELCOME_POINTS} points as a login reward`,
                points: WELCOME_POINTS
            };
        }

        await OTP.deleteOne({ _id: otpRecord._id });

        res.status(200).json(response);
    } catch (error) {
        console.error('Verify OTP Error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to verify OTP'
        });
    }
};

const registerVerifyOTP = async (req, res) => {
    try {
        const email = req.body?.email?.trim().toLowerCase();
        const otp = req.body?.otp?.trim();
        const name = req.body?.name?.trim();
        const bodyReferCode = req.body?.referCode?.trim().toUpperCase();
        const acceptedTerms = Boolean(req.body?.acceptedTerms);

        if (!email || !otp || !name) {
            return res.status(400).json({
                success: false,
                message: 'Name, email and OTP are required'
            });
        }

        if (!acceptedTerms) {
            return res.status(400).json({
                success: false,
                message: 'Please accept the Terms & Conditions before creating your account.'
            });
        }

        const otpRecord = await OTP.findValidOTP(email);
        if (!otpRecord) {
            return res.status(400).json({
                success: false,
                message: 'OTP expired or not found. Please request new OTP.'
            });
        }

        const verification = await otpRecord.verifyOTP(otp);
        if (!verification.success) {
            const remainingAttempts = 5 - otpRecord.attempts;
            return res.status(400).json({
                success: false,
                message: verification.message,
                remainingAttempts: Math.max(0, remainingAttempts)
            });
        }

        const storedReferCode = String(otpRecord.referCode || '').trim().toUpperCase();
        let referCode = storedReferCode || (bodyReferCode || '');

        if (storedReferCode && bodyReferCode && storedReferCode !== bodyReferCode) {
            console.warn(`Referral code mismatch during registration verify. Using stored referCode=${storedReferCode}, body referCode=${bodyReferCode}`);
        }

        let existingUser = await User.findOne({ email });
        if (existingUser && await purgeUserIfExpired(existingUser)) {
            existingUser = null;
        }

        if (existingUser) {
            await OTP.deleteOne({ _id: otpRecord._id });
            if (isPendingDeletion(existingUser)) {
                return res.status(409).json({
                    success: false,
                    message: `This email already belongs to an account scheduled for deletion. Login first to restore it before ${new Date(existingUser.deleteAfter).toLocaleString('en-IN')}.`,
                    code: 'ACCOUNT_PENDING_DELETION',
                    recovery: getDeletionMetadata(existingUser)
                });
            }

            return res.status(400).json({
                success: false,
                message: 'Email already registered. Please login.'
            });
        }

        let referrer = null;
        const isValidReferralCode = (code) => {
            const normalized = String(code || '').trim().toUpperCase();
            if (!normalized) {
                return false;
            }
            return /^[0-9]{4,5}ANVI[0-9]{4,5}$/.test(normalized) || /^ANVI[A-Z][0-9]{4}$/.test(normalized);
        };

        if (referCode) {
            if (!isValidReferralCode(referCode)) {
                console.warn(`Invalid referral code format during registration verify: ${referCode}`);
                referCode = '';
            }
        }

        if (referCode) {
            referrer = await User.findOne({ referralCode: referCode });
            if (referrer && await purgeUserIfExpired(referrer)) {
                referrer = null;
            }

            if (referrer && isPendingDeletion(referrer)) {
                referrer = null;
            }

            if (!referrer) {
                console.warn(`Referral code lookup failed during registration verify: ${referCode}`);
                referCode = '';
            } else {
                const { start, end } = indiaDayRange();
                const todayCount = await User.countDocuments({
                    referredByCode: referCode,
                    joinedAt: { $gte: start, $lt: end }
                });

                if (todayCount >= REFERRAL_DAILY_LIMIT) {
                    console.warn(`Referral daily limit reached for code=${referCode} (${todayCount}/${REFERRAL_DAILY_LIMIT}). Skipping referral bonus.`);
                    referrer = null;
                    referCode = '';
                }
            }
        }

        const user = new User({
            email,
            name,
            points: WELCOME_POINTS,
            referredByCode: referCode || '',
            emailVerifiedAt: new Date(),
            termsAcceptedAt: new Date(),
            acceptedPolicyVersion: POLICY_VERSION
        });

        // Generate referral code for new user
        await user.ensureReferralCode();

        appendActivity(user, {
            title: 'Welcome bonus',
            message: 'Welcome bonus credited after registration.',
            amount: WELCOME_POINTS,
            type: 'register'
        });

        let referralReward = null;
        let referralNotice = null;
        let referralBonusAwarded = 0;
        let milestoneBonusAwarded = 0;

        if (referrer) {
            const referrerName = String(referrer.name || 'a friend').trim() || 'a friend';

            user.points += REFERRAL_NEW_USER_POINTS;
            referralBonusAwarded = REFERRAL_NEW_USER_POINTS;
            appendActivity(user, {
                title: 'Referral bonus',
                message: `Referral code ${referCode} applied successfully. Referred by ${referrerName}.`,
                amount: REFERRAL_NEW_USER_POINTS,
                type: 'referral'
            });

            referralReward = {
                message: `Referral code applied successfully. You earned ${REFERRAL_NEW_USER_POINTS} bonus points from ${referrerName}.`,
                points: REFERRAL_NEW_USER_POINTS,
                referrerName
            };

            referralNotice = {
                referrerId: String(referrer._id),
                referrerName,
                referredName: name
            };
        }

        user.lastLogin = new Date();
        user.loginCount = 1;
        await user.save();

        if (referrer) {
            const totalReferrals = await User.countDocuments({ referredByCode: referCode });
            const milestoneNumber = Math.floor(totalReferrals / REFERRAL_MILESTONE_SIZE);
            const hitsMilestone = totalReferrals > 0 && (totalReferrals % REFERRAL_MILESTONE_SIZE === 0);
            const milestoneClaimKey = milestoneNumber > 0 ? `referral-bonus-${milestoneNumber}` : '';

            referrer.points = Number(referrer.points || 0) + REFERRAL_REFERRER_POINTS;
            referrer.referralEarnings = Number(referrer.referralEarnings || 0) + REFERRAL_REFERRER_POINTS;
            appendActivity(referrer, {
                title: 'Referral joined',
                message: `${name} joined using your referral code.`,
                amount: REFERRAL_REFERRER_POINTS,
                type: 'referral'
            });

            if (hitsMilestone && milestoneClaimKey) {
                const existingKeys = Array.isArray(referrer.rewardClaimKeys) ? referrer.rewardClaimKeys : [];
                if (!existingKeys.includes(milestoneClaimKey)) {
                    referrer.rewardClaimKeys = [...existingKeys, milestoneClaimKey].slice(0, 250);
                    referrer.points += REFERRAL_MILESTONE_BONUS_POINTS;
                    referrer.referralEarnings += REFERRAL_MILESTONE_BONUS_POINTS;
                    milestoneBonusAwarded = REFERRAL_MILESTONE_BONUS_POINTS;
                    appendActivity(referrer, {
                        title: 'Referral milestone bonus',
                        message: `Milestone unlocked: ${totalReferrals} referrals completed. Bonus credited.`,
                        amount: REFERRAL_MILESTONE_BONUS_POINTS,
                        type: 'referral'
                    });
                }
            }

            await referrer.save();
        }

        if (referralNotice) {
            try {
                const referredUserMessage = referralBonusAwarded > 0
                    ? `Referral code applied successfully. You earned ${referralBonusAwarded} bonus points from ${referralNotice.referrerName}.`
                    : `Referral code applied successfully.`;

                const referrerMessage = milestoneBonusAwarded > 0
                    ? `${referralNotice.referredName} joined using your referral code. +${REFERRAL_REFERRER_POINTS} points, plus ${milestoneBonusAwarded} milestone bonus!`
                    : `${referralNotice.referredName} joined using your referral code. +${REFERRAL_REFERRER_POINTS} points credited.`;

                await Notification.insertMany([
                    {
                        title: 'Referral bonus',
                        message: referredUserMessage,
                        type: 'referral',
                        audience: 'user',
                        userId: String(user._id),
                        meta: {
                            referrerName: referralNotice.referrerName,
                            referrerId: referralNotice.referrerId
                        }
                    },
                    {
                        title: 'Referral joined',
                        message: referrerMessage,
                        type: 'referral',
                        audience: 'user',
                        userId: referralNotice.referrerId,
                        meta: {
                            referredName: referralNotice.referredName,
                            referredUserId: String(user._id)
                        }
                    }
                ]);
            } catch (error) {
                console.warn('Referral notification error:', error.message);
            }
        }

        const token = user.generateAuthToken();

        await OTP.deleteOne({ _id: otpRecord._id });

        res.status(200).json({
            success: true,
            message: 'Registration successful',
            token,
            user: serializeUser(user, { isNewUser: true }),
            welcomeReward: {
                message: `Welcome! You earned ${WELCOME_POINTS} points as a signup reward`,
                points: WELCOME_POINTS
            },
            referralReward
        });
    } catch (error) {
        console.error('Register Verify OTP Error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to verify OTP'
        });
    }
};

const getMe = async (req, res) => {
    try {
        const user = await User.findById(req.userId).select('-__v');

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        const existingReferralCode = user.referralCode || '';
        await user.ensureReferralCode();
        if (user.referralCode !== existingReferralCode) {
            await user.save();
        }

        res.status(200).json({
            success: true,
            user: serializeUser(user, {
                loginCount: user.loginCount
            })
        });
    } catch (error) {
        console.error('Get Me Error:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

const restoreAccount = async (req, res) => {
    try {
        const restoreToken = req.body?.restoreToken?.trim();

        if (!restoreToken) {
            return res.status(400).json({
                success: false,
                message: 'Restore token is required.'
            });
        }

        const user = await verifyRestoreToken(restoreToken);
        await restoreUserAccount(user);

        if (!user.referralCode) {
            await user.ensureReferralCode();
            await user.save();
        }

        const token = user.generateAuthToken();

        res.status(200).json({
            success: true,
            message: 'Account restored successfully.',
            token,
            user: serializeUser(user)
        });
    } catch (error) {
        console.error('Restore Account Error:', error);
        res.status(error.statusCode || 500).json({
            success: false,
            message: error.message || 'Failed to restore account'
        });
    }
};

module.exports = {
    sendOTP,
    registerSendOTP,
    verifyOTP,
    registerVerifyOTP,
    getMe,
    restoreAccount
};
