const crypto = require('crypto');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const REFERRAL_ANCHOR = 'ANVI';

function pickReferralInitial({ name = '', email = '' } = {}) {
    const raw = String(name || email || 'A').trim();
    const letter = raw.match(/[A-Za-z]/)?.[0] || 'A';
    return letter.toUpperCase();
}

function randomDigits(length) {
    const max = 10 ** length;
    const min = 10 ** (length - 1);
    return crypto.randomInt(min, max).toString();
}

function buildReferralCandidate({ name = '', email = '' } = {}) {
    const initial = pickReferralInitial({ name, email });
    return `${REFERRAL_ANCHOR}${initial}${randomDigits(4)}`;
}

function buildFallbackReferralCode({ name = '', email = '' } = {}) {
    const initial = pickReferralInitial({ name, email });
    return `${REFERRAL_ANCHOR}${initial}${randomDigits(4)}`;
}

const ActivitySchema = new mongoose.Schema({
    title: { type: String, default: 'Account activity' },
    message: { type: String, default: '' },
    amount: { type: Number, default: 0 },
    type: { type: String, default: 'wallet' },
    direction: { type: String, default: 'credit' },
    status: { type: String, default: 'completed' },
    time: { type: Date, default: Date.now },
    taskId: { type: String, default: '' }
}, { _id: true });

const PendingEmailChangeSchema = new mongoose.Schema({
    newEmail: { type: String, default: '', lowercase: true, trim: true },
    oldEmailOtpHash: { type: String, default: '' },
    oldEmailOtpExpiresAt: { type: Date, default: null },
    oldEmailOtpAttempts: { type: Number, default: 0 },
    oldEmailOtpRequestedAt: { type: Date, default: null },
    oldEmailVerifiedAt: { type: Date, default: null },
    newEmailOtpHash: { type: String, default: '' },
    newEmailOtpExpiresAt: { type: Date, default: null },
    newEmailOtpAttempts: { type: Number, default: 0 },
    newEmailOtpRequestedAt: { type: Date, default: null }
}, { _id: false });

const UserSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, lowercase: true },
    name: { type: String, default: 'AnviPayz Member' },
    phone: { type: String, default: undefined, trim: true },
    avatarUrl: { type: String, default: '', trim: true },
    emailVerifiedAt: { type: Date, default: null },
    points: { type: Number, default: 0 },
    tokens: { type: Number, default: 0 },
    tokensConverted: { type: Number, default: 0 },
    referralEarnings: { type: Number, default: 0 },
    taskEarnings: { type: Number, default: 0 },
    surveyEarnings: { type: Number, default: 0 },
    referredByCode: { type: String, default: '', trim: true, uppercase: true },
    loginCount: { type: Number, default: 0 },
    lastLogin: { type: Date },
    joinedAt: { type: Date, default: Date.now },
    accountStatus: { type: String, default: 'active', enum: ['active', 'pending_deletion'] },
    deletionRequestedAt: { type: Date, default: null },
    deleteAfter: { type: Date, default: null },
    termsAcceptedAt: { type: Date, default: null },
    acceptedPolicyVersion: { type: String, default: '' },
    referralCode: { type: String, default: '', trim: true, uppercase: true },
    rewardClaimKeys: { type: [String], default: [] },
    activity: { type: [ActivitySchema], default: [] },
    pendingEmailChange: { type: PendingEmailChangeSchema, default: () => ({}) }
});

UserSchema.statics.generateUniqueReferralCode = async function({ name = '', email = '', excludeUserId = null } = {}) {
    for (let attempt = 0; attempt < 25; attempt += 1) {
        const candidate = buildReferralCandidate({ name, email });
        const existingUser = await this.findOne({
            referralCode: candidate,
            ...(excludeUserId ? { _id: { $ne: excludeUserId } } : {})
        }).select('_id');

        if (!existingUser) {
            return candidate;
        }
    }

    return buildFallbackReferralCode({ name, email });
};

UserSchema.methods.ensureReferralCode = async function() {
    const User = this.constructor;

    if (this.referralCode) {
        const duplicate = await User.findOne({
            referralCode: this.referralCode,
            _id: { $ne: this._id }
        }).select('_id joinedAt createdAt');

        if (!duplicate) {
            return this.referralCode;
        }

        const thisStamp = this.joinedAt || this.createdAt || (this._id?.getTimestamp ? this._id.getTimestamp() : null);
        const dupStamp = duplicate.joinedAt || duplicate.createdAt || (duplicate._id?.getTimestamp ? duplicate._id.getTimestamp() : null);

        if (thisStamp && dupStamp && thisStamp <= dupStamp) {
            return this.referralCode;
        }
    }

    this.referralCode = await this.constructor.generateUniqueReferralCode({
        name: this.name,
        email: this.email,
        excludeUserId: this._id || null
    });

    return this.referralCode;
};

UserSchema.pre('validate', async function(next) {
    try {
        if (!this.referralCode) {
            await this.ensureReferralCode();
        }
        next();
    } catch (error) {
        next(error);
    }
});

UserSchema.methods.generateAuthToken = function() {
    if (!process.env.JWT_SECRET) {
        throw new Error('JWT_SECRET is missing in environment variables');
    }
    return jwt.sign({ id: this._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
};

UserSchema.methods.clearPendingEmailChange = function() {
    this.pendingEmailChange = {
        newEmail: '',
        oldEmailOtpHash: '',
        oldEmailOtpExpiresAt: null,
        oldEmailOtpAttempts: 0,
        oldEmailOtpRequestedAt: null,
        oldEmailVerifiedAt: null,
        newEmailOtpHash: '',
        newEmailOtpExpiresAt: null,
        newEmailOtpAttempts: 0,
        newEmailOtpRequestedAt: null
    };
    return this.pendingEmailChange;
};

module.exports = mongoose.model('User', UserSchema);
