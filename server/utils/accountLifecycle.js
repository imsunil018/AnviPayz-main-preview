const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const Notification = require('../models/Notification');
const NotificationRead = require('../models/NotificationRead');

const RECOVERY_WINDOW_DAYS = 7;
const ACCOUNT_STATUS_ACTIVE = 'active';
const ACCOUNT_STATUS_PENDING_DELETION = 'pending_deletion';
const RESTORE_TOKEN_PURPOSE = 'account-restore';

function addDays(value, days) {
    const next = new Date(value);
    next.setDate(next.getDate() + days);
    return next;
}

function isPendingDeletion(user) {
    return user?.accountStatus === ACCOUNT_STATUS_PENDING_DELETION && user?.deleteAfter;
}

function isDeletionExpired(user) {
    return Boolean(isPendingDeletion(user) && new Date(user.deleteAfter).getTime() <= Date.now());
}

function getDeletionMetadata(user) {
    return {
        accountStatus: user?.accountStatus || ACCOUNT_STATUS_ACTIVE,
        deletionRequestedAt: user?.deletionRequestedAt || null,
        deleteAfter: user?.deleteAfter || null,
        recoveryWindowDays: RECOVERY_WINDOW_DAYS
    };
}

async function purgeUserData(user) {
    if (!user?._id) {
        return;
    }

    const userId = String(user._id);
    const userEmail = String(user.email || '').trim().toLowerCase();

    await Promise.all([
        userEmail
            ? mongoose.connection.collection('otps').deleteMany({ email: userEmail }).catch(() => null)
            : Promise.resolve(),
        Notification.deleteMany({ userId }).catch(() => null),
        NotificationRead.deleteMany({ userId }).catch(() => null),
        User.deleteOne({ _id: user._id })
    ]);
}

async function purgeUserIfExpired(user) {
    if (!isDeletionExpired(user)) {
        return false;
    }

    await purgeUserData(user);
    return true;
}

async function runScheduledDeletionSweep() {
    const expiredUsers = await User.find({
        accountStatus: ACCOUNT_STATUS_PENDING_DELETION,
        deleteAfter: { $lte: new Date() }
    }).select('_id email');

    for (const user of expiredUsers) {
        await purgeUserData(user);
    }
}

async function scheduleUserDeletion(user) {
    user.accountStatus = ACCOUNT_STATUS_PENDING_DELETION;
    user.deletionRequestedAt = new Date();
    user.deleteAfter = addDays(user.deletionRequestedAt, RECOVERY_WINDOW_DAYS);
    await user.save();
    return user;
}

async function restoreUserAccount(user) {
    user.accountStatus = ACCOUNT_STATUS_ACTIVE;
    user.deletionRequestedAt = null;
    user.deleteAfter = null;
    user.lastLogin = new Date();
    await user.save();
    return user;
}

function createRestoreToken(user) {
    return jwt.sign({
        id: String(user._id),
        purpose: RESTORE_TOKEN_PURPOSE
    }, process.env.JWT_SECRET, { expiresIn: '30m' });
}

async function verifyRestoreToken(token) {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.purpose !== RESTORE_TOKEN_PURPOSE) {
        const error = new Error('Invalid restore token.');
        error.statusCode = 401;
        throw error;
    }

    const userId = decoded.id || decoded.userId;
    const user = await User.findById(userId);

    if (!user) {
        const error = new Error('Account not found.');
        error.statusCode = 404;
        throw error;
    }

    if (await purgeUserIfExpired(user)) {
        const error = new Error('Recovery window has expired. Please create a new account.');
        error.statusCode = 410;
        throw error;
    }

    if (!isPendingDeletion(user)) {
        const error = new Error('This account is already active.');
        error.statusCode = 400;
        throw error;
    }

    return user;
}

module.exports = {
    ACCOUNT_STATUS_ACTIVE,
    ACCOUNT_STATUS_PENDING_DELETION,
    RECOVERY_WINDOW_DAYS,
    createRestoreToken,
    getDeletionMetadata,
    isPendingDeletion,
    purgeUserData,
    purgeUserIfExpired,
    restoreUserAccount,
    runScheduledDeletionSweep,
    scheduleUserDeletion,
    verifyRestoreToken
};
