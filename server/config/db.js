const mongoose = require('mongoose');

const connectDB = async () => {
    try {
        const conn = await mongoose.connect(process.env.MONGO_URI, {
            serverSelectionTimeoutMS: 10000,
            family: 4
        });

        const usersCollection = conn.connection.collection('users');
        const indexes = await usersCollection.indexes();
        const legacyPhoneIndex = indexes.find((index) => index.name === 'phone_1');
        const referralIndex = indexes.find((index) => index.name === 'referralCode_1');

        if (legacyPhoneIndex?.unique && !legacyPhoneIndex.sparse && !legacyPhoneIndex.partialFilterExpression) {
            console.warn('Dropping legacy users.phone_1 unique index because phone is optional.');
            try {
                await usersCollection.dropIndex('phone_1');
            } catch (error) {
                if (error.codeName !== 'IndexNotFound') {
                    throw error;
                }
            }
        }

        if (referralIndex?.unique && !referralIndex.partialFilterExpression) {
            console.warn('Replacing legacy users.referralCode_1 unique index with a partial unique index.');
            try {
                await usersCollection.dropIndex('referralCode_1');
            } catch (error) {
                if (error.codeName !== 'IndexNotFound') {
                    throw error;
                }
            }
        }

        const refreshedIndexes = await usersCollection.indexes();
        const partialReferralIndex = refreshedIndexes.find((index) =>
            index.name === 'referralCode_1' && index.unique && index.partialFilterExpression
        );

        if (!partialReferralIndex) {
            await usersCollection.createIndex(
                { referralCode: 1 },
                {
                    name: 'referralCode_1',
                    unique: true,
                    partialFilterExpression: { referralCode: { $type: 'string' } }
                }
            );
        }

        console.log(`[Database] MongoDB Connected: ${conn.connection.host}`);
    } catch (error) {
        console.error(`[Database] Connection Error: ${error.message}`);
        process.exit(1);
    }
};

module.exports = connectDB;
