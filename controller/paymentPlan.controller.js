import PaymentPlan from '../models/paymentPlan.model.js';
import PaymentTransaction from '../models/paymentTransaction.model.js';
import User from '../models/user.model.js';
import JobPost from '../models/jobs.model.js';
import ResumeAlert from '../models/resumeAlert.model.js';
import ResumeDownloadLog from '../models/resumeDownloadLog.model.js';
import EmployerResumeDownloadLog from '../models/employerResumeDownloadLog.model.js';
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { resolveEmployerPlan } from '../utils/employerPlanAccess.js';
import {
  createRazorpayOrder,
  getRazorpayPublicConfig,
  verifyRazorpayPaymentSignature,
} from '../utils/razorpay.js';
import { RAZORPAY_MODE } from '../config/env.js';
import { sendPlanReceiptEmail } from '../utils/mailer.js';

const ACTIVE_FREE_PLAN_CONFLICT_MESSAGE =
  'Another active Free plan already exists. Please mark that plan inactive before activating this Free plan.';

const escapeHtml = (value = '') =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const sanitizeFilename = (value = 'receipt') =>
  String(value || 'receipt').replace(/[<>:"/\\|?*\x00-\x1F]/g, '').trim() || 'receipt';

const formatReceiptDate = (value) => {
  if (!value) return '-';
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(value));
};

const formatReceiptCurrency = (value, currency = 'INR') =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: currency || 'INR',
    maximumFractionDigits: 2,
  }).format(Number(value || 0));

const findChromeBinaryInDir = (rootDir, depth = 0) => {
  if (!rootDir || depth > 5) return null;

  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isFile() && (entry.name === 'chrome' || entry.name === 'chrome.exe')) {
      return fullPath;
    }
    if (entry.isDirectory()) {
      const found = findChromeBinaryInDir(fullPath, depth + 1);
      if (found) return found;
    }
  }

  return null;
};

const resolveChromeExecutablePath = () => {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.env.GOOGLE_CHROME_BIN,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Chromium\\Application\\chrome.exe',
  ].filter(Boolean);

  for (const chromePath of candidates) {
    try {
      if (fs.existsSync(chromePath)) return chromePath;
    } catch {
      // ignore
    }
  }

  const cacheCandidates = [
    path.join(process.cwd(), '.cache', 'puppeteer'),
    path.join(process.env.HOME || '', '.cache', 'puppeteer'),
    path.join(process.env.USERPROFILE || '', '.cache', 'puppeteer'),
  ].filter(Boolean);

  for (const cacheDir of cacheCandidates) {
    const discoveredPath = findChromeBinaryInDir(cacheDir);
    if (discoveredPath) return discoveredPath;
  }

  try {
    const managedPath =
      typeof puppeteer.executablePath === 'function'
        ? puppeteer.executablePath()
        : null;
    if (managedPath && fs.existsSync(managedPath)) return managedPath;
  } catch {
    // ignore
  }

  return null;
};

