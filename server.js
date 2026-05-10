const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT);
const connectDB = require('./server/config/db');
const authRoutes = require('./server/routes/auth');
const userRoutes = require('./server/routes/user');
const User = require('./server/models/User');
const Task = require('./server/models/Task');
const AdminEvent = require('./server/models/AdminEvent');
const Notification = require('./server/models/Notification');
const NotificationRead = require('./server/models/NotificationRead');
const {
    getDeletionMetadata,
    isPendingDeletion,
    purgeUserData,
    purgeUserIfExpired,
    runScheduledDeletionSweep,
    scheduleUserDeletion
} = require('./server/utils/accountLifecycle');

const envResult = require('dotenv').config({ path: path.join(__dirname, '.env') });
const NODE_ENV = String(process.env.NODE_ENV || 'development').trim().toLowerCase();
const ALLOWED_ORIGINS = [
    'https://anvi-payz-main-preview.vercel.app',
    'http://127.0.0.1:5501',
    'http://localhost:5501',
    'https://anvipayz-main-preview-production.up.railway.app'
];

if (envResult.error) {
    console.warn('WARNING: Could not find or read .env file. Using process environment.');
} else {
    console.log('[System] .env file loaded successfully');
}

if (!isServerless && !fs.existsSync(path.join(__dirname, 'node_modules'))) {
    console.error("ERROR: 'node_modules' not found. Please run 'npm install' first.");
    process.exit(1);
}

const allowedOrigins = [...ALLOWED_ORIGINS];
const requiredEnv = ['MONGO_URI', 'JWT_SECRET', 'BREVO_API_KEY'];
const missingEnv = requiredEnv.filter((key) => !String(process.env[key] || '').trim());
if (missingEnv.length > 0) {
    const errorMessage = `CRITICAL ERROR: Missing environment variables in .env: ${missingEnv.join(', ')}`;
    console.error(errorMessage);
    if (isServerless) {
        throw new Error(errorMessage);
    }
    process.exit(1);
}

console.log(`[Config] Port: ${process.env.PORT || 5050}`);
console.log(`[Config] Environment: ${NODE_ENV}`);
console.log(`[Config] Allowed frontend origins: ${allowedOrigins.join(', ')}`);

const app = express();

app.disable('x-powered-by');
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));
app.use(cors({
    origin(origin, callback) {
        const isAllowed = !origin || allowedOrigins.includes(origin);

        if (isAllowed) {
            callback(null, true);
            return;
        }

        console.warn(`[CORS] Origin denied: ${origin}`);
        callback(new Error('CORS origin denied'));
    },
    credentials: true
}));

const GLOBAL_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const GLOBAL_RATE_LIMIT_MAX = 300;
const globalRateLimitStore = new Map();

app.use((req, res, next) => {
    const key = String(req.ip || req.connection?.remoteAddress || 'global');
    const now = Date.now();
    const recent = (globalRateLimitStore.get(key) || []).filter((ts) => now - ts < GLOBAL_RATE_LIMIT_WINDOW_MS);

    if (recent.length >= GLOBAL_RATE_LIMIT_MAX) {
        return res.status(429).json({ message: 'Too many requests. Please slow down.' });
    }

    recent.push(now);
    globalRateLimitStore.set(key, recent);
    next();
});
app.use(express.json());

app.use((req, res, next) => {
    console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
    next();
});

app.use(async (req, res, next) => {
    try {
        if (Date.now() - lastDeletionSweepAt > 10 * 60 * 1000) {
            lastDeletionSweepAt = Date.now();
            await runScheduledDeletionSweep();
        }
    } catch (error) {
        console.warn('Scheduled deletion sweep failed:', error.message);
    }

    next();
});

connectDB();

app.get('/api/test', (req, res) => {
    const dbStatus = global.__ANVI_DB_STATUS__ || null;
    res.json({
        message: 'Backend is running!',
        status: 'OK',
        database: mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected',
        dbStatus
    });
});

// If MongoDB is offline/unreachable, fail fast so the frontend doesn't sit in "Loading...".
app.use('/api', (req, res, next) => {
    // Allow admin sign-in and basic health checks even when MongoDB is offline.
    // The admin dashboard will still show a "DB offline" state for data-driven routes.
    const normalizedPath = String(req.path || "").replace(/\/+$/, "") || "/";
    const bypassDbGuard =
        normalizedPath === '/test' ||
        normalizedPath === '/admin/login' ||
        normalizedPath === '/admin/auth/login';

    if (bypassDbGuard) {
        next();
        return;
    }

    if (mongoose.connection.readyState !== 1) {
        return res.status(503).json({
            message: 'Database unavailable. Start MongoDB (or verify MONGO_URI / Atlas IP whitelist) and try again.',
            code: 'DB_OFFLINE',
            hint: 'If using MongoDB Atlas, add your current IP in Network Access (or allow 0.0.0.0/0 for dev).'
        });
    }

    next();
});

app.use('/api', authRoutes);
app.use('/api/user', userRoutes);

const INDIA_TIME_ZONE = 'Asia/Kolkata';
const DEFAULT_TASK_SEEDS = [
    {
        title: 'Daily Check-in',
        description: 'Open the app once a day to keep your streak active.',
        rewardPoints: 10,
        taskType: 'daily'
    },
    {
        title: 'Watch Tutorial',
        description: 'Watch the guided tutorial for 10 seconds.',
        rewardPoints: 15,
        taskType: 'video'
    },
    {
        title: 'Invite a Friend',
        description: 'Invite one friend and grow your reward network.',
        rewardPoints: 50,
        taskType: 'task'
    }
];
const STATIC_REWARD_RULES = Object.freeze({
    'daily-checkin': {
        source: 'task',
        title: 'Daily Check-in',
        points: 10,
        claimMode: 'daily',
        earningsField: 'taskEarnings'
    },
    'watch-tutorial': {
        source: 'task',
        title: 'Watch Tutorial',
        points: 15,
        claimMode: 'daily',
        earningsField: 'taskEarnings'
    },
    survey_001: {
        source: 'survey',
        title: 'Product Feedback Survey',
        points: 50,
        claimMode: 'once',
        earningsField: 'surveyEarnings'
    },
    survey_002: {
        source: 'survey',
        title: 'User Experience Survey',
        points: 75,
        claimMode: 'once',
        earningsField: 'surveyEarnings'
    },
    survey_003: {
        source: 'survey',
        title: 'Market Research Survey',
        points: 100,
        claimMode: 'once',
        earningsField: 'surveyEarnings'
    }
});
const SPIN_REWARDS = Object.freeze([5, 10, 15, 20, 25, 40, 60, 100]);
const NOTIFICATION_RETENTION_DAYS = 30;
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '').trim();
const REWARD_TOKEN_TTL = '5m';
const CONVERT_RATIO_POINTS = 1000;
const MIN_CONVERTIBLE_POINTS_STEP = 10;

