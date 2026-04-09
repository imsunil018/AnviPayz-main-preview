const mongoose = require('mongoose');

const TaskSchema = new mongoose.Schema({
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true },
    description: { type: String, default: '', trim: true },
    link: { type: String, default: '', trim: true },
    rewardPoints: { type: Number, default: 0, min: 0 },
    taskType: { type: String, default: 'task', trim: true, lowercase: true },
    status: { type: String, default: 'active', trim: true, lowercase: true },
    notifyUsers: { type: Boolean, default: false }
}, {
    timestamps: true
});

module.exports = mongoose.models.Task || mongoose.model('Task', TaskSchema);
