import mongoose from 'mongoose';
import User from '../models/user.model.js';
import PaymentPlan from '../models/paymentPlan.model.js';
import JobPost from '../models/jobs.model.js';
import ResumeAlert from '../models/resumeAlert.model.js';
import ResumeDownloadLog from '../models/resumeDownloadLog.model.js';
import EmployerResumeDownloadLog from '../models/employerResumeDownloadLog.model.js';

const PLAN_REQUIRED_MESSAGE =
  'Your employer account needs an active payment plan to use this feature.';

const getIstDateKey = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

const getIstMonthKey = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
  }).format(new Date());

const getCycleDateFilter = (cycle = 'Monthly') => {
  if (cycle === 'Total') return {};

  const now = new Date();
  const start = new Date(now);

  if (cycle === 'Daily') {
    start.setHours(0, 0, 0, 0);
  } else {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
  }

  return { createdAt: { $gte: start } };
};

const findActiveFreePlan = () =>
  PaymentPlan.findOne({
    status: 'Active',
    $or: [
      { planType: 'Free' },
      { name: /^free$/i, price: 0 },
    ],
  }).sort({ createdAt: -1 });

export const resolveEmployerPlan = async (employerId) => {
  const user = await User.findById(employerId).select('activePaymentPlan paymentPlanAssignedAt role');
  if (!user || user.role !== 'employer') return null;

  let plan = null;
  if (user.activePaymentPlan) {
    plan = await PaymentPlan.findOne({
      _id: user.activePaymentPlan,
      status: 'Active',
    });
  }

  if (!plan) {
    plan = await findActiveFreePlan();
    if (plan) {
      user.activePaymentPlan = plan._id;
      user.paymentPlanAssignedAt = new Date();
      await user.save({ validateBeforeSave: false });
    }
  }

  return plan;
};

const getFeatureLimit = (plan, featureKey, legacyKey = null) => {
  const feature = plan?.[featureKey] || {};
  const legacyValue = legacyKey ? Number(plan?.[legacyKey] || 0) : 0;
  const featureEnabled =
    Boolean(feature.enabled) || legacyValue === -1 || legacyValue > 0;

  if (!plan || !featureEnabled) {
    return {
      enabled: false,
      limit: 0,
      cycle: feature.cycle || 'Monthly',
    };
  }

  if (feature.limitType === 'unlimited' || legacyValue === -1) {
    return {
      enabled: true,
      limit: -1,
      cycle: feature.cycle || 'Monthly',
    };
  }

  return {
    enabled: true,
    limit: Number(feature.limitCount || legacyValue || 0),
    cycle: feature.cycle || 'Monthly',
  };
};

const block = (res, message, status = 403, extra = {}) =>
  res.status(status).json({
    success: false,
    code: extra.code || 'PLAN_LIMIT_REACHED',
    message,
    ...extra,
  });

export const requireEmployerPlanFeature = async ({
  req,
  res,
  booleanField,
  featureLabel,
}) => {
  if (req.user?.role !== 'employer') return { allowed: true, plan: null };

  const plan = await resolveEmployerPlan(req.user.id);
  if (!plan) {
    block(res, PLAN_REQUIRED_MESSAGE, 403, { code: 'PLAN_REQUIRED' });
    return { allowed: false, plan: null };
  }

  if (!plan[booleanField]) {
    block(res, `${featureLabel} is not included in your current plan.`);
    return { allowed: false, plan };
  }

  return { allowed: true, plan };
};

export const requireEmployerJobPostLimit = async (req, res, employerId = null) => {
  if (req.user?.role !== 'employer') return true;

  const plan = await resolveEmployerPlan(req.user.id);
  if (!plan) {
    block(res, PLAN_REQUIRED_MESSAGE, 403, { code: 'PLAN_REQUIRED' });
    return false;
  }

  const feature = getFeatureLimit(plan, 'jobPostingLimit', 'jobLimit');
  if (!feature.enabled || feature.limit === 0) {
    block(res, 'Job posting is not included in your current plan.');
    return false;
  }

  if (feature.limit === -1) return true;

  const usageCount = await JobPost.countDocuments({
    employer: employerId || req.user.id,
    ...getCycleDateFilter(feature.cycle),
  });

  if (usageCount >= feature.limit) {
    block(
      res,
      `Job posting limit reached. Your current plan allows ${feature.limit} job post(s) per ${feature.cycle.toLowerCase()} cycle.`,
      429,
      {
        limit: feature.limit,
        used: usageCount,
        cycle: feature.cycle,
      },
    );
    return false;
  }

  return true;
};

