// tests/jobLifecycle.controller.test.js
// ---------------------------------------------------------------------------
// Controller-level lifecycle tests for the Google Indexing integration.
//
// These drive the REAL controller handlers (single create, bulk upload, admin
// approval, update, delete, candidate apply / withdraw, account deletion) with
// stubbed Mongoose model methods, and record every notification the controllers
// hand to the indexing service. The service and sweep suites cover what happens
// to a notification; this suite proves the controllers send the right ones,
// only after the database write succeeded, and exactly once — the gap that let a
// duplicate `status` key reach production unnoticed.
//
// No database, no network, no email, no Google:
//   * tests/helpers/controllerTestEnv.js pins an inert environment first;
//   * indexingService.submitNotification — the single delivery point behind
//     notifyJobPublished / notifyJobRemoved / notifyJobWithdrawal — is replaced
//     with a recorder before every test;
//   * every model method a flow touches is stubbed, and unstubbed queries fail
//     fast (bufferCommands = false).
// Run with: npm test
// ---------------------------------------------------------------------------
import './helpers/controllerTestEnv.js';

import test, { afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import JobPost from '../models/jobs.model.js';
import User from '../models/user.model.js';
import PaymentPlan from '../models/paymentPlan.model.js';
import CompanyProfile from '../models/companyProfile.model.js';
import Industry from '../models/industry.model.js';
import FunctionalArea from '../models/functionalArea.model.js';
import Role from '../models/role.model.js';
import Location from '../models/location.model.js';
import JobApply from '../models/jobApply.model.js';
import CandidateProfile from '../models/candidateProfile.model.js';
import CandidateResume from '../models/candidateResume.model.js';
import CandidateCv from '../models/candidateCv.model.js';
import JobAlert from '../models/jobAlert.model.js';
import ResumeAlert from '../models/resumeAlert.model.js';
import SavedJob from '../models/savedJob.model.js';
import SavedCandidate from '../models/savedCandidate.model.js';
import ResumeDownloadLog from '../models/resumeDownloadLog.model.js';
import Notification from '../models/notification.model.js';
import IndexingLog from '../models/indexingLog.model.js';
import indexingService from '../utils/googleIndexing.js';
import jobsController from '../controller/jobs.controller.js';
import candidateController from '../controller/candidate.controller.js';
import authController from '../controller/auth.controller.js';

// ===========================================================================
// Harness
// ===========================================================================

const SITE = 'https://coimbatorejobs.in';
const objectId = (suffix) => `64b7f0c2a1b2c3d4e5f6${suffix}`;

const EMPLOYER_ID = objectId('0001');
const ADMIN_ID = objectId('0002');
const COMPANY_ID = objectId('0003');
const INDUSTRY_ID = objectId('0004');
const FUNCTIONAL_AREA_ID = objectId('0005');
const ROLE_ID = objectId('0006');
const PLAN_ID = objectId('0007');
const JOB_ID = objectId('0008');
const CANDIDATE_ID = objectId('0009');
const APPLICATION_ID = objectId('000a');
const CANDIDATE_PROFILE_ID = objectId('000b');

const DAY_MS = 86400000;
const inDays = (days) => new Date(Date.now() + days * DAY_MS);
const isoDate = (date) => date.toISOString().slice(0, 10);

const slugFor = (title) =>
  `${String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}-jobs-in-coimbatore-acme-tools`;
const urlFor = (title) => `${SITE}/job/${slugFor(title)}`;
const JOB_TITLE = 'Test Engineer';
const JOB_URL = urlFor(JOB_TITLE);

const employer = { id: EMPLOYER_ID, role: 'employer', email: 'employer@example.invalid' };
const superadmin = { id: ADMIN_ID, role: 'superadmin', email: 'admin@example.invalid' };
const candidate = { id: CANDIDATE_ID, role: 'candidate' };

const DB_FAILURE = () => new Error('simulated database write failure');

/** Ordered trace of persisted writes and Google notifications. */
let events = [];
/** Every notification the controllers handed to the indexing service. */
let google = [];

const notified = (type) => google.filter((entry) => entry.type === type);
const firstGoogleEvent = () => events.findIndex((event) => event.startsWith('google:'));

/**
 * Thenable stand-in for a Mongoose query: builder methods chain, and awaiting it
 * resolves `value` (or rejects when `value` is an Error). `onResolved` runs only
 * for a successful result — use it to record that a write persisted.
 */
const query = (value, onResolved) => {
  const chain = {};
  for (const method of ['populate', 'select', 'sort', 'lean', 'session', 'limit', 'skip']) {
    chain[method] = () => chain;
  }
  chain.then = (resolve, reject) => {
    if (value instanceof Error) return Promise.reject(value).then(resolve, reject);
    onResolved?.();
    return Promise.resolve(value).then(resolve, reject);
  };
  return chain;
};

const makeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
};

