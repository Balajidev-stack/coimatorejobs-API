import { config } from 'dotenv';
import fs from 'fs';

// config(options?:{ path: `.env.${process.env.NODE_ENV || 'development'}.local` });

// Decide which .env file to load based on NODE_ENV:
const envFile = process.env.NODE_ENV === 'production' ? '.env.production.local' : '.env.development.local';

// Load that file into process.env:
const results = fs.existsSync(envFile) ? config({ path: envFile }) : { error: null };

// console.log(`Using environment file: ${envFile}`);

if (results.error){
    console.error(`Error loading environment variables from ${envFile}:`, results.error);
}

const isProduction = process.env.NODE_ENV === 'production';

const razorpayKeyId = isProduction
  ? process.env.RAZORPAY_LIVE_KEY_ID || process.env.RAZORPAY_KEY_ID
  : process.env.RAZORPAY_TEST_KEY_ID || process.env.RAZORPAY_KEY_ID;

const razorpayKeySecret = isProduction
  ? process.env.RAZORPAY_LIVE_KEY_SECRET || process.env.RAZORPAY_KEY_SECRET
  : process.env.RAZORPAY_TEST_KEY_SECRET || process.env.RAZORPAY_KEY_SECRET;

// export const { error } = config({ path: envFile });
// Pull out the values you need, with sensible defaults:
export const { PORT = '5000', NODE_ENV = 'development', DB_URI, JWT_SECRET, JWT_EXPIRES_IN, EMAIL_USER, EMAIL_PASS, SUPERADMIN_EMAIL, SUPERADMIN_NAME, FRONTEND_URL, MAILTRAP_HOST, MAILTRAP_PORT, MAILTRAP_USER, MAILTRAP_PASS, THROTTLING_RETRY_DELAY_BASE = 1000 } = process.env;
export const RAZORPAY_KEY_ID = razorpayKeyId;
export const RAZORPAY_KEY_SECRET = razorpayKeySecret;
export const RAZORPAY_MODE = isProduction ? 'live' : 'test';