export const requireEmployerResumeAlertLimit = async (req, res) => {
  if (req.user?.role !== 'employer') return true;

  const plan = await resolveEmployerPlan(req.user.id);
  if (!plan) {
    block(res, PLAN_REQUIRED_MESSAGE, 403, { code: 'PLAN_REQUIRED' });
    return false;
  }

  const feature = getFeatureLimit(plan, 'candidateProfileAlerts');
  if (!feature.enabled || feature.limit === 0) {
    block(res, 'Resume alerts are not included in your current plan.');
    return false;
  }

  if (feature.limit === -1) return true;

  const usageCount = await ResumeAlert.countDocuments({
    employer: req.user.id,
    ...getCycleDateFilter(feature.cycle),
  });

  if (usageCount >= feature.limit) {
    block(
      res,
      `Resume alert limit reached. Your current plan allows ${feature.limit} alert(s) per ${feature.cycle.toLowerCase()} cycle.`,
      429,
      {
        limit: feature.limit,
        used: usageCount,
        cycle: feature.cycle,
      },
    );
    return false;
  }

  return true;
};

export const requireEmployerResumeDownloadLimit = async (req, res, options = {}) => {
  if (req.user?.role !== 'employer') return { allowed: true, plan: null, feature: null };

  const plan = await resolveEmployerPlan(req.user.id);
  if (!plan) {
    block(res, PLAN_REQUIRED_MESSAGE, 403, { code: 'PLAN_REQUIRED' });
    return { allowed: false, plan: null, feature: null };
  }

  const feature = getFeatureLimit(plan, 'resumeDownloads', 'resumeLimit');
  if (!feature.enabled || feature.limit === 0) {
    block(res, 'Resume downloads are not included in your current plan.');
    return { allowed: false, plan, feature };
  }

  if (feature.limit === -1) return { allowed: true, plan, feature };

  let usageCount = 0;
  if (options.source === 'applicant') {
    const query = { employer: req.user.id };
    if (feature.cycle === 'Daily') {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      query.downloadedAt = { $gte: start };
    } else if (feature.cycle === 'Monthly') {
      query.monthKey = getIstMonthKey();
    }
    usageCount = await EmployerResumeDownloadLog.countDocuments(query);
  } else {
    const employerObjectId = new mongoose.Types.ObjectId(req.user.id);
    const query = { employer: employerObjectId };
    if (feature.cycle === 'Daily') query.dayKey = getIstDateKey();
    if (feature.cycle === 'Monthly') query.dayKey = new RegExp(`^${getIstMonthKey()}`);
    usageCount =
      feature.cycle === 'Total'
        ? await ResumeDownloadLog.aggregate([
            { $match: { employer: employerObjectId } },
            { $group: { _id: null, total: { $sum: '$downloadCount' } } },
          ]).then((rows) => Number(rows[0]?.total || 0))
        : await ResumeDownloadLog.aggregate([
            { $match: query },
            { $group: { _id: null, total: { $sum: '$downloadCount' } } },
          ]).then((rows) => Number(rows[0]?.total || 0));
  }

  if (usageCount >= feature.limit) {
    block(
      res,
      `Resume download limit reached. Your current plan allows ${feature.limit} download(s) per ${feature.cycle.toLowerCase()} cycle.`,
      429,
      {
        code: 'DOWNLOAD_LIMIT_REACHED',
        limit: feature.limit,
        used: usageCount,
        cycle: feature.cycle,
      },
    );
    return { allowed: false, plan, feature };
  }

  return { allowed: true, plan, feature };
};
