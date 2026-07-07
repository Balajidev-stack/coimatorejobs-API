import mongoose from 'mongoose';

const usageFeatureSchema = new mongoose.Schema(
  {
    enabled: {
      type: Boolean,
      default: false,
    },
    cycle: {
      type: String,
      enum: ['Daily', 'Monthly', 'Total'],
      default: 'Monthly',
    },
    limitType: {
      type: String,
      enum: ['limited', 'unlimited'],
      default: 'limited',
    },
    limitCount: {
      type: Number,
      default: null,
      min: [1, 'Limit count must be at least 1'],
    },
  },
  { _id: false },
);

const paymentPlanSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Plan name is required'],
      trim: true,
      maxlength: 120,
    },
    planType: {
      type: String,
      enum: ['Free', 'Paid'],
      default: 'Paid',
      index: true,
    },
    audience: {
      type: String,
      required: [true, 'Audience is required'],
      trim: true,
      maxlength: 160,
    },
    billingCycle: {
      type: String,
      enum: ['Monthly', 'Quarterly', 'Half-Yearly', 'Yearly'],
      required: [true, 'Billing cycle is required'],
    },
    price: {
      type: Number,
      required: [true, 'Price is required'],
      min: [0, 'Price cannot be negative'],
    },
    validityDays: {
      type: Number,
      required: [true, 'Validity is required'],
      min: [-1, 'Validity cannot be below unlimited marker'],
    },
    jobLimit: {
      type: Number,
      required: [true, 'Job posting limit is required'],
      min: [-1, 'Job posting limit cannot be below unlimited marker'],
    },
    resumeLimit: {
      type: Number,
      required: [true, 'Resume access limit is required'],
      min: [-1, 'Resume access limit cannot be below unlimited marker'],
    },
    featuredDays: {
      type: Number,
      required: [true, 'Featured listing days is required'],
      min: [0, 'Featured listing days cannot be negative'],
    },
    supportLevel: {
      type: String,
      enum: ['Email', 'Priority', 'Dedicated'],
      default: 'Email',
    },
    status: {
      type: String,
      enum: ['Active', 'Inactive'],
      default: 'Active',
    },
    badge: {
      type: String,
      trim: true,
      maxlength: 80,
      default: '',
    },
    description: {
      type: String,
      required: [true, 'Plan description is required'],
      trim: true,
      maxlength: 1000,
    },
    resumeDownloads: {
      type: usageFeatureSchema,
      default: () => ({}),
    },
    jobPostingLimit: {
      type: usageFeatureSchema,
      default: () => ({}),
    },
    candidateProfileAlerts: {
      type: usageFeatureSchema,
      default: () => ({}),
    },
    candidateProfileViewAccess: {
      type: Boolean,
      default: false,
    },
    jobListPageAccess: {
      type: Boolean,
      default: false,
    },
    jobPostingDurationDays: {
      type: Number,
      default: null,
      min: [1, 'Job posting duration must be at least 1 day'],
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
  },
  { timestamps: true },
);

paymentPlanSchema.index({ createdBy: 1, createdAt: -1 });

const PaymentPlan = mongoose.model('PaymentPlan', paymentPlanSchema);

export default PaymentPlan;
