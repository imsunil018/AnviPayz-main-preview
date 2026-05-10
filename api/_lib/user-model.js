const crypto = require('crypto');
const mongoose = require('mongoose');

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

const UserSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, default: 'AnviPayz Member' },
    phone: { type: String, default: undefined, trim: true },
    points: { type: Number, default: 0 },
    tokens: { type: Number, default: 0 },
    referralEarnings: { type: Number, default: 0 },
    loginCount: { type: Number, default: 0 },
    lastLogin: { type: Date },
    joinedAt: { type: Date, default: Date.now },
    referralCode: { type: String, default: '', trim: true, uppercase: true },
    rewardClaimKeys: { type: [String], default: [] },
    otp: String,
    otpExpires: Date
}, {
    versionKey: false
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
    if (this.referralCode) {
        return this.referralCode;
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

const User = mongoose.models.ApiUser || mongoose.model('ApiUser', UserSchema, 'users');

let preparePromise = null;

async function connectToDatabase() {
    if (mongoose.connection.readyState !== 1) {
        await mongoose.connect(process.env.MONGO_URI);
    }
}

async function prepareUserCollection() {
    await connectToDatabase();

    if (!preparePromise) {
        preparePromise = (async () => {
            const indexes = await User.collection.indexes();
            const legacyPhoneIndex = indexes.find((index) => index.name === 'phone_1');
            const referralIndex = indexes.find((index) => index.name === 'referralCode_1');

            if (legacyPhoneIndex?.unique && !legacyPhoneIndex.sparse && !legacyPhoneIndex.partialFilterExpression) {
                console.warn('Dropping legacy users.phone_1 unique index because it blocks multiple users with no phone number.');
                try {
                    await User.collection.dropIndex('phone_1');
                } catch (error) {
                    if (error.codeName !== 'IndexNotFound') {
                        throw error;
                    }
                }
            }

            if (referralIndex?.unique && !referralIndex.partialFilterExpression) {
                console.warn('Replacing legacy users.referralCode_1 unique index with a partial unique index.');
                try {
                    await User.collection.dropIndex('referralCode_1');
                } catch (error) {
                    if (error.codeName !== 'IndexNotFound') {
                        throw error;
                    }
                }
            }

            const refreshedIndexes = await User.collection.indexes();
            const partialReferralIndex = refreshedIndexes.find((index) =>
                index.name === 'referralCode_1' && index.unique && index.partialFilterExpression
            );

            if (!partialReferralIndex) {
                await User.collection.createIndex(
                    { referralCode: 1 },
                    {
                        name: 'referralCode_1',
                        unique: true,
                        partialFilterExpression: { referralCode: { $type: 'string' } }
                    }
                );
            }
        })().catch((error) => {
            preparePromise = null;
            throw error;
        });
    }

    await preparePromise;
    return User;
}

module.exports = {
    connectToDatabase,
    prepareUserCollection
};