const launchPdfBrowser = async () => {
  const executablePath = resolveChromeExecutablePath();
  const commonArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
  ];
  const baseConfig = { headless: true, args: commonArgs };

  if (executablePath) {
    baseConfig.executablePath = executablePath;
  }

  const launchConfigs = [
    baseConfig,
    { ...baseConfig, headless: 'new' },
    { ...baseConfig, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  ];

  let lastError = null;
  for (const config of launchConfigs) {
    try {
      return await puppeteer.launch(config);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Unable to launch browser for PDF generation');
};

const isFreePlanPayload = (plan = {}) =>
  plan.planType === 'Free' || (String(plan.name || '').trim().toLowerCase() === 'free' && Number(plan.price) === 0);

const findActiveFreePlan = (createdBy, excludeId = null) => {
  const query = {
    createdBy,
    status: 'Active',
    $or: [
      { planType: 'Free' },
      { name: /^free$/i, price: 0 },
    ],
  };

  if (excludeId) {
    query._id = { $ne: excludeId };
  }

  return PaymentPlan.findOne(query).select('_id name');
};

const findLatestActiveFreePlan = () =>
  PaymentPlan.findOne({
    status: 'Active',
    $or: [
      { planType: 'Free' },
      { name: /^free$/i, price: 0 },
    ],
  })
    .sort({ createdAt: -1 })
    .select('_id');

const assignFreePlanToEmployersWithoutActivePlan = async () => {
  const freePlan = await findLatestActiveFreePlan();
  if (!freePlan) return null;

  const activePlanIds = await PaymentPlan.distinct('_id', { status: 'Active' });

  await User.updateMany(
    {
      role: 'employer',
      isActive: true,
      $or: [{ isDeleted: false }, { isDeleted: { $exists: false } }],
      activePaymentPlan: { $nin: activePlanIds },
    },
    {
      $set: {
        activePaymentPlan: freePlan._id,
        paymentPlanAssignedAt: new Date(),
        assignmentSource: 'system',
      },
    },
  );

  return freePlan;
};

const sortEmployerPlans = (plans = []) =>
  plans.sort((first, second) => {
    const firstIsFree = isFreePlanPayload(first);
    const secondIsFree = isFreePlanPayload(second);

    if (firstIsFree && !secondIsFree) return -1;
    if (!firstIsFree && secondIsFree) return 1;

    return Number(first.price || 0) - Number(second.price || 0);
  });

const normalizeUsageFeature = (value = {}) => {
  const enabled = Boolean(value.enabled);
  const limitType = value.limitType === 'unlimited' ? 'unlimited' : 'limited';
  const cycle = ['Daily', 'Monthly', 'Total'].includes(value.cycle) ? value.cycle : 'Monthly';
  const limitCount =
    enabled && limitType === 'limited' && Number(value.limitCount) > 0
      ? Number(value.limitCount)
      : null;

  return {
    enabled,
    cycle,
    limitType,
    limitCount,
  };
};

const normalizePayload = (body = {}) => ({
  name: String(body.name || '').trim(),
  planType: body.planType === 'Free' ? 'Free' : 'Paid',
  audience: String(body.audience || '').trim(),
  billingCycle: body.billingCycle,
  price: Number(body.price),
  validityDays: Number(body.validityDays) === -1 ? -1 : Number(body.validityDays),
  jobLimit: Number(body.jobLimit),
  resumeLimit: Number(body.resumeLimit),
  featuredDays: Number(body.featuredDays),
  supportLevel: body.supportLevel,
  status: body.status,
  badge: String(body.badge || '').trim(),
  description: String(body.description || '').trim(),
  resumeDownloads: normalizeUsageFeature(body.resumeDownloads),
  jobPostingLimit: normalizeUsageFeature(body.jobPostingLimit),
  candidateProfileAlerts: normalizeUsageFeature(body.candidateProfileAlerts),
  candidateProfileViewAccess: Boolean(body.candidateProfileViewAccess),
  jobListPageAccess: Boolean(body.jobListPageAccess),
  jobPostingDurationDays:
    Number(body.jobPostingDurationDays) > 0 ? Number(body.jobPostingDurationDays) : null,
});

const buildReceipt = (planId, employerId) =>
  `plan_${String(planId).slice(-6)}_${String(employerId).slice(-6)}_${Date.now().toString(36)}`;

const serializeCheckoutPlan = (plan) => ({
  _id: plan._id,
  name: plan.name,
  price: plan.price,
  billingCycle: plan.billingCycle,
  validityDays: plan.validityDays,
});

const buildPlanReceiptHtml = ({ transaction, employer, plan }) => {
  const paidAt = transaction.paidAt || transaction.createdAt;
  const amount = Number(transaction.amount || 0) / 100;
  const taxNote = 'Inclusive of applicable platform/payment charges where relevant.';
  const issuedOn = formatReceiptDate(new Date());

  return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Payment Receipt</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      background: #f3f5f8;
      color: #172033;
      font-family: Arial, Helvetica, sans-serif;
    }
    .page {
      width: 794px;
      min-height: 1123px;
      margin: 0 auto;
      background: #ffffff;
      padding: 44px;
      position: relative;
      overflow: hidden;
    }
    .top-band {
      position: absolute;
      inset: 0 0 auto 0;
      height: 190px;
      background: linear-gradient(135deg, #5b321f 0%, #8a5637 100%);
    }
    .receipt {
      position: relative;
      z-index: 1;
    }
    .header {
      display: flex;
      justify-content: space-between;
      gap: 28px;
      color: #ffffff;
      margin-bottom: 44px;
    }
    .brand {
      font-size: 26px;
      font-weight: 800;
      letter-spacing: -0.02em;
      margin-bottom: 8px;
    }
    .brand-subtitle {
      color: #f3d8c8;
      font-size: 13px;
      line-height: 1.5;
    }
    .receipt-title {
      text-align: right;
    }
    .receipt-title h1 {
      margin: 0 0 8px;
      color: #ffffff;
      font-size: 34px;
      line-height: 1;
    }
    .receipt-title p {
      margin: 0;
      color: #f3d8c8;
      font-size: 13px;
    }
    .status-card {
      display: grid;
      grid-template-columns: 1.2fr 0.8fr;
      gap: 18px;
      padding: 24px;
      border: 1px solid #ece4de;
      border-radius: 14px;
      background: #fffaf7;
      box-shadow: 0 18px 40px rgba(75, 43, 27, 0.08);
      margin-bottom: 26px;
    }
    .label {
      display: block;
      color: #7a8699;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-bottom: 7px;
    }
    .amount {
      color: #111827;
      font-size: 34px;
      font-weight: 800;
      margin-bottom: 8px;
    }
    .badge {
      display: inline-flex;
      padding: 8px 12px;
      border-radius: 999px;
      background: #e7f8ee;
      color: #15803d;
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .status-meta {
      text-align: right;
      align-self: center;
      color: #445066;
      line-height: 1.7;
      font-size: 13px;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 18px;
      margin-bottom: 26px;
    }
    .panel {
      border: 1px solid #e9edf3;
      border-radius: 12px;
      padding: 20px;
      min-height: 148px;
    }
    .panel h2 {
      margin: 0 0 14px;
      color: #1f2937;
      font-size: 16px;
    }
    .panel p {
      margin: 0 0 7px;
      color: #445066;
      font-size: 13px;
      line-height: 1.45;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 0 0 22px;
      border: 1px solid #e9edf3;
      border-radius: 12px;
      overflow: hidden;
    }
    th {
      background: #f7f9fc;
      color: #6b7280;
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      text-align: left;
      padding: 13px 16px;
    }
    td {
      padding: 16px;
      border-top: 1px solid #e9edf3;
      color: #1f2937;
      font-size: 13px;
      vertical-align: top;
    }
    td:last-child,
    th:last-child {
      text-align: right;
    }
    .total-row td {
      background: #fffaf7;
      font-weight: 800;
      font-size: 15px;
    }
    .note {
      border-left: 4px solid #8a5637;
      padding: 13px 16px;
      background: #f8fafc;
      color: #5b6474;
      font-size: 12px;
      line-height: 1.6;
      border-radius: 0 10px 10px 0;
      margin-top: 18px;
    }
    .footer {
      position: absolute;
      left: 44px;
      right: 44px;
      bottom: 32px;
      display: flex;
      justify-content: space-between;
      gap: 18px;
      border-top: 1px solid #e9edf3;
      padding-top: 16px;
      color: #7a8699;
      font-size: 11px;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <main class="page">
    <div class="top-band"></div>
    <section class="receipt">
      <header class="header">
        <div>
          <div class="brand">Coimbatore Jobs</div>
          <div class="brand-subtitle">Employer subscription receipt<br />Coimbatore Job Portal</div>
        </div>
        <div class="receipt-title">
          <h1>Receipt</h1>
          <p>${escapeHtml(transaction.receipt || transaction.razorpayOrderId || '-')}</p>
        </div>
      </header>

      <section class="status-card">
        <div>
          <span class="label">Amount Paid</span>
          <div class="amount">${escapeHtml(formatReceiptCurrency(amount, transaction.currency))}</div>
          <span class="badge">${escapeHtml(transaction.status || 'paid')}</span>
        </div>
        <div class="status-meta">
          <strong>Paid on</strong><br />
          ${escapeHtml(formatReceiptDate(paidAt))}<br />
          <strong>Issued on</strong><br />
          ${escapeHtml(issuedOn)}
        </div>
      </section>

      <section class="grid">
        <div class="panel">
          <h2>Billed To</h2>
          <p><strong>${escapeHtml(employer.name || 'Employer')}</strong></p>
          <p>${escapeHtml(getPublicEmployerEmail(employer))}</p>
          ${employer.loginId ? `<p>Login ID: ${escapeHtml(employer.loginId)}</p>` : ''}
        </div>
        <div class="panel">
          <h2>Payment Details</h2>
          <p>Receipt: ${escapeHtml(transaction.receipt || '-')}</p>
          <p>Payment ID: ${escapeHtml(transaction.razorpayPaymentId || '-')}</p>
          <p>Order ID: ${escapeHtml(transaction.razorpayOrderId || '-')}</p>
          <p>Mode: ${escapeHtml(transaction.mode === 'live' ? 'Razorpay Live' : 'Razorpay Test')}</p>
        </div>
      </section>

      <table>
        <thead>
          <tr>
            <th>Description</th>
            <th>Billing Cycle</th>
            <th>Validity</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <strong>${escapeHtml(plan?.name || 'Employer Plan')}</strong><br />
              ${escapeHtml(plan?.planType || 'Paid')} employer subscription
            </td>
            <td>${escapeHtml(plan?.billingCycle || '-')}</td>
            <td>${Number(plan?.validityDays) === -1 ? 'No expiry' : `${escapeHtml(plan?.validityDays || '-')} days`}</td>
            <td>${escapeHtml(formatReceiptCurrency(amount, transaction.currency))}</td>
          </tr>
          <tr class="total-row">
            <td colspan="3">Total Paid</td>
            <td>${escapeHtml(formatReceiptCurrency(amount, transaction.currency))}</td>
          </tr>
        </tbody>
      </table>

      <div class="note">
        ${escapeHtml(taxNote)} This computer generated receipt confirms payment for the employer plan listed above.
      </div>
    </section>
    <footer class="footer">
      <div>Coimbatore Jobs<br />This receipt was generated automatically.</div>
      <div>Receipt ID: ${escapeHtml(transaction.receipt || transaction._id)}</div>
    </footer>
  </main>
</body>
</html>`;
};

const generatePlanReceiptPdf = async ({ transaction, employer, plan }) => {
  let browser;
  try {
    browser = await launchPdfBrowser();
    const page = await browser.newPage();
    const htmlContent = buildPlanReceiptHtml({
      transaction,
      employer: employer || {},
      plan: plan || {},
    });

    await page.setContent(htmlContent, { waitUntil: 'domcontentloaded', timeout: 45000 });
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0px', right: '0px', bottom: '0px', left: '0px' },
    });
  } finally {
    if (browser) {
      await browser.close().catch(() => null);
    }
  }
};

const getPublicEmployerEmail = (user = {}) => {
  const email = String(user.email || '').trim().toLowerCase();
  if (user.isSystemGeneratedEmail || email.endsWith('@internal.coimbatorejobs.in')) {
    return user.contactEmail || 'hello@coimbatorejobs.in';
  }
  return email || user.contactEmail || 'hello@coimbatorejobs.in';
};

const getEmployerReceiptEmail = (user = {}) => {
  const email = String(user.email || '').trim().toLowerCase();
  if (user.isSystemGeneratedEmail || email.endsWith('@internal.coimbatorejobs.in')) {
    return String(user.contactEmail || '').trim();
  }
  return email || String(user.contactEmail || '').trim();
};

const getCycleDateFilter = (cycle = 'Monthly', field = 'createdAt') => {
  if (cycle === 'Total') return {};

  const start = new Date();
  if (cycle === 'Daily') {
    start.setHours(0, 0, 0, 0);
  } else {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
  }

  return { [field]: { $gte: start } };
};

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

const getFeatureLimit = (plan, featureKey, legacyKey = null) => {
  const feature = plan?.[featureKey] || {};
  const legacyValue = legacyKey ? Number(plan?.[legacyKey] || 0) : 0;
  const enabled = Boolean(feature.enabled) || legacyValue === -1 || legacyValue > 0;

  if (!plan || !enabled) {
    return {
      enabled: false,
      limit: 0,
      cycle: feature.cycle || 'Monthly',
      limitType: 'limited',
    };
  }

  if (feature.limitType === 'unlimited' || legacyValue === -1) {
    return {
      enabled: true,
      limit: -1,
      cycle: feature.cycle || 'Monthly',
      limitType: 'unlimited',
    };
  }

  return {
    enabled: true,
    limit: Number(feature.limitCount || legacyValue || 0),
    cycle: feature.cycle || 'Monthly',
    limitType: 'limited',
  };
};

const serializeEmployerPlan = (employer) => {
  const plan = employer.activePaymentPlan || null;

  return {
    _id: employer._id,
    name: employer.name,
    email: getPublicEmployerEmail(employer),
    contactEmail: employer.contactEmail || '',
    loginId: employer.loginId || '',
    status: employer.status || 'pending',
    assignmentSource: employer.assignmentSource || '',
    createdAt: employer.createdAt,
    paymentPlanAssignedAt: employer.paymentPlanAssignedAt,
    plan: plan
      ? {
          _id: plan._id,
          name: plan.name,
          planType: plan.planType,
          price: plan.price,
          billingCycle: plan.billingCycle,
          validityDays: plan.validityDays,
          status: plan.status,
        }
      : null,
  };
};

const addDays = (date, days) => {
  if (!date || Number(days) === -1) return null;
  const expiresAt = new Date(date);
  expiresAt.setDate(expiresAt.getDate() + Number(days || 0));
  return expiresAt;
};

const sendEmployerPlanReceipt = async ({
  employer,
  plan,
  transaction = null,
  receipt,
  activatedAt,
  paymentMode,
}) => {
  try {
    const recipient = getEmployerReceiptEmail(employer);
    if (!recipient || !plan) return;

    const attachments = [];
    if (transaction?.status === 'paid') {
      try {
        const pdfBuffer = await generatePlanReceiptPdf({
          transaction,
          employer,
          plan,
        });
        attachments.push({
          filename: `${sanitizeFilename(transaction.receipt || `plan-receipt-${transaction._id}`)}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf',
        });
      } catch (pdfError) {
        console.error(`Failed to generate receipt PDF for ${transaction.receipt || transaction._id}:`, pdfError);
      }
    }

    await sendPlanReceiptEmail({
      recipient,
      employerName: employer.name,
      planName: plan.name,
      amount: transaction ? Number(transaction.amount || 0) / 100 : Number(plan.price || 0),
      currency: transaction?.currency || 'INR',
      receipt: receipt || transaction?.receipt,
      paymentId: transaction?.razorpayPaymentId,
      activatedAt,
      expiresAt: addDays(activatedAt, plan.validityDays),
      paymentMode,
      attachments,
    });
  } catch (error) {
    console.error(`Failed to send employer plan receipt to ${getEmployerReceiptEmail(employer) || 'unknown'}:`, error);
  }
};

