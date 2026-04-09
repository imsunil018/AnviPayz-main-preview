const mongoose = require('mongoose');

const AdminEventSchema = new mongoose.Schema({
    message: { type: String, required: true, trim: true },
    type: { type: String, default: 'system', trim: true, lowercase: true },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} }
}, {
    timestamps: true
});

module.exports = mongoose.models.AdminEvent || mongoose.model('AdminEvent', AdminEventSchema);
