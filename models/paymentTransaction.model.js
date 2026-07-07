import mongoose from 'mongoose';

const paymentTransactionSchema = new mongoose.Schema(
  {
    employer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    paymentPlan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PaymentPlan',
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: 'INR',
      uppercase: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ['created', 'paid', 'failed'],
      default: 'created',
      index: true,
    },
    mode: {
      type: String,
      enum: ['test', 'live'],
      required: true,
    },
    razorpayOrderId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    razorpayPaymentId: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },
    razorpaySignature: {
      type: String,
      trim: true,
    },
    receipt: {
      type: String,
      required: true,
      trim: true,
    },
    paidAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

paymentTransactionSchema.index({ employer: 1, createdAt: -1 });

const PaymentTransaction = mongoose.model('PaymentTransaction', paymentTransactionSchema);

export default PaymentTransaction;