/** Lets fire-and-forget notifications (including audit-trail lookups) settle. */
const flush = async () => {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

/** Runs a controller handler; resolves with the response and any error passed to next(). */
const run = async (handler, req) => {
  const res = makeRes();
  let error = null;
  await handler(req, res, (err) => {
    error = err;
  });
  await flush();
  return { res, error };
};

beforeEach(() => {
  events = [];
  google = [];

  // The single delivery point behind notifyJobPublished / notifyJobRemoved /
  // notifyJobWithdrawal. Recorded here; the real method is never called.
  mock.method(indexingService, 'submitNotification', async (url, type, options = {}) => {
    google.push({
      url,
      type,
      source: options.source,
      jobPost: options.jobPost ? String(options.jobPost) : null,
    });
    events.push(`google:${type}`);
    return { submitted: true, status: 'success', httpStatus: 200 };
  });

  // Audit trail consulted by withdrawal checks: nothing on record unless a test says so.
  mock.method(IndexingLog, 'find', () => query([]));

  for (const method of ['log', 'warn', 'error']) {
    mock.method(console, method, () => {});
  }
});

afterEach(() => {
  mock.restoreAll();
});

// ===========================================================================
// A. Single create
// ===========================================================================

/**
 * Stubs every read the single and bulk create paths perform, and records saves.
 * The admin-alert and employer-email lookups return nobody, so no email or push
 * branch runs.
 */
const stubJobCreation = ({ failSaveFor = [] } = {}) => {
  const saved = [];
  const company = { _id: COMPANY_ID, employer: EMPLOYER_ID, status: 'approved', companyName: 'Acme Tools' };

  mock.method(User, 'findById', () => ({
    // resolveEmployerPlan asks for plan fields; the actor / selected-employer
    // lookups that decide email recipients get nobody.
    select: async (fields) => (String(fields).includes('activePaymentPlan')
      ? { _id: EMPLOYER_ID, role: 'employer', activePaymentPlan: PLAN_ID }
      : null),
  }));
  mock.method(User, 'find', () => query([]));
  // Legacy jobLimit -1 is an unlimited plan, so no usage-count query runs.
  mock.method(PaymentPlan, 'findOne', async () => ({ _id: PLAN_ID, status: 'Active', jobLimit: -1 }));
  mock.method(CompanyProfile, 'findOne', async () => company);
  mock.method(CompanyProfile, 'find', () => query([company]));
  mock.method(Industry, 'findById', (value) => query({ _id: value }));
  mock.method(Industry, 'findOne', () => query({ _id: INDUSTRY_ID }));
  mock.method(FunctionalArea, 'findById', (value) => query({ _id: value }));
  mock.method(FunctionalArea, 'findOne', () => query({ _id: FUNCTIONAL_AREA_ID }));
  mock.method(Role, 'findById', () => query(null));
  mock.method(Role, 'findOne', () => query({ _id: ROLE_ID }));
  mock.method(Location, 'findOne', async () => null);
  mock.method(JobPost, 'exists', () => query(null));
  mock.method(JobPost, 'findById', () => query(null));
  mock.method(JobPost.prototype, 'save', async function save() {
    if (failSaveFor.includes(this.title)) throw DB_FAILURE();
    if (!this.slug) this.slug = slugFor(this.title);
    saved.push(this);
    events.push(`db:save:${this.title}`);
    return this;
  });

  return saved;
};

const createBody = (overrides = {}) => ({
  title: JOB_TITLE,
  description: 'Build and test things.',
  contactEmail: 'hr@example.com',
  jobType: 'Full-time',
  offeredSalary: '3 - 6 LPA',
  careerLevel: 'Mid Level',
  experience: '1-3 Years',
  qualification: ['BE'],
  applicationDeadline: inDays(30).toISOString(),
  positions: { total: 2 },
  location: { country: 'India', city: ['Coimbatore'], completeAddress: 'Test address' },
  functionalAreas: [FUNCTIONAL_AREA_ID],
  industry: INDUSTRY_ID,
  collarCategory: 'White Collar',
  ...overrides,
});

const createJob = (user, overrides) =>
  run(jobsController.createJobPost, { user, body: createBody(overrides) });

test('create (employer): Draft is saved as Draft and sends no URL_UPDATED', async () => {
  const saved = stubJobCreation();
  const { res, error } = await createJob(employer, { status: 'Draft' });

  assert.equal(error, null);
  assert.equal(res.statusCode, 201);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].status, 'Draft');
  assert.equal(google.length, 0);
});

test('create (employer): Published is saved as Published and sends one URL_UPDATED after the save', async () => {
  const saved = stubJobCreation();
  const { res, error } = await createJob(employer, { status: 'Published' });

  assert.equal(error, null);
  assert.equal(res.statusCode, 201);
  assert.equal(saved[0].status, 'Published');
  assert.equal(saved[0].jobApprovalStatus, 'not_required');
  assert.deepEqual(google, [
    { url: JOB_URL, type: 'URL_UPDATED', source: 'create', jobPost: String(saved[0]._id) },
  ]);
  assert.deepEqual(events, [`db:save:${JOB_TITLE}`, 'google:URL_UPDATED']);
});

