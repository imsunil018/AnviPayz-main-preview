const mongoose = require('mongoose');

function setDbStatus({ online, error }) {
    global.__ANVI_DB_STATUS__ = {
        online: Boolean(online),
        at: new Date().toISOString(),
        error: error ? String(error) : ''
    };
}

const connectDB = async () => {
    const uri = String(process.env.MONGO_URI || '').trim();
    if (!uri) {
        console.error('[Database] Connection Error: MONGO_URI is empty.');
        process.env.DB_OFFLINE = '1';
        setDbStatus({ online: false, error: 'MONGO_URI is empty.' });
        return;
    }

    // Prevent API requests from hanging forever when MongoDB is unreachable.
    mongoose.set('bufferCommands', false);

    const options = {
        serverSelectionTimeoutMS: 10000,
        family: 4,
        bufferCommands: false,
        bufferTimeoutMS: 2000
    };

    const ensureUserIndexes = async (conn) => {
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
    };

    const connectOnce = async () => {
        const conn = await mongoose.connect(uri, options);
        process.env.DB_OFFLINE = '0';
        setDbStatus({ online: true, error: '' });
        await ensureUserIndexes(conn);
        console.log(`[Database] MongoDB Connected: ${conn.connection.host}`);
        return conn;
    };

    try {
        await connectOnce();
    } catch (error) {
        console.error(`[Database] Connection Error: ${error.message}`);
        process.env.DB_OFFLINE = '1';
        setDbStatus({ online: false, error: error.message });

        const retryDelayMs = 12_000;
        console.warn(`[Database] Retrying connection every ${Math.round(retryDelayMs / 1000)}s...`);
        setInterval(async () => {
            if (mongoose.connection.readyState === 1) {
                process.env.DB_OFFLINE = '0';
                setDbStatus({ online: true, error: '' });
                return;
            }

            try {
                await connectOnce();
            } catch (_) {
                process.env.DB_OFFLINE = '1';
                setDbStatus({ online: false, error: 'MongoDB connection retry failed.' });
            }
        }, retryDelayMs).unref?.();
    }
};

module.exports = connectDB;
