const mongoose = require('mongoose');

const NotificationReadSchema = new mongoose.Schema({
    userId: { type: String, required: true, trim: true, index: true },
    notificationId: { type: String, required: true, trim: true, index: true },
    readAt: { type: Date, default: Date.now }
}, {
    timestamps: true
});

NotificationReadSchema.index({ userId: 1, notificationId: 1 }, { unique: true });
// Auto-prune read receipts over time to keep collection small.
NotificationReadSchema.index({ readAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.models.NotificationRead || mongoose.model('NotificationRead', NotificationReadSchema);