const serializePlanUsage = async (employerId, plan, assignedAt) => {
  const jobFeature = getFeatureLimit(plan, 'jobPostingLimit', 'jobLimit');
  const alertFeature = getFeatureLimit(plan, 'candidateProfileAlerts');
  const resumeFeature = getFeatureLimit(plan, 'resumeDownloads', 'resumeLimit');

  const [jobPostsUsed, alertsUsed, resumeDownloads] = await Promise.all([
    JobPost.countDocuments({
      employer: employerId,
      ...getCycleDateFilter(jobFeature.cycle),
    }),
    ResumeAlert.countDocuments({
      employer: employerId,
      ...getCycleDateFilter(alertFeature.cycle),
    }),
    getResumeDownloadUsage(employerId, resumeFeature.cycle),
  ]);

  return {
    expiresAt: addDays(assignedAt, plan?.validityDays),
    usage: {
      jobPosts: {
        label: 'Job posts',
        ...jobFeature,
        used: jobPostsUsed,
      },
      resumeAlerts: {
        label: 'Candidate profile alerts',
        ...alertFeature,
        used: alertsUsed,
      },
      resumeDownloads: {
        label: 'Resume downloads',
        ...resumeFeature,
        used: resumeDownloads.profileDownloads + resumeDownloads.applicantDownloads,
        profileDownloads: resumeDownloads.profileDownloads,
        applicantDownloads: resumeDownloads.applicantDownloads,
      },
      candidateProfileViewAccess: {
        label: 'Candidate profile view access',
        enabled: Boolean(plan?.candidateProfileViewAccess),
      },
      jobListPageAccess: {
        label: 'Job list page access',
        enabled: Boolean(plan?.jobListPageAccess),
      },
    },
  };
};