test('create (employer): an omitted status keeps the Published default and is announced', async () => {
  const saved = stubJobCreation();
  const { res } = await createJob(employer, { status: undefined });

  assert.equal(res.statusCode, 201);
  assert.equal(saved[0].status, 'Published');
  assert.equal(notified('URL_UPDATED').length, 1);
});

test('create (employer): Closed is saved as Closed with closure metadata and sends no URL_UPDATED', async () => {
  const saved = stubJobCreation();
  const { res, error } = await createJob(employer, { status: 'Closed' });

  assert.equal(error, null);
  assert.equal(res.statusCode, 201);
  assert.equal(saved[0].status, 'Closed');
  assert.ok(saved[0].closedAt instanceof Date);
  assert.equal(String(saved[0].closedBy), EMPLOYER_ID);
  assert.equal(saved[0].closedByRole, 'employer');
  assert.equal(google.length, 0);
});

test('create (employer): the requested status is the saved status (duplicate-status regression)', async () => {
  const saved = stubJobCreation();
  for (const status of ['Draft', 'Published', 'Closed']) {
    await createJob(employer, { status });
  }

  assert.deepEqual(saved.map((job) => job.status), ['Draft', 'Published', 'Closed']);
  assert.equal(notified('URL_UPDATED').length, 1, 'only the Published job is announced');
});

test('create (employer): Published with a past deadline is saved but not announced', async () => {
  const saved = stubJobCreation();
  const { res } = await createJob(employer, { status: 'Published', applicationDeadline: inDays(-2).toISOString() });

  assert.equal(res.statusCode, 201);
  assert.equal(saved[0].status, 'Published');
  assert.equal(google.length, 0);
});

test('create (admin): an admin post is always a pending Draft and is never announced', async () => {
  const saved = stubJobCreation();
  for (const status of ['Published', 'Closed', undefined]) {
    const { res, error } = await createJob(superadmin, { employerId: EMPLOYER_ID, status });
    assert.equal(error, null, `requested status ${status}`);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.message, 'Job post created and sent to employer for approval');
  }

  assert.deepEqual(
    saved.map((job) => [job.status, job.jobApprovalStatus]),
    [['Draft', 'pending'], ['Draft', 'pending'], ['Draft', 'pending']]
  );
  assert.ok(saved.every((job) => job.jobApprovalRequestedAt instanceof Date));
  assert.ok(saved.every((job) => !job.closedAt));
  assert.equal(google.length, 0);
});

test('create: an unknown status is rejected before anything is saved or announced', async () => {
  const saved = stubJobCreation();
  const { res, error } = await createJob(employer, { status: 'Archived' });

  assert.match(error?.message ?? '', /status must be one of: Draft, Published, Closed/);
  assert.equal(res.statusCode, null);
  assert.equal(saved.length, 0);
  assert.equal(google.length, 0);
});

test('create: a Google failure after the save does not fail job creation', async () => {
  const saved = stubJobCreation();
  indexingService.submitNotification.mock.mockImplementation(async () => {
    throw new Error('Google Indexing API returned HTTP 429');
  });

  const { res, error } = await createJob(employer, { status: 'Published' });

  assert.equal(error, null);
  assert.equal(res.statusCode, 201);
  assert.equal(saved[0].status, 'Published');
  assert.equal(indexingService.submitNotification.mock.callCount(), 1);
  assert.ok(
    console.error.mock.calls.some((call) => String(call.arguments[0]).includes('Unhandled indexing failure')),
    'the failure is logged, not thrown'
  );
});

// ===========================================================================
// B. Bulk upload
// ===========================================================================

// [row key, template header] — mirrors BULK_JOB_TEMPLATE_COLUMNS in jobs.controller.js.
const BULK_COLUMNS = [
  ['serialNumber', 'S.No (Mandatory)'],
  ['industry', 'Industry (Mandatory)'],
  ['functionalAreas', 'Functional Area (Department) (Mandatory)'],
  ['title', 'Role / Job Title (Mandatory)'],
  ['collarCategory', 'Collar Category (Mandatory)'],
  ['description', 'Job Description (Mandatory)'],
  ['skills', 'Required Skills'],
  ['contactEmail', 'Contact Email (Mandatory)'],
  ['contactUsername', 'Contact Username'],
  ['salaryMin', 'Minimum Salary (Mandatory)'],
  ['salaryMax', 'Maximum Salary (Mandatory)'],
  ['salaryUnit', 'Salary Unit (Mandatory)'],
  ['experience', 'Experience (Mandatory)'],
  ['qualificationType', 'Qualification Type (Mandatory)'],
  ['qualification', 'Exact Degree (Mandatory)'],
  ['gender', 'Gender'],
  ['jobType', 'Job Type (Mandatory)'],
  ['careerLevel', 'Career Level (Mandatory)'],
  ['applicationDeadline', 'Application Deadline (Mandatory)'],
  ['positions', 'Number of Openings (Mandatory)'],
  ['maxApplicants', 'Max Applicants Allowed'],
  ['cities', 'Target Cities (Mandatory)'],
  ['country', 'Country (Mandatory)'],
  ['completeAddress', 'Office Address (HQ) (Mandatory)'],
  ['remoteWork', 'Work Arrangement'],
  ['jobStatus', 'Job Status'],
];

