import crypto from 'crypto';
import { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_MODE } from '../config/env.js';

const RAZORPAY_API_BASE_URL = 'https://api.razorpay.com/v1';

export const getRazorpayPublicConfig = () => ({
  keyId: RAZORPAY_KEY_ID,
  mode: RAZORPAY_MODE,
});

export const assertRazorpayConfigured = () => {
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    const error = new Error(
      RAZORPAY_MODE === 'live'
        ? 'Razorpay live credentials are not configured.'
        : 'Razorpay test credentials are not configured.',
    );
    error.statusCode = 500;
    throw error;
  }
};

export const createRazorpayOrder = async ({ amount, currency = 'INR', receipt, notes = {} }) => {
  assertRazorpayConfigured();

  const response = await fetch(`${RAZORPAY_API_BASE_URL}/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount,
      currency,
      receipt,
      notes: {
        ...notes,
        environment: RAZORPAY_MODE,
      },
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.description || 'Unable to create Razorpay order.');
    error.statusCode = response.status;
    error.details = payload;
    throw error;
  }

  return payload;
};

export const verifyRazorpayPaymentSignature = ({ orderId, paymentId, signature }) => {
  assertRazorpayConfigured();

  const expectedSignature = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  const receivedSignature = Buffer.from(String(signature || ''));
  const expectedSignatureBuffer = Buffer.from(expectedSignature);

  if (receivedSignature.length !== expectedSignatureBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedSignatureBuffer, receivedSignature);
};
