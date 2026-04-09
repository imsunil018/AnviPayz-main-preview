require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');

const NODE_ENV = String(process.env.NODE_ENV || 'development').trim().toLowerCase();
const DEV_ALLOWED_ORIGINS = [
    'http://localhost:5501',
    'http://127.0.0.1:5501',
    'http://localhost:5050',
    'http://127.0.0.1:5050'
];
const configuredFrontendOrigins = String(process.env.FRONTEND_URL || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
const allowedOrigins = configuredFrontendOrigins.length > 0
    ? configuredFrontendOrigins
    : (NODE_ENV === 'production' ? [] : DEV_ALLOWED_ORIGINS);
const requiredEnv = ['MONGO_URI', 'JWT_SECRET'];

if (NODE_ENV === 'production') {
    requiredEnv.push('FRONTEND_URL');
}

const missingEnv = requiredEnv.filter((key) => !String(process.env[key] || '').trim());
if (missingEnv.length > 0) {
    console.error(`CRITICAL ERROR: Missing environment variables: ${missingEnv.join(', ')}`);
    process.exit(1);
}

connectDB();

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(cors({
    origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
            return;
        }

        callback(new Error('CORS origin denied'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
});

app.use('/api/auth', require('./routes/auth'));

app.get('/api/health', (req, res) => {
    res.status(200).json({
        success: true,
        message: 'Server is running',
        timestamp: new Date().toISOString()
    });
});

app.use((err, req, res, next) => {
    console.error('Error:', err);

    if (err.name === 'ValidationError') {
        const messages = Object.values(err.errors).map((value) => value.message);
        return res.status(400).json({
            success: false,
            message: 'Validation Error',
            errors: messages
        });
    }

    if (err.code === 11000) {
        return res.status(400).json({
            success: false,
            message: 'Duplicate field value entered'
        });
    }

    if (err.name === 'CastError') {
        return res.status(400).json({
            success: false,
            message: `Invalid ${err.path}: ${err.value}`
        });
    }

    if (err.name === 'JsonWebTokenError') {
        return res.status(401).json({
            success: false,
            message: 'Invalid token'
        });
    }

    return res.status(err.status || 500).json({
        success: false,
        message: err.message || 'Internal Server Error'
    });
});

app.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        message: `Route ${req.originalUrl} not found`
    });
});

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
    console.log(`
===================================
Server running on port ${PORT}
Environment: ${NODE_ENV}
Allowed origins: ${allowedOrigins.join(', ')}
===================================
    `);
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err);
    server.close(() => process.exit(1));
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    process.exit(1);
});