const bulkRow = (overrides = {}) => ({
  industry: 'Information Technology',
  functionalAreas: 'Software Development',
  title: 'Bulk Test Engineer',
  collarCategory: 'White Collar',
  description: 'Build and test things.',
  skills: '',
  contactEmail: 'hr@example.com',
  contactUsername: 'HR Team',
  salaryMin: '3',
  salaryMax: '6',
  salaryUnit: 'LPA',
  experience: '1-3 Years',
  qualificationType: 'ALL',
  qualification: 'BE CSE',
  gender: 'No Preference',
  jobType: 'Full-time',
  careerLevel: 'Mid Level',
  applicationDeadline: isoDate(inDays(30)),
  positions: '2',
  maxApplicants: '',
  cities: 'Coimbatore',
  country: 'India',
  completeAddress: 'Test address',
  remoteWork: 'On-site',
  jobStatus: 'Published',
  ...overrides,
});

const csvCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;

const bulkFile = (rows) => ({
  originalname: 'bulk-jobs.csv',
  buffer: Buffer.from(
    [
      BULK_COLUMNS.map(([, header]) => csvCell(header)).join(','),
      ...rows.map((row, index) =>
        BULK_COLUMNS.map(([key]) => csvCell(key === 'serialNumber' ? index + 1 : row[key])).join(',')
      ),
    ].join('\n')
  ),
});

const bulkUpload = (user, rows, body = {}) =>
  run(jobsController.bulkUploadJobPosts, { user, body, file: bulkFile(rows) });

test('bulk (employer): each saved live Published row sends one URL_UPDATED, after every row is persisted', async () => {
  const saved = stubJobCreation();
  const titles = ['Bulk Test Engineer A', 'Bulk Test Engineer B'];
  const { res, error } = await bulkUpload(employer, titles.map((title) => bulkRow({ title })));

  assert.equal(error, null);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.createdCount, 2);
  assert.deepEqual(saved.map((job) => job.status), ['Published', 'Published']);
  assert.deepEqual(
    google.map(({ url, type, source }) => ({ url, type, source })),
    titles.map((title) => ({ url: urlFor(title), type: 'URL_UPDATED', source: 'bulk-upload' }))
  );

  const lastSave = events.map((event, index) => (event.startsWith('db:save') ? index : -1)).reduce((a, b) => Math.max(a, b));
  assert.ok(lastSave < firstGoogleEvent(), 'Google is told only after every row has been written');
});

test('bulk (employer): Draft and Closed rows keep their Job Status and send no URL_UPDATED', async () => {
  const saved = stubJobCreation();
  const { res } = await bulkUpload(employer, [
    bulkRow({ title: 'Bulk Draft Engineer', jobStatus: 'Draft' }),
    bulkRow({ title: 'Bulk Closed Engineer', jobStatus: 'closed' }),
    bulkRow({ title: 'Bulk Default Engineer', jobStatus: '' }),
  ]);

  assert.equal(res.statusCode, 201);
  assert.deepEqual(saved.map((job) => job.status), ['Draft', 'Closed', 'Published']);
  assert.equal(saved[1].closedByRole, 'employer');
  assert.deepEqual(google.map(({ url, type }) => ({ url, type })), [
    { url: urlFor('Bulk Default Engineer'), type: 'URL_UPDATED' },
  ]);
});

test('bulk (employer): a Published row with a past deadline is saved but not announced', async () => {
  const saved = stubJobCreation();
  const { res } = await bulkUpload(employer, [
    bulkRow({ title: 'Bulk Expired Engineer', applicationDeadline: isoDate(inDays(-2)) }),
  ]);

  assert.equal(res.statusCode, 201);
  assert.equal(saved[0].status, 'Published');
  assert.equal(google.length, 0);
});

