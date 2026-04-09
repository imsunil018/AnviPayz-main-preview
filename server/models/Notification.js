const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema({
    title: { type: String, required: true, trim: true },
    message: { type: String, default: '', trim: true },
    type: { type: String, default: 'system', trim: true, lowercase: true },
    audience: { type: String, default: 'all', trim: true, lowercase: true },
    userId: { type: String, default: '', trim: true },
    link: { type: String, default: '', trim: true },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} }
}, {
    timestamps: true
});

module.exports = mongoose.models.Notification || mongoose.model('Notification', NotificationSchema);