// Referral Bonus Constants
const REFER_POINTS_PER_USER = 250;           // 250 points per successful referral
const REFER_NEW_USER_POINTS = 150;            // 150 points for the new user (on signup via referral code)
const REFER_BONUS_MILESTONE = 15;             // Bonus milestone every 15 referrals
const REFER_BONUS_POINTS = 1000;              // 1000 points per milestone
const REFER_DAILY_LIMIT = 10;                 // Max 10 referrals per day

let taskCatalogPromise = null;
let lastDeletionSweepAt = 0;
const rateLimitStore = new Map();

if ((ADMIN_EMAIL && !ADMIN_PASSWORD) || (!ADMIN_EMAIL && ADMIN_PASSWORD)) {
    console.warn('Admin login is disabled until both ADMIN_EMAIL and ADMIN_PASSWORD are set.');
}

function getTokenFromRequest(req) {
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
        return req.headers.authorization.split(' ')[1];
    }

    return '';
}

async function getAuthenticatedUser(req) {
    const token = getTokenFromRequest(req);

    if (!token) {
        const error = new Error('No token provided');
        error.statusCode = 401;
        throw error;
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.id || decoded.userId;
    const user = await User.findById(userId);

    if (!user) {
        const error = new Error('User not found');
        error.statusCode = 404;
        throw error;
    }

    if (await purgeUserIfExpired(user)) {
        const error = new Error('User not found');
        error.statusCode = 404;
        throw error;
    }

    if (isPendingDeletion(user)) {
        const error = new Error('This account is scheduled for permanent deletion. Restore it to continue.');
        error.statusCode = 423;
        error.code = 'ACCOUNT_PENDING_DELETION';
        error.recovery = getDeletionMetadata(user);
        throw error;
    }

    if (!user.referralCode) {
        await user.ensureReferralCode();
        await user.save();
    }

    return user;
}

function getAdminCredentialsConfigured() {
    return Boolean(ADMIN_EMAIL && ADMIN_PASSWORD);
}

function createAdminToken() {
    return jwt.sign({
        role: 'admin',
        email: ADMIN_EMAIL
    }, process.env.JWT_SECRET, { expiresIn: '12h' });
}

function verifyAdminRequest(req) {
    const token = getTokenFromRequest(req);

    if (!token) {
        const error = new Error('No admin token provided');
        error.statusCode = 401;
        throw error;
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'admin') {
        const error = new Error('Admin access denied');
        error.statusCode = 403;
        throw error;
    }

    return decoded;
}

function roundTo(value, digits = 2) {
    const factor = 10 ** digits;
    return Math.round((Number(value) || 0) * factor) / factor;
}

function indiaDateKey(value = Date.now()) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: INDIA_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(new Date(value));
}

function enforceUserRateLimit(userId, scope, { limit, windowMs }) {
    const key = `${scope}:${String(userId || 'guest')}`;
    const now = Date.now();
    const recentHits = (rateLimitStore.get(key) || []).filter((timestamp) => now - timestamp < windowMs);

    if (recentHits.length >= limit) {
        const error = new Error('Too many requests. Please slow down and try again.');
        error.statusCode = 429;
        error.code = 'RATE_LIMITED';
        throw error;
    }

    recentHits.push(now);
    rateLimitStore.set(key, recentHits);
}

function sanitizeTaskIdentifier(value) {
    return String(value || '').trim();
}