test('bulk: failed rows are never announced, and the response format is unchanged', async () => {
  stubJobCreation({ failSaveFor: ['Bulk Save Failure Engineer'] });
  const { res, error } = await bulkUpload(employer, [
    bulkRow({ title: 'Bulk Good Engineer' }),
    bulkRow({ title: 'Bulk Bad Email Engineer', contactEmail: 'not-an-email' }),
    bulkRow({ title: 'Bulk Save Failure Engineer' }),
    bulkRow({ title: 'Bulk Bad Status Engineer', jobStatus: 'Archived' }),
  ]);

  assert.equal(error, null);
  assert.equal(res.statusCode, 207);
  assert.deepEqual(Object.keys(res.body), [
    'success', 'partialSuccess', 'message', 'createdCount', 'failedCount', 'createdJobs', 'failedRows',
  ]);
  assert.equal(res.body.createdCount, 1);
  assert.equal(res.body.failedCount, 3);
  assert.deepEqual(Object.keys(res.body.createdJobs[0]), ['rowNumber', 'id', 'jobId', 'title']);
  assert.deepEqual(res.body.failedRows.map((row) => row.message), [
    'Please enter a valid contact email address',
    'simulated database write failure',
    'status must be one of: Draft, Published, Closed',
  ]);
  assert.deepEqual(google.map(({ url }) => url), [urlFor('Bulk Good Engineer')]);
});

test('bulk (admin): admin uploads are pending Drafts and are never announced', async () => {
  const saved = stubJobCreation();
  const { res } = await bulkUpload(
    superadmin,
    [bulkRow({ title: 'Bulk Admin Engineer A' }), bulkRow({ title: 'Bulk Admin Engineer B', jobStatus: 'Closed' })],
    { employerId: EMPLOYER_ID }
  );

  assert.equal(res.statusCode, 201);
  assert.deepEqual(saved.map((job) => [job.status, job.jobApprovalStatus]), [['Draft', 'pending'], ['Draft', 'pending']]);
  assert.equal(google.length, 0);
});

test('bulk: URL_UPDATED is capped per upload to protect the Indexing API quota', async () => {
  stubJobCreation();
  const rows = Array.from({ length: 101 }, (_, index) => bulkRow({ title: `Bulk Quota Engineer ${index + 1}` }));
  const { res } = await bulkUpload(employer, rows);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.createdCount, 101, 'every job is still created');
  assert.equal(notified('URL_UPDATED').length, 100);
  assert.ok(
    console.warn.mock.calls.some((call) => String(call.arguments[0]).includes('created 101 live job(s)')),
    'the skipped notifications are logged'
  );
});

// ===========================================================================
// C. Admin-post approval
// ===========================================================================

const adminPostedJob = (overrides = {}) => ({
  _id: JOB_ID,
  jobId: 'JOB-12345678',
  employer: EMPLOYER_ID,
  postedBy: ADMIN_ID,
  title: JOB_TITLE,
  slug: slugFor(JOB_TITLE),
  status: 'Draft',
  jobApprovalStatus: 'pending',
  applicationDeadline: inDays(30),
  ...overrides,
});

const respondToApproval = (job, action, { failUpdate = false } = {}) => {
  mock.method(JobPost, 'findById', () => query(job));
  mock.method(JobPost, 'findByIdAndUpdate', (jobId, update) => query(
    failUpdate ? DB_FAILURE() : { ...job, ...update.$set },
    () => events.push('db:update')
  ));
  return run(jobsController.respondToAdminPostedJob, { user: employer, params: { id: JOB_ID }, body: { action } });
};

test('approval: employer accepts -> Published, and exactly one URL_UPDATED after the update', async () => {
  const { res, error } = await respondToApproval(adminPostedJob(), 'accept');

  assert.equal(error, null);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.message, 'Job post approved and published successfully');
  assert.equal(res.body.jobPost.status, 'Published');
  assert.deepEqual(google, [{ url: JOB_URL, type: 'URL_UPDATED', source: 'approval', jobPost: JOB_ID }]);
  assert.deepEqual(events, ['db:update', 'google:URL_UPDATED']);
});

test('approval: accepting a job whose deadline has passed publishes it but does not announce it', async () => {
  const { res } = await respondToApproval(adminPostedJob({ applicationDeadline: inDays(-1) }), 'accept');

  assert.equal(res.body.jobPost.status, 'Published');
  assert.equal(google.length, 0);
});

test('approval: employer ignores -> Draft, and no URL_UPDATED (nor anything else for a never-public job)', async () => {
  const { res, error } = await respondToApproval(adminPostedJob(), 'ignore');

  assert.equal(error, null);
  assert.equal(res.body.message, 'Job post ignored successfully');
  assert.equal(res.body.jobPost.status, 'Draft');
  assert.equal(google.length, 0);
});

test('approval: ignoring a job an admin had already made live withdraws it instead', async () => {
  const { res } = await respondToApproval(adminPostedJob({ status: 'Published' }), 'ignore');

  assert.equal(res.body.jobPost.status, 'Draft');
  assert.equal(notified('URL_UPDATED').length, 0);
  assert.deepEqual(google.map(({ url, type, source }) => ({ url, type, source })), [
    { url: JOB_URL, type: 'URL_DELETED', source: 'approval' },
  ]);
});

