const jwt = require('jsonwebtoken');
const User = require('../models/User');
const {
    getDeletionMetadata,
    isPendingDeletion,
    purgeUserIfExpired
} = require('../utils/accountLifecycle');

// Protect routes - JWT verification middleware
const protect = async (req, res, next) => {
    try {
        let token;

        // Check for token in Authorization header
        if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
            token = req.headers.authorization.split(' ')[1];
        }

        // Check if token exists
        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Not authorized - No token provided'
            });
        }

        try {
            // Verify token
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            const userId = decoded.id || decoded.userId;

            // Check if user still exists
            const user = await User.findById(userId);

            if (!user) {
                return res.status(401).json({
                    success: false,
                    message: 'User not found'
                });
            }

            if (await purgeUserIfExpired(user)) {
                return res.status(401).json({
                    success: false,
                    message: 'Account not found',
                    code: 'ACCOUNT_DELETED'
                });
            }

            if (isPendingDeletion(user)) {
                return res.status(423).json({
                    success: false,
                    message: 'This account is scheduled for permanent deletion. Restore it to continue.',
                    code: 'ACCOUNT_PENDING_DELETION',
                    recovery: getDeletionMetadata(user)
                });
            }

            // Add user info to request object
            req.userId = user._id;
            req.user = user;

            next();

        } catch (jwtError) {
            // Handle specific JWT errors
            if (jwtError.name === 'TokenExpiredError') {
                return res.status(401).json({
                    success: false,
                    message: 'Token expired. Please login again.',
                    code: 'TOKEN_EXPIRED'
                });
            }

            if (jwtError.name === 'JsonWebTokenError') {
                return res.status(401).json({
                    success: false,
                    message: 'Invalid token. Please login again.',
                    code: 'INVALID_TOKEN'
                });
            }

            throw jwtError;
        }

    } catch (error) {
        console.error('Auth Middleware Error:', error);
        res.status(401).json({
            success: false,
            message: 'Not authorized'
        });
    }
};

// Optional auth - doesn't require token but adds user if token exists
const optionalAuth = async (req, res, next) => {
    try {
        let token;

        if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
            token = req.headers.authorization.split(' ')[1];
        }

        if (token) {
            try {
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                const userId = decoded.id || decoded.userId;
                const user = await User.findById(userId);

                if (user && !await purgeUserIfExpired(user) && !isPendingDeletion(user)) {
                    req.userId = user._id;
                    req.user = user;
                }
            } catch (error) {
                // Silent fail for optional auth
                console.log('Optional auth failed:', error.message);
            }
        }

        next();

    } catch (error) {
        next();
    }
};

module.exports = {
    protect,
    optionalAuth
};
