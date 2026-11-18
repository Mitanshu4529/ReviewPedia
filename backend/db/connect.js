import mongoose from 'mongoose';

export const connectToDb = async () => {
    const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/reviewpedia';
    await mongoose.connect(uri);
    console.log(`Connected to MongoDB database successfully`);

    // The code collection's lookup index became unique. An existing database
    // still has the old non-unique one, which MongoDB will not replace on its
    // own, so bring this collection's indexes in line with the model. Its
    // records are short-lived codes; a failure here is logged, not fatal.
    try {
        const { default: EmailOtp } = await import('../models/EmailOtp.js');
        await EmailOtp.syncIndexes();
    } catch (err) {
        console.error('Could not update the verification-code indexes:', err.message);
    }
};