test('approval: an already-answered request is rejected without an update or a second notification', async () => {
  const { error } = await respondToApproval(adminPostedJob({ jobApprovalStatus: 'accepted', status: 'Published' }), 'accept');

  assert.match(error?.message ?? '', /already been handled/);
  assert.equal(JobPost.findByIdAndUpdate.mock.callCount(), 0);
  assert.equal(google.length, 0);
});

test('approval: a failed database update sends nothing', async () => {
  const { error } = await respondToApproval(adminPostedJob(), 'accept', { failUpdate: true });

  assert.equal(error?.message, 'simulated database write failure');
  assert.equal(google.length, 0);
});

// ===========================================================================
// D. Existing lifecycle flows (regression)
// ===========================================================================

const existingJob = (overrides = {}) => ({
  _id: JOB_ID,
  jobId: 'JOB-12345678',
  employer: EMPLOYER_ID,
  postedBy: EMPLOYER_ID,
  title: JOB_TITLE,
  slug: slugFor(JOB_TITLE),
  status: 'Published',
  applicationDeadline: inDays(30),
  applicantCount: 0,
  ...overrides,
});

const updateJob = (job, body, { failUpdate = false } = {}) => {
  mock.method(JobPost, 'findById', () => query(job));
  mock.method(JobPost, 'findByIdAndUpdate', (jobId, update) => query(
    failUpdate ? DB_FAILURE() : { ...job, ...update.$set },
    () => events.push('db:update')
  ));
  return run(jobsController.updateJobPost, { user: employer, params: { id: JOB_ID }, body });
};

test('update: editing a live Published job sends one URL_UPDATED after the update', async () => {
  const { res } = await updateJob(existingJob(), { title: 'Senior Test Engineer' });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(google.map(({ url, type, source }) => ({ url, type, source })), [
    { url: JOB_URL, type: 'URL_UPDATED', source: 'update' },
  ]);
  assert.deepEqual(events, ['db:update', 'google:URL_UPDATED']);
});

test('update: Published -> Closed sends URL_DELETED and no URL_UPDATED', async () => {
  await updateJob(existingJob(), { status: 'Closed' });

  assert.deepEqual(google.map(({ type, source }) => ({ type, source })), [{ type: 'URL_DELETED', source: 'update' }]);
  assert.deepEqual(events, ['db:update', 'google:URL_DELETED']);
});

test('update: Closed -> Published sends URL_UPDATED', async () => {
  await updateJob(existingJob({ status: 'Closed' }), { status: 'Published' });

  assert.deepEqual(google.map(({ type }) => type), ['URL_UPDATED']);
});

test('update: Published -> Expired (deadline moved into the past) sends URL_DELETED', async () => {
  await updateJob(existingJob(), { applicationDeadline: inDays(-1).toISOString() });

  assert.deepEqual(google.map(({ type }) => type), ['URL_DELETED']);
});

test('update: Expired -> Published (deadline extended) sends URL_UPDATED', async () => {
  await updateJob(existingJob({ applicationDeadline: inDays(-1) }), { applicationDeadline: inDays(30).toISOString() });

  assert.deepEqual(google.map(({ type }) => type), ['URL_UPDATED']);
});

test('update: Expired -> Closed before the sweep still sends URL_DELETED', async () => {
  await updateJob(existingJob({ applicationDeadline: inDays(-1) }), { status: 'Closed' });

  assert.deepEqual(google.map(({ url, type }) => ({ url, type })), [{ url: JOB_URL, type: 'URL_DELETED' }]);
});

test('update: expired -> reopened -> expired again sends URL_UPDATED, then URL_DELETED again', async () => {
  let current = existingJob({ applicationDeadline: inDays(-1) });
  mock.method(JobPost, 'findById', () => query(current));
  mock.method(JobPost, 'findByIdAndUpdate', (jobId, update) => {
    const next = { ...current, ...update.$set };
    return query(next, () => {
      current = next;
      events.push('db:update');
    });
  });
  const edit = (body) => run(jobsController.updateJobPost, { user: employer, params: { id: JOB_ID }, body });

  await edit({ applicationDeadline: inDays(30).toISOString() });
  await edit({ applicationDeadline: inDays(-1).toISOString() });

  assert.deepEqual(google.map(({ type }) => type), ['URL_UPDATED', 'URL_DELETED']);
});

test('update: a Closed job whose withdrawal already stands sends nothing more', async () => {
  IndexingLog.find.mock.mockImplementation(() => query([
    { url: JOB_URL, type: 'URL_UPDATED', lastAttemptAt: inDays(-3), lastSuccessAt: inDays(-3) },
    { url: JOB_URL, type: 'URL_DELETED', lastAttemptAt: inDays(-1), lastSuccessAt: inDays(-1) },
  ]));

  await updateJob(existingJob({ status: 'Closed' }), { title: 'Renamed Test Engineer' });

  assert.equal(IndexingLog.find.mock.callCount(), 1, 'the audit trail was consulted');
  assert.equal(google.length, 0);
});