function buildSlugBase(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

async function buildUniqueTaskSlug(title) {
    const base = buildSlugBase(title) || 'task';
    let slug = base;
    let attempt = 1;

    while (await Task.exists({ slug })) {
        slug = `${base}-${attempt}`;
        attempt += 1;
        if (attempt > 30) {
            slug = `${base}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            break;
        }
    }

    return slug;
}

function buildClaimKey({ source, taskId = '', claimMode = 'once', dateKey = indiaDateKey() }) {
    const base = `${String(source || 'task').trim().toLowerCase()}:${sanitizeTaskIdentifier(taskId) || 'default'}`;
    return claimMode === 'daily' ? `${base}:${dateKey}` : base;
}

function hasClaimKey(user, claimKey) {
    return Array.isArray(user?.rewardClaimKeys) && user.rewardClaimKeys.includes(claimKey);
}

function inferTaskClaimMode(taskType, taskId = '') {
    const normalizedTaskType = String(taskType || '').trim().toLowerCase();
    const normalizedTaskId = sanitizeTaskIdentifier(taskId);

    if (normalizedTaskId === 'daily-checkin' || normalizedTaskId === 'watch-tutorial' || normalizedTaskId === 'daily-spin') {
        return 'daily';
    }

    if (normalizedTaskType === 'daily' || normalizedTaskType === 'video') {
        return 'daily';
    }

    return 'once';
}

function verifySpinRewardToken(token, userId) {
    if (!token) {
        const error = new Error('Spin reward token is required.');
        error.statusCode = 422;
        throw error;
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.kind !== 'spin-reward' || String(decoded.userId) !== String(userId)) {
        const error = new Error('Invalid spin reward token.');
        error.statusCode = 401;
        throw error;
    }

    const points = Math.floor(Number(decoded.points || 0));
    if (!SPIN_REWARDS.includes(points)) {
        const error = new Error('Spin reward token contains an invalid reward.');
        error.statusCode = 400;
        throw error;
    }

    return {
        points,
        claimKey: String(decoded.claimKey || ''),
        title: 'Spin & Win'
    };
}

async function ensureTaskCatalog() {
    if (taskCatalogPromise) {
        return taskCatalogPromise;
    }

    taskCatalogPromise = (async () => {
        const totalTasks = await Task.countDocuments();
        if (totalTasks === 0) {
            const usedSlugs = new Set();
            await Task.insertMany(DEFAULT_TASK_SEEDS.map((task) => ({
                ...task,
                slug: (() => {
                    const base = buildSlugBase(task.title) || 'task';
                    let slug = base;
                    let index = 1;
                    while (usedSlugs.has(slug)) {
                        slug = `${base}-${index}`;
                        index += 1;
                    }
                    usedSlugs.add(slug);
                    return slug;
                })(),
                status: 'active'
            })));
        }

        await ensureTaskSlugs();
    })().finally(() => {
        taskCatalogPromise = null;
    });

    return taskCatalogPromise;
}

async function ensureTaskSlugs() {
    const missing = await Task.find({
        $or: [
            { slug: { $exists: false } },
            { slug: null },
            { slug: '' }
        ]
    }).lean();

    if (!missing.length) {
        return;
    }

    const existing = await Task.find({
        slug: { $nin: [null, ''] }
    }).select('slug').lean();
    const used = new Set(existing.map((item) => String(item.slug)));

    for (const task of missing) {
        const base = buildSlugBase(task.title) || `task-${String(task._id).slice(-6)}`;
        let slug = base;
        let attempt = 1;
        while (used.has(slug)) {
            slug = `${base}-${attempt}`;
            attempt += 1;
        }

        await Task.updateOne({ _id: task._id }, { $set: { slug } });
        used.add(slug);
    }
}

function serializeActivityEntry(entry) {
    const source = entry && typeof entry.toObject === 'function' ? entry.toObject() : (entry || {});

    return {
        id: String(source._id || source.id || ''),
        title: source.title || 'Account activity',
        message: source.message || '',
        amount: Number(source.amount || 0),
        type: source.type || 'wallet',
        direction: source.direction || 'credit',
        status: source.status || 'completed',
        time: source.time || new Date(),
        taskId: source.taskId || ''
    };
}

function serializeActivityList(activity) {
    return (Array.isArray(activity) ? activity : [])
        .map(serializeActivityEntry)
        .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
}

async function logAdminEvent(message, type = 'system', meta = {}) {
    try {
        await AdminEvent.create({ message, type, meta });
    } catch (error) {
        console.warn('Admin event log failed:', error.message);
    }
}

function buildAdminFeedEntries(users, adminEvents) {
    const memberEntries = users.flatMap((user) => serializeActivityList(user.activity).slice(0, 8).map((entry) => ({
        message: `${user.name || 'Member'}: ${entry.message || entry.title}`,
        time: entry.time,
        type: entry.type || 'member'
    })));

    const eventEntries = (Array.isArray(adminEvents) ? adminEvents : []).map((entry) => ({
        message: entry.message || 'Admin activity',
        time: entry.createdAt || entry.updatedAt || new Date(),
        type: entry.type || 'system'
    }));

    return [...eventEntries, ...memberEntries]
        .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
        .slice(0, 40);
}

function serializeUser(user) {
    return {
        _id: user._id,
        id: user._id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        avatarUrl: user.avatarUrl || '',
        points: user.points || 0,
        tokens: roundTo(user.tokens || 0, 2),
        referralEarnings: user.referralEarnings || 0,
        taskEarnings: user.taskEarnings || 0,
        surveyEarnings: user.surveyEarnings || 0,
        referralCode: user.referralCode,
        joinedAt: user.joinedAt,
        lastLogin: user.lastLogin,
        emailVerifiedAt: user.emailVerifiedAt || user.joinedAt || null,
        loginCount: user.loginCount || 0,
        ...getDeletionMetadata(user)
    };
}

function serializeTask(task) {
    return {
        _id: task._id,
        id: task._id,
        title: task.title,
        description: task.description || '',
        link: task.link || '',
        rewardPoints: task.rewardPoints || 0,
        taskType: task.taskType || 'task',
        status: task.status || 'active',
        createdAt: task.createdAt || new Date()
    };
}

function serializeNotification(notification) {
    const source = notification && typeof notification.toObject === 'function'
        ? notification.toObject()
        : (notification || {});

    return {
        id: String(source._id || source.id || ''),
        title: source.title || 'Notification',
        message: source.message || '',
        type: source.type || 'system',
        link: source.link || '',
        time: source.createdAt || source.time || new Date()
    };
}

function buildReferralCountMap(users) {
    const counts = new Map();

    users.forEach((user) => {
        const key = String(user.referredByCode || '').trim().toUpperCase();
        if (!key) {
            return;
        }

        counts.set(key, (counts.get(key) || 0) + 1);
    });

    return counts;
}

async function calculateUserRank(userId) {
    try {
        const users = await User.find({}).select('referralCode _id');
        const referralCounts = buildReferralCountMap(users);
        
        const rankings = users
            .map(u => ({
                userId: String(u._id),
                refCount: referralCounts.get(u.referralCode) || 0
            }))
            .sort((a, b) => b.refCount - a.refCount);
        
        const rank = rankings.findIndex(r => r.userId === String(userId)) + 1;
        return rank > 0 ? rank : users.length;
    } catch (error) {
        return 0;
    }
}

function serializeAdminUser(user, referralCounts) {
    const referralCode = String(user.referralCode || '').trim().toUpperCase();
    const tokensConverted = getUserTokensConverted(user);
    return {
        id: user._id,
        _id: user._id,
        fullName: user.name || 'AnviPayz Member',
        email: user.email || '',
        phone: user.phone || '-',
        balance: Number(user.points || 0),
        tokens: Number(user.tokens || 0),
        tokensConverted,
        totalReferrals: referralCounts.get(referralCode) || 0,
        joinedAt: user.joinedAt || user.createdAt || new Date(),
        lastActive: user.lastLogin || user.joinedAt || new Date(),
        joinType: user.referredByCode ? 'referral' : 'direct'
    };
}

function getUserTokensConverted(user) {
    const directValue = Number(user.tokensConverted);
    if (Number.isFinite(directValue)) {
        return directValue;
    }

    const activity = Array.isArray(user.activity) ? user.activity : [];
    const activityTotal = activity.reduce((sum, entry) => {
        if (entry?.type === 'convert') {
            return sum + Number(entry.amount || 0);
        }
        return sum;
    }, 0);

    if (activityTotal > 0) {
        return activityTotal;
    }

    return Number(user.tokens || 0);
}

function buildUserStats(user) {
    return {
        points: user.points || 0,
        referralEarnings: user.referralEarnings || 0,
        taskRewards: user.taskEarnings || 0,
        surveyEarnings: user.surveyEarnings || 0
    };
}

function buildDashboardPayload(user) {
    return {
        user: serializeUser(user),
        stats: buildUserStats(user),
        history: serializeActivityList(user.activity).slice(0, 12)
    };
}

function buildWalletPayload(user) {
    return {
        user: serializeUser(user),
        balance: user.points || 0,
        stats: buildUserStats(user),
        transactions: serializeActivityList(user.activity).slice(0, 30)
    };
}

function maskEmail(email) {
    const raw = String(email || '').trim();
    if (!raw || !raw.includes('@')) {
        return '';
    }

    const [local, domain] = raw.split('@');
    if (!local || !domain) {
        return '';
    }

    const visibleStart = local.slice(0, Math.min(6, local.length));
    const prefix = visibleStart || '*';
    return `${prefix}****@${domain}`;
}

async function buildReferralPayload(user) {
    const referredUsers = await User.find({ referredByCode: user.referralCode })
        .sort({ joinedAt: -1 })
        .select('name email joinedAt');

    // Calculate global leaderboard (Top 10 referrers) with bonus
    const allUsers = await User.find({}).select('name email referralCode referralEarnings');
    const referralCounts = buildReferralCountMap(await User.find({}));
    const weekStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const weeklyReferredUsers = await User.find({
        referredByCode: { $ne: '' },
        joinedAt: { $gte: weekStart }
    }).select('referredByCode');
    const weeklyReferralCounts = buildReferralCountMap(weeklyReferredUsers);

    const calculateBonusPoints = (referralCount) => Math.floor(Math.max(Number(referralCount || 0), 0) / REFER_BONUS_MILESTONE) * REFER_BONUS_POINTS;

    const leaderboard = allUsers
        .map(u => {
            const refCount = referralCounts.get(u.referralCode) || 0;
            const baseEarnings = refCount * REFER_POINTS_PER_USER;
            const bonusPoints = calculateBonusPoints(refCount);
            return {
                id: u._id,
                username: u.name,
                emailMasked: maskEmail(u.email),
                referrals: refCount,
                points: baseEarnings + bonusPoints,
                bonus: bonusPoints,
                isMe: String(u._id) === String(user._id)
            };
        })
        .filter((entry) => entry.referrals > 0)
        .sort((a, b) => (b.referrals - a.referrals) || (b.points - a.points))
        .slice(0, 10);

    const weeklyLeaderboard = allUsers
        .map((u) => {
            const refCount = weeklyReferralCounts.get(u.referralCode) || 0;
            const baseEarnings = refCount * REFER_POINTS_PER_USER;
            return {
                id: u._id,
                username: u.name,
                emailMasked: maskEmail(u.email),
                referrals: refCount,
                points: baseEarnings,
                bonus: 0,
                isMe: String(u._id) === String(user._id)
            };
        })
        .filter((entry) => entry.referrals > 0)
        .sort((a, b) => (b.referrals - a.referrals) || (b.points - a.points))
        .slice(0, 10);

    const userRefCount = referralCounts.get(user.referralCode) || 0;
    const bonusPoints = calculateBonusPoints(userRefCount);
    const computedEarnings = (userRefCount * REFER_POINTS_PER_USER) + bonusPoints;
    const storedEarnings = Number(user.referralEarnings || 0);
    const totalEarnings = storedEarnings > 0 ? storedEarnings : computedEarnings;
    const bonusCycleProgress = userRefCount % REFER_BONUS_MILESTONE;
    const bonusRemaining = bonusCycleProgress === 0 ? REFER_BONUS_MILESTONE : (REFER_BONUS_MILESTONE - bonusCycleProgress);

    return {
        user: serializeUser(user),
        referralCode: user.referralCode,
        totalReferrals: referredUsers.length,
        totalEarnings,
        referralPointsPerJoin: REFER_POINTS_PER_USER,
        newUserSignupBonus: REFER_NEW_USER_POINTS,
        bonusMilestone: REFER_BONUS_MILESTONE,
        milestoneBonusPoints: REFER_BONUS_POINTS,
        bonusCycleProgress,
        bonusRemaining,
        bonusUnlocked: userRefCount >= REFER_BONUS_MILESTONE,
        bonusPoints,
        pendingRewards: 0,
        todayReferrals: referredUsers.filter((item) => indiaDateKey(item.joinedAt || Date.now()) === indiaDateKey()).length,
        dailyLimit: REFER_DAILY_LIMIT,
        leaderboard,
        weeklyLeaderboard,
        network: referredUsers.map((item) => ({
            name: item.name,
            email: item.email,
            reward: REFER_POINTS_PER_USER,
            time: item.joinedAt
        }))
    };
}

function hasClaimedReward(user, taskId, source) {
    if (!taskId) {
        return false;
    }

    const normalizedTaskId = sanitizeTaskIdentifier(taskId);
    const normalizedSource = source === 'survey'
        ? 'survey'
        : (source === 'spin' ? 'spin' : 'task');
    const claimMode = normalizedSource === 'survey'
        ? 'once'
        : inferTaskClaimMode(source === 'spin' ? 'daily' : source, normalizedTaskId);
    const claimKey = buildClaimKey({
        source: normalizedSource,
        taskId: normalizedTaskId,
        claimMode
    });

    if (hasClaimKey(user, claimKey)) {
        return true;
    }

    const existingEntries = (Array.isArray(user.activity) ? user.activity : [])
        .filter((entry) => entry.taskId === normalizedTaskId);

    if (!existingEntries.length) {
        return false;
    }

    if (claimMode === 'once') {
        return true;
    }

    const todayKey = indiaDateKey();
    return existingEntries.some((entry) => indiaDateKey(entry.time || Date.now()) === todayKey);
}

function prependActivity(user, entry) {
    const nextActivity = [entry, ...(Array.isArray(user.activity) ? user.activity : [])].slice(0, 50);
    user.activity = nextActivity;
    return user.activity[0];
}

function buildRewardTitle(source, fallbackTitle) {
    if (fallbackTitle) {
        return fallbackTitle;
    }

    if (source === 'survey') {
        return 'Survey reward';
    }

    if (source === 'spin') {
        return 'Spin reward';
    }

    if (source === 'referral') {
        return 'Referral reward';
    }

    return 'Task reward';
}

function normalizeTaskIdentifier(value) {
    return sanitizeTaskIdentifier(value);
}

function resolveRewardDefinition({ source, taskId, task, userId, spinRewardToken }) {
    if (source === 'spin') {
        const spinReward = verifySpinRewardToken(spinRewardToken, userId);
        return {
            source: 'spin',
            title: spinReward.title,
            points: spinReward.points,
            rewardType: 'spin',
            earningsField: 'taskEarnings',
            claimKey: spinReward.claimKey || buildClaimKey({
                source: 'spin',
                taskId: taskId || 'daily-spin',
                claimMode: 'daily'
            }),
            taskId: taskId || 'daily-spin',
            message: `Spin reward credited: ${spinReward.points} points.`
        };
    }

    if (task && source === 'task') {
        const claimMode = inferTaskClaimMode(task.taskType, String(task._id));
        return {
            source: 'task',
            title: task.title || 'Task reward',
            points: Math.floor(Number(task.rewardPoints || 0)),
            rewardType: 'task',
            earningsField: 'taskEarnings',
            claimKey: buildClaimKey({
                source: 'task',
                taskId: String(task._id),
                claimMode
            }),
            taskId: String(task._id),
            message: `${task.title || 'Task reward'} credited successfully.`
        };
    }

    const staticRule = STATIC_REWARD_RULES[taskId];
    if (staticRule && staticRule.source === source) {
        return {
            source,
            title: staticRule.title,
            points: staticRule.points,
            rewardType: source === 'survey' ? 'survey' : 'task',
            earningsField: staticRule.earningsField,
            claimKey: buildClaimKey({
                source,
                taskId,
                claimMode: staticRule.claimMode
            }),
            taskId,
            message: `${staticRule.title} credited successfully.`
        };
    }

    const error = new Error('Unsupported reward request.');
    error.statusCode = 422;
    throw error;
}

function notificationCutoffDate() {
    return new Date(Date.now() - (NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000));
}

function rewardNotificationLink(source) {
    if (source === 'spin') {
        return 'spin.html';
    }

    if (source === 'survey' || source === 'task') {
        return 'tasks.html';
    }

    if (source === 'referral') {
        return 'refer.html';
    }

    return 'notifications.html';
}

function buildRewardNotification(source, rewardTitle, points) {
    const label = rewardTitle || buildRewardTitle(source);
    const type = source === 'survey'
        ? 'survey'
        : (source === 'spin' ? 'spin' : (source === 'referral' ? 'referral' : 'task'));

    return {
        title: source === 'spin' ? 'Spin reward received' : `${label} completed`,
        message: `${label}: ${points} points credited to your account.`,
        type,
        link: rewardNotificationLink(source)
    };
}

async function createUserNotification({ userId, title, message, type = 'system', link = '', meta = {} }) {
    if (!userId || !title) {
        return null;
    }

    return Notification.create({
        title,
        message,
        type,
        audience: 'user',
        userId: String(userId),
        link,
        meta
    });
}

function sendRouteError(res, error, fallbackMessage) {
    const statusCode = error.statusCode
        || (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError' ? 401 : 500);
    const message = statusCode === 401
        ? 'Unauthorized'
        : (error.message || fallbackMessage);
    const payload = { message };

    if (error.code) {
        payload.code = error.code;
    }

    if (error.recovery) {
        payload.recovery = error.recovery;
    }

    console.error(fallbackMessage, error);
    res.status(statusCode).json(payload);
}

async function awardPoints(req, res, forcedSource = null) {
    try {
        await ensureTaskCatalog();
        const user = await getAuthenticatedUser(req);
        enforceUserRateLimit(user._id, 'reward-award', { limit: 12, windowMs: 60 * 1000 });
        const source = String(forcedSource || req.body?.source || 'task').trim().toLowerCase();
        const taskId = normalizeTaskIdentifier(req.body?.taskId);
        let task = null;

        if (taskId && mongoose.isValidObjectId(taskId)) {
            task = await Task.findById(taskId).lean();
        }

        const reward = resolveRewardDefinition({
            source,
            taskId,
            task,
            userId: user._id,
            spinRewardToken: req.body?.rewardToken
        });

        if (!Number.isFinite(reward.points) || reward.points <= 0) {
            return res.status(400).json({ message: 'Enter a valid points amount' });
        }

        if (reward.claimKey && (hasClaimKey(user, reward.claimKey) || hasClaimedReward(user, reward.taskId, reward.source))) {
            return res.status(409).json({ message: 'This reward is already claimed.' });
        }

        const rewardTitle = reward.title || buildRewardTitle(reward.source, task?.title);
        const activityEntry = {
            title: rewardTitle,
            message: reward.message || `${rewardTitle} credited successfully.`,
            amount: reward.points,
            type: reward.rewardType,
            direction: 'credit',
            status: 'completed',
            time: new Date(),
            taskId: reward.taskId || taskId || normalizeTaskIdentifier(task?._id)
        };

        const updatePipeline = [{
            $set: {
                points: { $add: [{ $ifNull: ['$points', 0] }, reward.points] },
                [reward.earningsField]: { $add: [{ $ifNull: [`$${reward.earningsField}`, 0] }, reward.points] },
                activity: {
                    $slice: [
                        {
                            $concatArrays: [
                                [activityEntry],
                                { $ifNull: ['$activity', []] }
                            ]
                        },
                        50
                    ]
                },
                ...(reward.claimKey ? {
                    rewardClaimKeys: {
                        $setUnion: [
                            { $ifNull: ['$rewardClaimKeys', []] },
                            [reward.claimKey]
                        ]
                    }
                } : {})
            }
        }];

        const updatedUser = await User.findOneAndUpdate(
            {
                _id: user._id,
                ...(reward.claimKey ? { rewardClaimKeys: { $ne: reward.claimKey } } : {})
            },
            updatePipeline,
            { new: true }
        );

        if (!updatedUser) {
            return res.status(409).json({ message: 'This reward is already claimed.' });
        }

        let notification = null;
        try {
            const rewardNotice = buildRewardNotification(reward.source, rewardTitle, reward.points);
            notification = await createUserNotification({
                userId: updatedUser._id,
                title: rewardNotice.title,
                message: rewardNotice.message,
                type: rewardNotice.type,
                link: rewardNotice.link,
                meta: {
                    taskId: reward.taskId || taskId || normalizeTaskIdentifier(task?._id),
                    points: reward.points,
                    source: reward.source
                }
            });
        } catch (notificationError) {
            console.warn('Reward notification create failed:', notificationError.message);
        }

        console.log(`Added ${reward.points} points to ${updatedUser.email} for ${reward.source}`);
        res.json({
            success: true,
            user: serializeUser(updatedUser),
            stats: buildUserStats(updatedUser),
            activityEntry: serializeActivityEntry(activityEntry),
            history: serializeActivityList(updatedUser.activity).slice(0, 12),
            notification: notification ? serializeNotification(notification) : null
        });
    } catch (error) {
        sendRouteError(res, error, 'Add points error:');
    }
}

app.post('/api/add-points', async (req, res) => {
    await awardPoints(req, res);
});

app.post('/api/tasks/complete', async (req, res) => {
    await awardPoints(req, res, 'task');
});

app.post('/api/spin', async (req, res) => {
    try {
        const user = await getAuthenticatedUser(req);
        enforceUserRateLimit(user._id, 'spin-reward', { limit: 8, windowMs: 60 * 1000 });
        const claimKey = buildClaimKey({
            source: 'spin',
            taskId: 'daily-spin',
            claimMode: 'daily'
        });

        if (hasClaimKey(user, claimKey) || hasClaimedReward(user, 'daily-spin', 'spin')) {
            return res.status(409).json({ message: 'Today\'s spin is already used.' });
        }

        const reward = SPIN_REWARDS[Math.floor(Math.random() * SPIN_REWARDS.length)];
        const rewardToken = jwt.sign({
            kind: 'spin-reward',
            userId: String(user._id),
            points: reward,
            claimKey
        }, process.env.JWT_SECRET, { expiresIn: REWARD_TOKEN_TTL });

        res.json({ points: reward, reward, rewardToken });
    } catch (error) {
        sendRouteError(res, error, 'Spin API error:');
    }
});

app.get('/api/tasks', async (req, res) => {
    try {
        await ensureTaskCatalog();
        const user = await getAuthenticatedUser(req);
        const tasks = await Task.find({ status: { $ne: 'archived' } })
            .sort({ createdAt: -1 })
            .lean();

        res.json(tasks.map((task) => ({
            ...serializeTask(task),
            completed: hasClaimedReward(user, String(task._id), task.taskType)
        })));
    } catch (error) {
        sendRouteError(res, error, 'Tasks API error:');
    }
});

app.get('/api/dashboard', async (req, res) => {
    try {
        const user = await getAuthenticatedUser(req);
        res.json(buildDashboardPayload(user));
    } catch (error) {
        sendRouteError(res, error, 'Dashboard API error:');
    }
});

app.get('/api/referrals', async (req, res) => {
    try {
        const user = await getAuthenticatedUser(req);
        res.json(await buildReferralPayload(user));
    } catch (error) {
        sendRouteError(res, error, 'Referrals API error:');
    }
});

// New endpoint for refer.html - returns data in format it expects
app.get('/api/me', async (req, res) => {
    try {
        const user = await getAuthenticatedUser(req);
        
        // Ensure user has referral code
        if (!user.referralCode) {
            await user.ensureReferralCode();
            await user.save();
            console.log(`✅ Generated referral code for user ${user.email}:`, user.referralCode);
        }
        
        const referralCounts = buildReferralCountMap(await User.find({}));
        const userRefCount = referralCounts.get(user.referralCode) || 0;
        const bonusPoints = Math.floor(Math.max(Number(userRefCount || 0), 0) / REFER_BONUS_MILESTONE) * REFER_BONUS_POINTS;
        const totalPoints = (userRefCount * REFER_POINTS_PER_USER) + bonusPoints;
        
        res.json({
            success: true,
            refCode: user.referralCode,
            referrals: userRefCount,
            points: totalPoints,
            tokens: user.tokens || 0,
            dailyLimit: REFER_DAILY_LIMIT,
            rank: await calculateUserRank(user._id),
            bonus: bonusPoints
        });
    } catch (error) {
        sendRouteError(res, error, 'Me API error:');
    }
});

// New leaderboard endpoint
app.get('/api/leaderboard', async (req, res) => {
    try {
        const user = await getAuthenticatedUser(req);
        const payload = await buildReferralPayload(user);
        res.json(payload.leaderboard);
    } catch (error) {
        sendRouteError(res, error, 'Leaderboard API error:');
    }
});

async function deleteAuthenticatedAccount(req, res) {
    try {
        const user = await getAuthenticatedUser(req);
        await scheduleUserDeletion(user);

        res.json({
            success: true,
            message: 'Account scheduled for deletion successfully.',
            recovery: getDeletionMetadata(user)
        });
    } catch (error) {
        sendRouteError(res, error, 'Delete account API error:');
    }
}

app.delete('/api/profile/delete', async (req, res) => {
    await deleteAuthenticatedAccount(req, res);
});

app.delete('/api/user', async (req, res) => {
    await deleteAuthenticatedAccount(req, res);
});

app.get('/api/notifications', async (req, res) => {
    try {
        const user = await getAuthenticatedUser(req);
        const notifications = await Notification.find({
            createdAt: { $gte: notificationCutoffDate() },
            $or: [
                { audience: 'all' },
                { userId: String(user._id) }
            ]
        }).sort({ createdAt: -1 }).limit(200).lean();

        const notificationIds = notifications.map((item) => String(item._id || item.id || '')).filter(Boolean);
        const readDocs = notificationIds.length
            ? await NotificationRead.find({
                userId: String(user._id),
                notificationId: { $in: notificationIds }
            }).select('notificationId').lean()
            : [];
        const readSet = new Set((readDocs || []).map((doc) => String(doc.notificationId || '')).filter(Boolean));

        res.json({
            notifications: notifications.map((notification) => {
                const payload = serializeNotification(notification);
                payload.read = readSet.has(String(payload.id || ''));
                return payload;
            })
        });
    } catch (error) {
        sendRouteError(res, error, 'Notifications API error:');
    }
});

app.post('/api/notifications/read', async (req, res) => {
    try {
        const user = await getAuthenticatedUser(req);
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const ids = []
            .concat(body.ids || body.id || [])
            .map((value) => String(value || '').trim())
            .filter(Boolean)
            .slice(0, 200);

        if (!ids.length) {
            return res.status(400).json({ success: false, message: 'Notification id is required' });
        }

        const userId = String(user._id);
        const now = new Date();
        const ops = ids.map((notificationId) => ({
            updateOne: {
                filter: { userId, notificationId },
                update: { $set: { readAt: now } },
                upsert: true
            }
        }));

        await NotificationRead.bulkWrite(ops, { ordered: false });

        res.json({ success: true });
    } catch (error) {
        sendRouteError(res, error, 'Notification read API error:');
    }
});

app.post('/api/notifications/read-all', async (req, res) => {
    try {
        const user = await getAuthenticatedUser(req);
        const notifications = await Notification.find({
            createdAt: { $gte: notificationCutoffDate() },
            $or: [
                { audience: 'all' },
                { userId: String(user._id) }
            ]
        }).sort({ createdAt: -1 }).limit(200).lean();

        const ids = notifications.map((item) => String(item._id || item.id || '')).filter(Boolean);
        if (!ids.length) {
            return res.json({ success: true, count: 0 });
        }

        const userId = String(user._id);
        const now = new Date();
        const ops = ids.map((notificationId) => ({
            updateOne: {
                filter: { userId, notificationId },
                update: { $set: { readAt: now } },
                upsert: true
            }
        }));

        await NotificationRead.bulkWrite(ops, { ordered: false });

        res.json({ success: true, count: ids.length });
    } catch (error) {
        sendRouteError(res, error, 'Notification read-all API error:');
    }
});

app.get('/api/wallet', async (req, res) => {
    try {
        const user = await getAuthenticatedUser(req);
        res.json(buildWalletPayload(user));
    } catch (error) {
        sendRouteError(res, error, 'Wallet API error:');
    }
});

async function convertPoints(req, res) {
    try {
        const user = await getAuthenticatedUser(req);
        enforceUserRateLimit(user._id, 'wallet-convert', { limit: 6, windowMs: 60 * 1000 });
        const pointsToConvert = Math.floor(Number(req.body?.points || 0));

        if (!Number.isFinite(pointsToConvert) || pointsToConvert <= 0) {
            return res.status(400).json({ message: 'Enter a valid points amount' });
        }

        if (pointsToConvert % MIN_CONVERTIBLE_POINTS_STEP !== 0) {
            return res.status(400).json({ message: `Points must be in multiples of ${MIN_CONVERTIBLE_POINTS_STEP} for exact token conversion.` });
        }

        const tokensToAdd = roundTo(pointsToConvert / CONVERT_RATIO_POINTS, 2);
        const activityEntry = {
            title: 'Points converted',
            message: `${pointsToConvert} points converted to ${tokensToAdd} tokens.`,
            amount: tokensToAdd,
            type: 'convert',
            direction: 'credit',
            status: 'completed',
            time: new Date()
        };

        const updatedUser = await User.findOneAndUpdate(
            {
                _id: user._id,
                points: { $gte: pointsToConvert }
            },
            [{
                $set: {
                    points: { $subtract: [{ $ifNull: ['$points', 0] }, pointsToConvert] },
                    tokens: {
                        $round: [
                            { $add: [{ $ifNull: ['$tokens', 0] }, tokensToAdd] },
                            2
                        ]
                    },
                    tokensConverted: {
                        $round: [
                            { $add: [{ $ifNull: ['$tokensConverted', 0] }, tokensToAdd] },
                            2
                        ]
                    },
                    activity: {
                        $slice: [
                            {
                                $concatArrays: [
                                    [activityEntry],
                                    { $ifNull: ['$activity', []] }
                                ]
                            },
                            50
                        ]
                    }
                }
            }],
            { new: true }
        );

        if (!updatedUser) {
            return res.status(409).json({ message: 'Points were already used or balance is too low for this conversion.' });
        }

        let notification = null;
        try {
            notification = await createUserNotification({
                userId: updatedUser._id,
                title: 'Wallet updated',
                message: `${pointsToConvert} points converted to ${tokensToAdd} tokens.`,
                type: 'wallet',
                link: 'wallet.html',
                meta: {
                    points: pointsToConvert,
                    tokens: tokensToAdd,
                    source: 'convert'
                }
            });
        } catch (notificationError) {
            console.warn('Wallet notification create failed:', notificationError.message);
        }

        res.json({
            success: true,
            ...buildWalletPayload(updatedUser),
            activityEntry: serializeActivityEntry(activityEntry),
            notification: notification ? serializeNotification(notification) : null
        });
    } catch (error) {
        sendRouteError(res, error, 'Wallet convert API error:');
    }
}

app.post('/api/wallet/convert', async (req, res) => {
    await convertPoints(req, res);
});

app.post('/api/convert-points', async (req, res) => {
    await convertPoints(req, res);
});

function buildAdminOverview(users, tasks, referralCounts) {
    const now = Date.now();
    const thirtyDays = 30 * 86_400_000;
    const twentyFourHours = 86_400_000;
    const tokensConvertedList = users.map((user) => getUserTokensConverted(user));

    return {
        totalUsers: users.length,
        totalPoints: users.reduce((sum, user) => sum + Number(user.points || 0), 0),
        totalTokens: users.reduce((sum, user) => sum + Number(user.tokens || 0), 0),
        totalTokensConverted: tokensConvertedList.reduce((sum, value) => sum + Number(value || 0), 0),
        usersConverted: tokensConvertedList.filter((value) => Number(value || 0) > 0).length,
        activeTasks: tasks.filter((task) => (task.status || 'active') === 'active').length,
        visits24h: users.filter((user) => now - new Date(user.lastLogin || user.joinedAt || now).getTime() < twentyFourHours).length,
        joins30d: users.filter((user) => now - new Date(user.joinedAt || now).getTime() < thirtyDays).length,
        referralJoins30d: users.filter((user) => user.referredByCode && (now - new Date(user.joinedAt || now).getTime() < thirtyDays)).length,
        totalReferrals: Array.from(referralCounts.values()).reduce((sum, count) => sum + count, 0)
    };
}

async function loadAdminSnapshot() {
    await ensureTaskCatalog();

    const [users, tasks, adminEvents] = await Promise.all([
        User.find({}).sort({ joinedAt: -1 }),
        Task.find({ status: { $ne: 'archived' } }).sort({ createdAt: -1 }),
        AdminEvent.find({}).sort({ createdAt: -1 }).limit(25).lean()
    ]);

    const referralCounts = buildReferralCountMap(users);

    return {
        users,
        tasks,
        adminEvents,
        referralCounts,
        overview: buildAdminOverview(users, tasks, referralCounts)
    };
}

app.post('/api/admin/login', async (req, res) => {
    try {
        if (!getAdminCredentialsConfigured()) {
            return res.status(503).json({
                message: 'Set ADMIN_EMAIL and ADMIN_PASSWORD in your .env file to enable admin login.'
            });
        }

        const email = String(req.body?.email || '').trim().toLowerCase();
        const password = String(req.body?.password || '').trim();

        if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
            return res.status(401).json({ message: 'Invalid admin credentials.' });
        }

        await logAdminEvent(`Admin signed in as ${ADMIN_EMAIL}.`, 'auth');
        res.json({
            success: true,
            token: createAdminToken(),
            admin: {
                email: ADMIN_EMAIL
            }
        });
    } catch (error) {
        sendRouteError(res, error, 'Admin login error:');
    }
});

app.post('/api/admin/auth/login', async (req, res) => {
    try {
        if (!getAdminCredentialsConfigured()) {
            return res.status(503).json({
                message: 'Set ADMIN_EMAIL and ADMIN_PASSWORD in your .env file to enable admin login.'
            });
        }

        const email = String(req.body?.email || '').trim().toLowerCase();
        const password = String(req.body?.password || '').trim();

        if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
            return res.status(401).json({ message: 'Invalid admin credentials.' });
        }

        res.json({
            success: true,
            token: createAdminToken(),
            admin: {
                email: ADMIN_EMAIL
            }
        });
    } catch (error) {
        sendRouteError(res, error, 'Admin login error:');
    }
});

app.get('/api/admin/overview', async (req, res) => {
    try {
        verifyAdminRequest(req);
        const snapshot = await loadAdminSnapshot();
        res.json({
            overview: snapshot.overview
        });
    } catch (error) {
        sendRouteError(res, error, 'Admin overview error:');
    }
});

app.get('/api/admin/stats', async (req, res) => {
    try {
        verifyAdminRequest(req);
        const snapshot = await loadAdminSnapshot();
        res.json(snapshot.overview);
    } catch (error) {
        sendRouteError(res, error, 'Admin stats error:');
    }
});

app.get('/api/admin/users', async (req, res) => {
    try {
        verifyAdminRequest(req);
        const snapshot = await loadAdminSnapshot();
        res.json({
            users: snapshot.users.map((user) => serializeAdminUser(user, snapshot.referralCounts))
        });
    } catch (error) {
        sendRouteError(res, error, 'Admin users error:');
    }
});

app.delete('/api/admin/users/:id', async (req, res) => {
    try {
        verifyAdminRequest(req);
        const user = await User.findById(req.params.id);

        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        await purgeUserData(user);
        await logAdminEvent(`Deleted member account ${user.email}.`, 'users', { userId: String(user._id) });

        res.json({
            success: true,
            message: 'User deleted successfully.'
        });
    } catch (error) {
        sendRouteError(res, error, 'Admin delete user error:');
    }
});

app.post('/api/admin/users/:id/gift', async (req, res) => {
    try {
        verifyAdminRequest(req);
        const user = await User.findById(req.params.id);

        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        const points = Math.floor(Number(req.body?.points || 0));
        const title = String(req.body?.title || 'Admin gift').trim();

        if (!Number.isFinite(points) || points <= 0) {
            return res.status(400).json({ message: 'Enter a valid gift amount.' });
        }

        user.points = Number(user.points || 0) + points;
        prependActivity(user, {
            title,
            message: `${title} added by admin.`,
            amount: points,
            type: 'bonus',
            direction: 'credit',
            status: 'completed',
            time: new Date()
        });

        await user.save();
        await logAdminEvent(`Gifted ${points} points to ${user.email}.`, 'gift', { userId: String(user._id), points });

        res.json({
            success: true,
            user: serializeUser(user)
        });
    } catch (error) {
        sendRouteError(res, error, 'Admin gift user error:');
    }
});

app.post('/api/admin/users/gift-all', async (req, res) => {
    try {
        verifyAdminRequest(req);
        const points = Math.floor(Number(req.body?.points || 0));
        const title = String(req.body?.title || 'Admin gift').trim();
        const message = String(req.body?.message || `${title} added by admin.`).trim();

        if (!Number.isFinite(points) || points <= 0) {
            return res.status(400).json({ message: 'Enter a valid gift amount.' });
        }

        const users = await User.find({});

        for (const user of users) {
            user.points = Number(user.points || 0) + points;
            prependActivity(user, {
                title,
                message,
                amount: points,
                type: 'bonus',
                direction: 'credit',
                status: 'completed',
                time: new Date()
            });
            await user.save();
        }

        await logAdminEvent(`Gifted ${points} points to all members (${users.length} users).`, 'gift-all', { points, users: users.length });

        res.json({
            success: true,
            affectedUsers: users.length
        });
    } catch (error) {
        sendRouteError(res, error, 'Admin gift all error:');
    }
});

app.get('/api/admin/tasks', async (req, res) => {
    try {
        verifyAdminRequest(req);
        await ensureTaskCatalog();
        const tasks = await Task.find({ status: { $ne: 'archived' } }).sort({ createdAt: -1 }).lean();
        res.json({
            tasks: tasks.map(serializeTask)
        });
    } catch (error) {
        sendRouteError(res, error, 'Admin tasks error:');
    }
});

app.post('/api/admin/tasks', async (req, res) => {
    try {
        verifyAdminRequest(req);
        const title = String(req.body?.title || '').trim();
        const link = String(req.body?.link || '').trim();
        const description = String(req.body?.description || '').trim();
        const rewardPoints = Math.floor(Number(req.body?.rewardPoints || 0));
        const taskType = String(req.body?.taskType || 'task').trim().toLowerCase();
        const notifyUsers = Boolean(req.body?.notifyUsers);

        if (!title || !link || !Number.isFinite(rewardPoints) || rewardPoints <= 0) {
            return res.status(400).json({ message: 'Fill all required task fields.' });
        }

        const slug = await buildUniqueTaskSlug(title);

        const task = await Task.create({
            title,
            slug,
            link,
            description,
            rewardPoints,
            taskType,
            notifyUsers,
            status: 'active'
        });

        if (notifyUsers) {
            await Notification.create({
                title: 'New task available',
                message: `${title} is live now. Complete it to earn ${rewardPoints} points.`,
                type: 'task',
                audience: 'all',
                link: task.link || 'tasks.html',
                meta: {
                    taskId: String(task._id),
                    rewardPoints,
                    taskType
                }
            });
        }

        await logAdminEvent(`Created task "${title}" for ${rewardPoints} points.`, 'task-create', {
            taskId: String(task._id),
            rewardPoints,
            notifyUsers
        });

        res.status(201).json({
            success: true,
            task: serializeTask(task)
        });
    } catch (error) {
        sendRouteError(res, error, 'Admin create task error:');
    }
});

app.delete('/api/admin/tasks/:id', async (req, res) => {
    try {
        verifyAdminRequest(req);
        const task = await Task.findByIdAndDelete(req.params.id);

        if (!task) {
            return res.status(404).json({ message: 'Task not found.' });
        }

        await logAdminEvent(`Deleted task "${task.title}".`, 'task-delete', { taskId: String(task._id) });

        res.json({
            success: true,
            message: 'Task deleted successfully.'
        });
    } catch (error) {
        sendRouteError(res, error, 'Admin delete task error:');
    }
});

app.get('/api/admin/activity', async (req, res) => {
    try {
        verifyAdminRequest(req);
        const snapshot = await loadAdminSnapshot();
        res.json({
            activity: buildAdminFeedEntries(snapshot.users, snapshot.adminEvents)
        });
    } catch (error) {
        sendRouteError(res, error, 'Admin activity error:');
    }
});

app.use(express.static(__dirname));

const PORT = parseInt(process.env.PORT, 10) || 5050;
const HOST = process.env.HOST || '0.0.0.0';

if (!isServerless) {
    const server = app.listen(PORT, HOST, () => {
        console.log('\n========================================================');
        console.log('ANVIPAYZ BACKEND IS LIVE');
        console.log(`URL: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
        console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
        console.log(`Test URL: http://localhost:${PORT}/api/test`);
        console.log('========================================================\n');
    });

    server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
            console.error(`ERROR: Port ${PORT} is already in use by another program.`);
            process.exit(1);
        } else {
            console.error('Server Error:', error);
        }
    });
}

module.exports = app;
