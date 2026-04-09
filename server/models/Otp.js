const mongoose = require('mongoose');
const crypto = require('crypto');

const OtpSchema = new mongoose.Schema({
    email: { type: String, required: true, lowercase: true },
    otpHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    referCode: { type: String, default: null },  // Store referCode from registration
    createdAt: { type: Date, default: Date.now }
});

// Static methods for OTP handling
OtpSchema.statics.generateOTP = function () {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

OtpSchema.statics.hashOTP = function (otp) {
    return crypto.createHash('sha256').update(otp).digest('hex');
};

OtpSchema.statics.canRequestOTP = async function (email) {
    const lastOTP = await this.findOne({ email }).sort({ createdAt: -1 });
    if (!lastOTP) return true;
    const diff = (Date.now() - lastOTP.createdAt.getTime()) / 1000;
    return diff >= 30; // 30 seconds rate limit
};

OtpSchema.statics.findValidOTP = async function (email) {
    return await this.findOne({
        email: email.toLowerCase(),
        expiresAt: { $gt: Date.now() },
        attempts: { $lt: 5 } // Max 5 attempts rule
    }).sort({ createdAt: -1 });
};

// Instance method to verify
OtpSchema.methods.verifyOTP = async function (otp) {
    const hash = crypto.createHash('sha256').update(otp).digest('hex');
    if (this.otpHash !== hash) {
        this.attempts += 1;
        await this.save();
        return { success: false, message: 'Invalid OTP' };
    }
    return { success: true };
};

module.exports = mongoose.model('Otp', OtpSchema);