test('update: editing a Draft that was never public sends nothing', async () => {
  await updateJob(existingJob({ status: 'Draft' }), { title: 'Draft Test Engineer' });

  assert.equal(google.length, 0);
});

test('update: a failed database update sends nothing', async () => {
  const { error } = await updateJob(existingJob(), { status: 'Closed' }, { failUpdate: true });

  assert.equal(error?.message, 'simulated database write failure');
  assert.equal(google.length, 0);
});

const deleteJob = (job, { failDelete = false } = {}) => {
  mock.method(JobPost, 'findById', () => query(job));
  mock.method(JobPost, 'findByIdAndDelete', () => query(failDelete ? DB_FAILURE() : job, () => events.push('db:delete')));
  return run(jobsController.deleteJobPost, { user: superadmin, params: { id: JOB_ID } });
};

test('delete: a live Published job sends URL_DELETED after the delete', async () => {
  const { res } = await deleteJob(existingJob());

  assert.equal(res.statusCode, 200);
  assert.deepEqual(google.map(({ url, type, source }) => ({ url, type, source })), [
    { url: JOB_URL, type: 'URL_DELETED', source: 'delete' },
  ]);
  assert.deepEqual(events, ['db:delete', 'google:URL_DELETED']);
});

test('delete: an expired Published job the sweep has not withdrawn still sends URL_DELETED', async () => {
  await deleteJob(existingJob({ applicationDeadline: inDays(-1) }));

  assert.deepEqual(google.map(({ type }) => type), ['URL_DELETED']);
});

test('delete: a Draft that was never public sends nothing', async () => {
  await deleteJob(existingJob({ status: 'Draft' }));

  assert.equal(google.length, 0);
});

test('delete: a failed delete sends nothing', async () => {
  const { error } = await deleteJob(existingJob(), { failDelete: true });

  assert.equal(error?.message, 'simulated database write failure');
  assert.equal(google.length, 0);
});

/** A job document whose save() records the write (or fails on request). */
const jobDocument = (fields, { failSave = false } = {}) => ({
  ...existingJob(fields),
  positions: { total: 5, remaining: 5 },
  companyProfile: { companyName: 'Acme Tools' },
  async save() {
    if (failSave) throw DB_FAILURE();
    events.push('db:save');
    return this;
  },
});

// The first step after applyToJob's indexing hook is the admin-recipient lookup.
// Halting there keeps every email and push branch out of these tests.
const HALT = new Error('halted after the indexing hook');

const applyToJob = (job) => {
  mock.method(User, 'findById', () => query({
    _id: CANDIDATE_ID, role: 'candidate', name: 'Test Candidate', email: 'candidate@example.invalid',
  }));
  mock.method(JobPost, 'findById', () => query(job));
  mock.method(CandidateProfile, 'findOne', async () => ({
    _id: CANDIDATE_PROFILE_ID, status: 'approved', resume: 'https://files.example.invalid/resume.pdf', fullName: 'Test Candidate',
  }));
  mock.method(JobApply, 'findOne', async () => null);
  mock.method(JobApply.prototype, 'save', async function save() {
    events.push('db:application-save');
    return this;
  });
  mock.method(User, 'find', () => query(HALT));
  return run(candidateController.applyToJob, {
    user: candidate,
    params: { jobId: JOB_ID },
    body: { description: 'I would like to apply.' },
    files: {},
  });
};

test('auto-close: reaching the applicant limit closes the job and sends URL_DELETED after the save', async () => {
  const job = jobDocument({ applicantCount: 1, maxApplicants: 2 });
  const { error } = await applyToJob(job);

  assert.equal(error, HALT);
  assert.equal(job.status, 'Closed');
  assert.equal(job.closedByRole, 'system');
  assert.deepEqual(google.map(({ url, type, source }) => ({ url, type, source })), [
    { url: JOB_URL, type: 'URL_DELETED', source: 'auto-close' },
  ]);
  assert.deepEqual(events, ['db:application-save', 'db:save', 'google:URL_DELETED']);
});

test('auto-close: an application below the limit sends nothing', async () => {
  const job = jobDocument({ applicantCount: 1, maxApplicants: 5 });
  await applyToJob(job);

  assert.equal(job.status, 'Published');
  assert.equal(google.length, 0);
});

test('auto-close: a failed job save sends nothing', async () => {
  const { error } = await applyToJob(jobDocument({ applicantCount: 1, maxApplicants: 2 }, { failSave: true }));

  assert.equal(error?.message, 'simulated database write failure');
  assert.equal(google.length, 0);
});

const withdrawApplication = (job) => {
  mock.method(JobApply, 'findById', async () => ({
    _id: APPLICATION_ID,
    jobPost: JOB_ID,
    candidate: { equals: (value) => String(value) === CANDIDATE_ID },
    deleteOne: async () => {
      events.push('db:application-delete');
    },
  }));
  mock.method(JobPost, 'findById', async () => job);
  return run(candidateController.deleteAppliedJob, { user: candidate, params: { applicationId: APPLICATION_ID } });
};