const buildEmployerPlanMatch = ({ search, status, planType, planId }) => {
  const match = {
    role: 'employer',
    isActive: true,
    $or: [{ isDeleted: false }, { isDeleted: { $exists: false } }],
  };

  const normalizedStatus = String(status || '').trim().toLowerCase();
  if (normalizedStatus && normalizedStatus !== 'all') {
    if (['pending', 'approved', 'rejected'].includes(normalizedStatus)) {
      match.status = normalizedStatus;
    }
  }

  const andConditions = [];
  const normalizedSearch = String(search || '').trim();
  if (normalizedSearch) {
    const regex = new RegExp(normalizedSearch, 'i');
    andConditions.push({
      $or: [
        { name: regex },
        { email: regex },
        { contactEmail: regex },
        { loginId: regex },
      ],
    });
  }

  if (planId && planId !== 'all') {
    andConditions.push({ activePaymentPlan: planId });
  }

  if (planType && planType !== 'all') {
    if (planType === 'none') {
      andConditions.push({
        $or: [
          { activePaymentPlan: null },
          { activePaymentPlan: { $exists: false } },
        ],
      });
    }
  }

  if (andConditions.length) {
    match.$and = andConditions;
  }

  return match;
};

const getAssignedEmployerIdsForSuperadmin = async () => {
  const hrAdmins = await User.find({ role: 'hr-admin', isActive: true })
    .select('employerIds')
    .lean();

  return [
    ...new Set(
      hrAdmins
        .flatMap((hrAdmin) => hrAdmin.employerIds || [])
        .filter(Boolean)
        .map((id) => id.toString()),
    ),
  ];
};

const getResumeDownloadUsage = async (employerId, cycle) => {
  const monthKey = getIstMonthKey();
  const dayKey = getIstDateKey();

  const profileQuery = { employer: employerId };
  if (cycle === 'Daily') profileQuery.dayKey = dayKey;
  if (cycle === 'Monthly') profileQuery.dayKey = new RegExp(`^${monthKey}`);

  const applicantQuery = { employer: employerId };
  if (cycle === 'Daily') applicantQuery.downloadedAt = getCycleDateFilter('Daily', 'downloadedAt').downloadedAt;
  if (cycle === 'Monthly') applicantQuery.monthKey = monthKey;

  const [profileRows, applicantDownloads] = await Promise.all([
    ResumeDownloadLog.aggregate([
      { $match: profileQuery },
      { $group: { _id: null, total: { $sum: '$downloadCount' } } },
    ]),
    EmployerResumeDownloadLog.countDocuments(applicantQuery),
  ]);

  return {
    profileDownloads: Number(profileRows[0]?.total || 0),
    applicantDownloads: Number(applicantDownloads || 0),
  };
};