test('auto-reopen: withdrawing from a Closed job reopens it and sends URL_UPDATED after the save', async () => {
  const job = jobDocument({ status: 'Closed', applicantCount: 2 });
  const { res } = await withdrawApplication(job);

  assert.equal(res.statusCode, 200);
  assert.equal(job.status, 'Published');
  assert.deepEqual(google.map(({ url, type, source }) => ({ url, type, source })), [
    { url: JOB_URL, type: 'URL_UPDATED', source: 'auto-reopen' },
  ]);
  assert.deepEqual(events, ['db:application-delete', 'db:save', 'google:URL_UPDATED']);
});

test('auto-reopen: a reopened job that is past its deadline is not announced', async () => {
  const job = jobDocument({ status: 'Closed', applicantCount: 2, applicationDeadline: inDays(-1) });
  await withdrawApplication(job);

  assert.equal(job.status, 'Published');
  assert.equal(google.length, 0);
});

test('candidate withdrawal: withdrawing from a job that is still open sends nothing', async () => {
  const job = jobDocument({ status: 'Published', applicantCount: 2 });
  const { res } = await withdrawApplication(job);

  assert.equal(res.statusCode, 200);
  assert.equal(google.length, 0);
});

test('auto-reopen: a failed job save sends nothing', async () => {
  const { error } = await withdrawApplication(jobDocument({ status: 'Closed', applicantCount: 2 }, { failSave: true }));

  assert.equal(error?.message, 'simulated database write failure');
  assert.equal(google.length, 0);
});

const deleteEmployerAccount = (jobs, { failJobDelete = false } = {}) => {
  const session = {
    startTransaction() {},
    async commitTransaction() {
      events.push('db:commit');
    },
    async abortTransaction() {
      events.push('db:abort');
    },
    endSession() {},
  };

  mock.method(mongoose, 'startSession', async () => session);
  mock.method(User, 'findById', () => query({
    _id: EMPLOYER_ID, role: 'employer', name: 'Acme Employer', email: 'employer@example.invalid',
  }));
  mock.method(JobPost, 'find', () => query(jobs));
  mock.method(CandidateProfile, 'find', () => query([]));
  mock.method(JobApply, 'find', () => query([]));
  for (const Model of [
    SavedCandidate, ResumeDownloadLog, Notification, ResumeAlert, CompanyProfile, SavedJob,
    JobApply, CandidateResume, CandidateCv, JobAlert, CandidateProfile,
  ]) {
    mock.method(Model, 'deleteMany', () => query({ deletedCount: 0 }));
  }
  mock.method(JobPost, 'deleteMany', () => query(
    failJobDelete ? DB_FAILURE() : { deletedCount: jobs.length },
    () => events.push('db:delete-jobs')
  ));
  mock.method(User, 'updateMany', () => query({ modifiedCount: 0 }));
  mock.method(User, 'deleteOne', () => query({ deletedCount: 1 }, () => events.push('db:delete-user')));

  return run(authController.deleteUserProfile, { user: superadmin, params: { id: EMPLOYER_ID } });
};

const accountJob = (title, overrides = {}) => ({
  _id: objectId(String(title.length).padStart(4, '0')),
  slug: slugFor(title),
  status: 'Published',
  applicationDeadline: inDays(30),
  ...overrides,
});

test('account deletion: previously public jobs are withdrawn only after the transaction commits', async () => {
  const live = accountJob('Live Account Role');
  const expired = accountJob('Expired Account Role Here', { applicationDeadline: inDays(-1) });
  const draft = accountJob('Draft Role', { status: 'Draft' });

  // The response itself is not asserted: after the notifications the handler
  // sends confirmation emails, which fail against the inert SMTP host.
  await deleteEmployerAccount([live, expired, draft]);

  assert.ok(events.includes('db:delete-jobs'));
  assert.ok(events.indexOf('db:commit') < firstGoogleEvent(), 'Google is told only after the commit');
  assert.deepEqual(
    google.map(({ url, type, source }) => ({ url, type, source })).sort((a, b) => a.url.localeCompare(b.url)),
    [
      { url: urlFor('Expired Account Role Here'), type: 'URL_DELETED', source: 'account-delete' },
      { url: urlFor('Live Account Role'), type: 'URL_DELETED', source: 'account-delete' },
    ]
  );
});

test('account deletion: a failed job delete aborts the transaction and tells Google nothing', async () => {
  const { error } = await deleteEmployerAccount([accountJob('Live Account Role')], { failJobDelete: true });

  assert.equal(error?.message, 'simulated database write failure');
  assert.ok(events.includes('db:abort'));
  assert.ok(!events.includes('db:commit'));
  assert.equal(google.length, 0);
});