const paymentPlanController = {
  async getPaymentPlans(req, res, next) {
    try {
      const plans = await PaymentPlan.find({ createdBy: req.user.id })
        .sort({ createdAt: -1 })
        .lean();

      return res.status(200).json({
        success: true,
        data: plans,
      });
    } catch (error) {
      next(error);
    }
  },

  async getActivePaymentPlans(req, res, next) {
    try {
      const plans = await PaymentPlan.find({ status: 'Active' })
        .sort({ price: 1, createdAt: -1 })
        .lean();

      return res.status(200).json({
        success: true,
        data: sortEmployerPlans(plans),
      });
    } catch (error) {
      next(error);
    }
  },

  async getMyPaymentPlan(req, res, next) {
    try {
      const plan = await resolveEmployerPlan(req.user.id);

      return res.status(200).json({
        success: true,
        data: plan,
      });
    } catch (error) {
      next(error);
    }
  },

  async getMyPlanHistory(req, res, next) {
    try {
      const {
        search = '',
        status = 'all',
        sort = 'latest',
        page = 1,
        limit = 10,
      } = req.query;

      const pageNumber = Math.max(1, parseInt(page, 10) || 1);
      const rawLimit = String(limit).toLowerCase() === 'all' ? 0 : parseInt(limit, 10);
      const limitNumber = rawLimit === 0 ? 0 : Math.min(100, Math.max(1, rawLimit || 10));
      const skip = limitNumber ? (pageNumber - 1) * limitNumber : 0;

      await resolveEmployerPlan(req.user.id);

      const employer = await User.findById(req.user.id)
        .select('activePaymentPlan paymentPlanAssignedAt')
        .populate('activePaymentPlan')
        .lean();

      const currentPlan = employer?.activePaymentPlan || null;
      const currentUsage = currentPlan
        ? await serializePlanUsage(req.user.id, currentPlan, employer.paymentPlanAssignedAt)
        : { expiresAt: null, usage: null };

      const normalizedStatus = String(status || '').trim().toLowerCase();
      const transactionQuery = { employer: req.user.id };
      if (normalizedStatus && normalizedStatus !== 'all') {
        transactionQuery.status = normalizedStatus;
      }

      const transactions = await PaymentTransaction.find(transactionQuery)
        .populate('paymentPlan')
        .sort({ createdAt: -1 })
        .lean();

      const normalizedSearch = String(search || '').trim().toLowerCase();
      const filteredTransactions = transactions.filter((transaction) => {
        if (!normalizedSearch) return true;

        const planName = String(transaction.paymentPlan?.name || '').toLowerCase();
        const planType = String(transaction.paymentPlan?.planType || '').toLowerCase();
        const receipt = String(transaction.receipt || '').toLowerCase();
        const orderId = String(transaction.razorpayOrderId || '').toLowerCase();
        const paymentId = String(transaction.razorpayPaymentId || '').toLowerCase();
        const transactionStatus = String(transaction.status || '').toLowerCase();

        return [planName, planType, receipt, orderId, paymentId, transactionStatus]
          .some((value) => value.includes(normalizedSearch));
      });

      const sortedTransactions = filteredTransactions.sort((first, second) => {
        const firstPlan = String(first.paymentPlan?.name || '');
        const secondPlan = String(second.paymentPlan?.name || '');
        const firstDate = new Date(first.paidAt || first.createdAt || 0).getTime();
        const secondDate = new Date(second.paidAt || second.createdAt || 0).getTime();
        const firstAmount = Number(first.amount || 0);
        const secondAmount = Number(second.amount || 0);

        if (sort === 'oldest') return firstDate - secondDate;
        if (sort === 'plan_asc') return firstPlan.localeCompare(secondPlan);
        if (sort === 'plan_desc') return secondPlan.localeCompare(firstPlan);
        if (sort === 'amount_asc') return firstAmount - secondAmount;
        if (sort === 'amount_desc') return secondAmount - firstAmount;

        return secondDate - firstDate;
      });

      const totalCount = sortedTransactions.length;
      const pagedTransactions = limitNumber
        ? sortedTransactions.slice(skip, skip + limitNumber)
        : sortedTransactions;

      return res.status(200).json({
        success: true,
        currentPlan: currentPlan
          ? {
              _id: currentPlan._id,
              name: currentPlan.name,
              planType: currentPlan.planType,
              price: currentPlan.price,
              validityDays: currentPlan.validityDays,
              billingCycle: currentPlan.billingCycle,
              assignedAt: employer.paymentPlanAssignedAt,
              expiresAt: currentUsage.expiresAt,
              candidateProfileViewAccess: Boolean(currentPlan.candidateProfileViewAccess),
              jobListPageAccess: Boolean(currentPlan.jobListPageAccess),
            }
          : null,
        usage: currentUsage.usage,
        data: pagedTransactions.map((transaction) => ({
          _id: transaction._id,
          status: transaction.status,
          amount: transaction.amount,
          currency: transaction.currency,
          mode: transaction.mode,
          receipt: transaction.receipt,
          razorpayOrderId: transaction.razorpayOrderId,
          razorpayPaymentId: transaction.razorpayPaymentId,
          paidAt: transaction.paidAt,
          createdAt: transaction.createdAt,
          isCurrentPlan:
            currentPlan && transaction.paymentPlan?._id?.toString() === currentPlan._id?.toString(),
          plan: transaction.paymentPlan
            ? {
                _id: transaction.paymentPlan._id,
                name: transaction.paymentPlan.name,
                planType: transaction.paymentPlan.planType,
                price: transaction.paymentPlan.price,
                validityDays: transaction.paymentPlan.validityDays,
                billingCycle: transaction.paymentPlan.billingCycle,
              }
            : null,
        })),
        pagination: {
          page: pageNumber,
          limit: limitNumber || 'all',
          totalCount,
          totalPages: limitNumber ? Math.max(1, Math.ceil(totalCount / limitNumber)) : 1,
        },
      });
    } catch (error) {
      next(error);
    }
  },

  async downloadMyPlanReceipt(req, res, next) {
    try {
      const transaction = await PaymentTransaction.findOne({
        _id: req.params.transactionId,
        employer: req.user.id,
      })
        .populate('paymentPlan')
        .populate('employer', 'name email contactEmail loginId isSystemGeneratedEmail')
        .lean();

      if (!transaction) {
        return res.status(404).json({
          success: false,
          message: 'Payment receipt not found',
        });
      }

      if (transaction.status !== 'paid') {
        return res.status(400).json({
          success: false,
          message: 'Receipt is available only for paid transactions',
        });
      }

      const pdfBuffer = await generatePlanReceiptPdf({
        transaction,
        employer: transaction.employer || {},
        plan: transaction.paymentPlan || {},
      });

      const filename = `${sanitizeFilename(transaction.receipt || `plan-receipt-${transaction._id}`)}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      return res.send(pdfBuffer);
    } catch (error) {
      const errorMsg = String(error?.message || '');
      if (errorMsg.includes('Could not find Chrome')) {
        return res.status(500).json({
          success: false,
          message:
            'PDF generation failed: Chrome browser is not available on server. Configure CHROME_PATH or install Chrome in runtime.',
        });
      }
      if (errorMsg.includes('Target closed') || errorMsg.includes('Page.printToPDF')) {
        return res.status(500).json({
          success: false,
          message:
            'PDF generation failed: browser process closed unexpectedly. Please retry once; if it continues, contact support.',
        });
      }
      next(error);
    }
  },

  async deleteMyPlanHistoryTransaction(req, res, next) {
    try {
      const transaction = await PaymentTransaction.findOne({
        _id: req.params.transactionId,
        employer: req.user.id,
      });

      if (!transaction) {
        return res.status(404).json({
          success: false,
          message: 'Payment history not found',
        });
      }

      await transaction.deleteOne();

      return res.status(200).json({
        success: true,
        message: 'Payment history deleted successfully',
      });
    } catch (error) {
      next(error);
    }
  },

  async createPaymentOrder(req, res, next) {
    try {
      const plan = await PaymentPlan.findOne({
        _id: req.params.id,
        status: 'Active',
      });

      if (!plan) {
        return res.status(404).json({
          success: false,
          message: 'Payment plan not found',
        });
      }

      if (plan.planType === 'Free' || Number(plan.price) <= 0) {
        const assignedAt = new Date();
        const user = await User.findByIdAndUpdate(
          req.user.id,
          {
            activePaymentPlan: plan._id,
            paymentPlanAssignedAt: assignedAt,
            assignmentSource: 'payment',
          },
          { new: true, runValidators: true },
        ).select('name email contactEmail isSystemGeneratedEmail');

        sendEmployerPlanReceipt({
          employer: user,
          plan,
          receipt: buildReceipt(plan._id, req.user.id),
          activatedAt: assignedAt,
          paymentMode: 'Free activation',
        });

        return res.status(200).json({
          success: true,
          paymentRequired: false,
          message: 'Free plan activated successfully',
          data: {
            plan: serializeCheckoutPlan(plan),
          },
        });
      }

      const amountInPaise = Math.round(Number(plan.price) * 100);
      const receipt = buildReceipt(plan._id, req.user.id);
      const order = await createRazorpayOrder({
        amount: amountInPaise,
        currency: 'INR',
        receipt,
        notes: {
          planId: String(plan._id),
          employerId: String(req.user.id),
        },
      });

      const transaction = await PaymentTransaction.create({
        employer: req.user.id,
        paymentPlan: plan._id,
        amount: amountInPaise,
        currency: order.currency || 'INR',
        status: 'created',
        mode: RAZORPAY_MODE,
        razorpayOrderId: order.id,
        receipt,
      });

      return res.status(201).json({
        success: true,
        paymentRequired: true,
        data: {
          keyId: getRazorpayPublicConfig().keyId,
          mode: RAZORPAY_MODE,
          order,
          transactionId: transaction._id,
          plan: serializeCheckoutPlan(plan),
        },
      });
    } catch (error) {
      next(error);
    }
  },

  async verifyPayment(req, res, next) {
    try {
      const {
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
      } = req.body;

      if (!orderId || !paymentId || !signature) {
        return res.status(400).json({
          success: false,
          message: 'Razorpay payment details are required',
        });
      }

      const transaction = await PaymentTransaction.findOne({
        razorpayOrderId: orderId,
        employer: req.user.id,
      });

      if (!transaction) {
        return res.status(404).json({
          success: false,
          message: 'Payment transaction not found',
        });
      }

      const isValidSignature = verifyRazorpayPaymentSignature({
        orderId,
        paymentId,
        signature,
      });

      if (!isValidSignature) {
        transaction.status = 'failed';
        transaction.razorpayPaymentId = paymentId;
        transaction.razorpaySignature = signature;
        await transaction.save();

        return res.status(400).json({
          success: false,
          message: 'Invalid Razorpay payment signature',
        });
      }

      transaction.status = 'paid';
      transaction.razorpayPaymentId = paymentId;
      transaction.razorpaySignature = signature;
      transaction.paidAt = new Date();
      await transaction.save();

      const user = await User.findByIdAndUpdate(
        req.user.id,
        {
          activePaymentPlan: transaction.paymentPlan,
          paymentPlanAssignedAt: transaction.paidAt,
          assignmentSource: 'payment',
        },
        { new: true, runValidators: true },
      ).select('name email contactEmail isSystemGeneratedEmail activePaymentPlan paymentPlanAssignedAt');

      const plan = await PaymentPlan.findById(transaction.paymentPlan).lean();

      sendEmployerPlanReceipt({
        employer: user,
        plan,
        transaction,
        activatedAt: transaction.paidAt,
        paymentMode: RAZORPAY_MODE === 'test' ? 'Razorpay Test' : 'Razorpay',
      });

      return res.status(200).json({
        success: true,
        message: 'Payment verified and plan activated successfully',
        data: {
          transaction,
          plan,
          activePaymentPlan: user?.activePaymentPlan || null,
          paymentPlanAssignedAt: user?.paymentPlanAssignedAt || null,
        },
      });
    } catch (error) {
      next(error);
    }
  },

  async markPaymentFailed(req, res, next) {
    try {
      const {
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
        error = {},
      } = req.body;

      const resolvedOrderId = orderId || error?.metadata?.order_id;
      const resolvedPaymentId = paymentId || error?.metadata?.payment_id;

      if (!resolvedOrderId) {
        return res.status(400).json({
          success: false,
          message: 'Razorpay order ID is required',
        });
      }

      const transaction = await PaymentTransaction.findOne({
        razorpayOrderId: resolvedOrderId,
        employer: req.user.id,
      });

      if (!transaction) {
        return res.status(404).json({
          success: false,
          message: 'Payment transaction not found',
        });
      }

      if (transaction.status !== 'paid') {
        transaction.status = 'failed';
        if (resolvedPaymentId) transaction.razorpayPaymentId = resolvedPaymentId;
        if (signature) transaction.razorpaySignature = signature;
        await transaction.save();
      }

      return res.status(200).json({
        success: true,
        message: error?.description || 'Payment failed and history was updated',
        data: transaction,
      });
    } catch (error) {
      next(error);
    }
  },

  async createPaymentPlan(req, res, next) {
    try {
      const payload = normalizePayload(req.body);
      let message = 'Payment plan created successfully';

      if (isFreePlanPayload(payload) && payload.status === 'Active') {
        const existingActiveFreePlan = await findActiveFreePlan(req.user.id);
        if (existingActiveFreePlan) {
          payload.status = 'Inactive';
          message =
            'Free plan created as inactive because another active Free plan already exists.';
        }
      }

      const plan = await PaymentPlan.create({
        ...payload,
        createdBy: req.user.id,
      });

      return res.status(201).json({
        success: true,
        message,
        data: plan,
      });
    } catch (error) {
      next(error);
    }
  },

  async updatePaymentPlan(req, res, next) {
    try {
      const payload = normalizePayload(req.body);

      if (isFreePlanPayload(payload) && payload.status === 'Active') {
        const existingActiveFreePlan = await findActiveFreePlan(req.user.id, req.params.id);
        if (existingActiveFreePlan) {
          return res.status(409).json({
            success: false,
            code: 'ACTIVE_FREE_PLAN_EXISTS',
            message: ACTIVE_FREE_PLAN_CONFLICT_MESSAGE,
          });
        }
      }

      const plan = await PaymentPlan.findOneAndUpdate(
        { _id: req.params.id, createdBy: req.user.id },
        payload,
        { new: true, runValidators: true },
      );

      if (!plan) {
        return res.status(404).json({
          success: false,
          message: 'Payment plan not found',
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Payment plan updated successfully',
        data: plan,
      });
    } catch (error) {
      next(error);
    }
  },

  async updatePaymentPlanStatus(req, res, next) {
    try {
      const nextStatus = req.body.status;
      if (!['Active', 'Inactive'].includes(nextStatus)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid status value',
        });
      }

      const currentPlan = await PaymentPlan.findOne({
        _id: req.params.id,
        createdBy: req.user.id,
      });

      if (!currentPlan) {
        return res.status(404).json({
          success: false,
          message: 'Payment plan not found',
        });
      }

      if (nextStatus === 'Active' && isFreePlanPayload(currentPlan)) {
        const existingActiveFreePlan = await findActiveFreePlan(req.user.id, currentPlan._id);
        if (existingActiveFreePlan) {
          return res.status(409).json({
            success: false,
            code: 'ACTIVE_FREE_PLAN_EXISTS',
            message: ACTIVE_FREE_PLAN_CONFLICT_MESSAGE,
          });
        }
      }

      currentPlan.status = nextStatus;
      const plan = await currentPlan.save();

      if (!plan) {
        return res.status(404).json({
          success: false,
          message: 'Payment plan not found',
        });
      }

      return res.status(200).json({
        success: true,
        message: `Payment plan marked as ${nextStatus.toLowerCase()}`,
        data: plan,
      });
    } catch (error) {
      next(error);
    }
  },

  async deletePaymentPlan(req, res, next) {
    try {
      const plan = await PaymentPlan.findOneAndDelete({
        _id: req.params.id,
        createdBy: req.user.id,
      });

      if (!plan) {
        return res.status(404).json({
          success: false,
          message: 'Payment plan not found',
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Payment plan deleted successfully',
      });
    } catch (error) {
      next(error);
    }
  },

  async getEmployerPlanOverview(req, res, next) {
    try {
      const {
        view = 'assigned',
        search = '',
        status = 'all',
        planType = 'all',
        planId = 'all',
        sort = 'latest',
        page = 1,
        limit = 10,
      } = req.query;

      const pageNumber = Math.max(1, parseInt(page, 10) || 1);
      const rawLimit = String(limit).toLowerCase() === 'all' ? 0 : parseInt(limit, 10);
      const limitNumber = rawLimit === 0 ? 0 : Math.min(100, Math.max(1, rawLimit || 10));
      const skip = limitNumber ? (pageNumber - 1) * limitNumber : 0;

      await assignFreePlanToEmployersWithoutActivePlan();

      const query = buildEmployerPlanMatch({ search, status, planType, planId });

      if (['Free', 'Paid'].includes(planType) && (!planId || planId === 'all')) {
        const matchingPlans = await PaymentPlan.find({ planType }).select('_id').lean();
        query.activePaymentPlan = { $in: matchingPlans.map((plan) => plan._id) };
      }

      if (view === 'assigned') {
        const assignedEmployerIds = await getAssignedEmployerIdsForSuperadmin();
        query._id = { $in: assignedEmployerIds };
      }

      const [matchedEmployers, allPlans, summaryRows] = await Promise.all([
        User.find(query, { password: 0 })
          .populate('activePaymentPlan')
          .lean(),
        PaymentPlan.find({}).sort({ planType: 1, price: 1, name: 1 }).select('_id name planType price').lean(),
        User.aggregate([
          {
            $match: {
              role: 'employer',
              isActive: true,
              $or: [{ isDeleted: false }, { isDeleted: { $exists: false } }],
            },
          },
          {
            $lookup: {
              from: 'paymentplans',
              localField: 'activePaymentPlan',
              foreignField: '_id',
              as: 'plan',
            },
          },
          { $unwind: { path: '$plan', preserveNullAndEmptyArrays: true } },
          {
            $group: {
              _id: {
                planId: '$plan._id',
                name: '$plan.name',
                planType: '$plan.planType',
              },
              count: { $sum: 1 },
            },
          },
        ]),
      ]);

      const sortedEmployers = [...matchedEmployers].sort((first, second) => {
        const firstName = String(first.name || '');
        const secondName = String(second.name || '');
        const firstPlan = String(first.activePaymentPlan?.name || 'No Plan');
        const secondPlan = String(second.activePaymentPlan?.name || 'No Plan');
        const firstStatus = String(first.status || 'pending');
        const secondStatus = String(second.status || 'pending');
        const firstDate = new Date(first.createdAt || 0).getTime();
        const secondDate = new Date(second.createdAt || 0).getTime();

        if (sort === 'oldest') return firstDate - secondDate;
        if (sort === 'name_asc') return firstName.localeCompare(secondName);
        if (sort === 'name_desc') return secondName.localeCompare(firstName);
        if (sort === 'plan_asc') return firstPlan.localeCompare(secondPlan) || firstName.localeCompare(secondName);
        if (sort === 'plan_desc') return secondPlan.localeCompare(firstPlan) || firstName.localeCompare(secondName);
        if (sort === 'status') return firstStatus.localeCompare(secondStatus) || secondDate - firstDate;

        return secondDate - firstDate;
      });

      const totalCount = sortedEmployers.length;
      const employers = limitNumber ? sortedEmployers.slice(skip, skip + limitNumber) : sortedEmployers;

      const paidPlanCounts = summaryRows
        .filter((row) => row._id?.planType === 'Paid')
        .map((row) => ({
          planId: row._id.planId,
          name: row._id.name,
          count: row.count,
        }));

      const freeEmployers = summaryRows
        .filter((row) => row._id?.planType === 'Free')
        .reduce((sum, row) => sum + row.count, 0);
      const paidEmployers = paidPlanCounts.reduce((sum, row) => sum + row.count, 0);
      const noPlanEmployers = summaryRows
        .filter((row) => !row._id?.planId)
        .reduce((sum, row) => sum + row.count, 0);

      return res.status(200).json({
        success: true,
        data: employers.map(serializeEmployerPlan),
        plans: allPlans,
        summary: {
          totalEmployers: summaryRows.reduce((sum, row) => sum + row.count, 0),
          freeEmployers,
          paidEmployers,
          noPlanEmployers,
          paidPlanCounts,
        },
        pagination: {
          page: pageNumber,
          limit: limitNumber || 'all',
          totalCount,
          totalPages: limitNumber ? Math.max(1, Math.ceil(totalCount / limitNumber)) : 1,
        },
      });
    } catch (error) {
      next(error);
    }
  },

  async removeEmployerPaymentPlan(req, res, next) {
    try {
      const employer = await User.findOne({
        _id: req.params.employerId,
        role: 'employer',
        isActive: true,
        $or: [{ isDeleted: false }, { isDeleted: { $exists: false } }],
      }).populate('activePaymentPlan');

      if (!employer) {
        return res.status(404).json({
          success: false,
          message: 'Employer not found',
        });
      }

      const currentPlan = employer.activePaymentPlan || null;
      const hasPaidPlan =
        currentPlan &&
        currentPlan.planType !== 'Free' &&
        Number(currentPlan.price || 0) > 0;

      if (!hasPaidPlan) {
        return res.status(400).json({
          success: false,
          message: 'Only paid employer plans can be removed',
        });
      }

      const freePlan = await findLatestActiveFreePlan();
      if (!freePlan) {
        return res.status(404).json({
          success: false,
          message: 'Active Free plan not found',
        });
      }

      employer.activePaymentPlan = freePlan._id;
      employer.paymentPlanAssignedAt = new Date();
      employer.assignmentSource = 'superadmin';
      await employer.save();

      const updatedEmployer = await User.findById(employer._id)
        .select('-password')
        .populate('activePaymentPlan')
        .lean();

      return res.status(200).json({
        success: true,
        message: 'Employer plan removed and Free plan assigned successfully',
        data: serializeEmployerPlan(updatedEmployer),
      });
    } catch (error) {
      next(error);
    }
  },

  async getEmployerPlanUsage(req, res, next) {
    try {
      await resolveEmployerPlan(req.params.employerId);

      const employer = await User.findOne({
        _id: req.params.employerId,
        role: 'employer',
        isActive: true,
        $or: [{ isDeleted: false }, { isDeleted: { $exists: false } }],
      })
        .select('-password')
        .populate('activePaymentPlan')
        .lean();

      if (!employer) {
        return res.status(404).json({
          success: false,
          message: 'Employer not found',
        });
      }

      const plan = employer.activePaymentPlan || null;
      const jobFeature = getFeatureLimit(plan, 'jobPostingLimit', 'jobLimit');
      const alertFeature = getFeatureLimit(plan, 'candidateProfileAlerts');
      const resumeFeature = getFeatureLimit(plan, 'resumeDownloads', 'resumeLimit');

      const [
        jobPostsUsed,
        alertsUsed,
        resumeDownloads,
        latestPaidTransaction,
      ] = await Promise.all([
        JobPost.countDocuments({
          employer: employer._id,
          ...getCycleDateFilter(jobFeature.cycle),
        }),
        ResumeAlert.countDocuments({
          employer: employer._id,
          ...getCycleDateFilter(alertFeature.cycle),
        }),
        getResumeDownloadUsage(employer._id, resumeFeature.cycle),
        PaymentTransaction.findOne({
          employer: employer._id,
          status: 'paid',
        })
          .populate('paymentPlan', 'name price planType')
          .sort({ paidAt: -1, createdAt: -1 })
          .lean(),
      ]);

      return res.status(200).json({
        success: true,
        data: {
          employer: serializeEmployerPlan(employer),
          plan: plan
            ? {
                _id: plan._id,
                name: plan.name,
                planType: plan.planType,
                price: plan.price,
                billingCycle: plan.billingCycle,
                validityDays: plan.validityDays,
                assignedAt: employer.paymentPlanAssignedAt,
                candidateProfileViewAccess: Boolean(plan.candidateProfileViewAccess),
                jobListPageAccess: Boolean(plan.jobListPageAccess),
                jobPostingDurationDays: plan.jobPostingDurationDays,
              }
            : null,
          usage: {
            jobPosts: {
              label: 'Job posts',
              ...jobFeature,
              used: jobPostsUsed,
            },
            resumeAlerts: {
              label: 'Candidate profile alerts',
              ...alertFeature,
              used: alertsUsed,
            },
            resumeDownloads: {
              label: 'Resume downloads',
              ...resumeFeature,
              used: resumeDownloads.profileDownloads + resumeDownloads.applicantDownloads,
              profileDownloads: resumeDownloads.profileDownloads,
              applicantDownloads: resumeDownloads.applicantDownloads,
            },
            candidateProfileViewAccess: {
              label: 'Candidate profile view access',
              enabled: Boolean(plan?.candidateProfileViewAccess),
            },
            jobListPageAccess: {
              label: 'Job list page access',
              enabled: Boolean(plan?.jobListPageAccess),
            },
          },
          latestPaidTransaction,
        },
      });
    } catch (error) {
      next(error);
    }
  },
};

export default paymentPlanController;
