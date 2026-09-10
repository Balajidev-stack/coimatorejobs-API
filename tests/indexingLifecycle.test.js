// tests/indexingLifecycle.test.js
// ---------------------------------------------------------------------------
// Unit suite for the lifecycle half of the Google Indexing integration:
// withdrawal decisions, the expiry sweep, and the manual reindex guard.
//
// Pure — no network, no database, no credentials. The sweep's page reader,
// audit-trail reader and submitter are injected; the reindex cases stub the
// JobPost lookup and are rejected before any submission is attempted.
// Run with: npm test
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';

import JobPost from '../models/jobs.model.js';
import indexingController from '../controller/indexing.controller.js';
import { isWithdrawalCurrent, shouldWithdrawJob } from '../utils/googleIndexing.js';
import { sweepExpiredJobs } from '../utils/indexingExpirySweep.js';

const SITE = 'https://coimbatorejobs.in';
// Read per call by the indexing module, so this pins every URL built below.
process.env.GOOGLE_INDEXING_SITE_URL = SITE;

const silentLogger = { log() {}, warn() {}, error() {} };
const at = (minute) => new Date(Date.UTC(2026, 0, 1, 0, minute));
const past = new Date(Date.now() - 86400000);
const future = new Date(Date.now() + 86400000);

// ===========================================================================
// 1. isWithdrawalCurrent
// ===========================================================================

test('withdrawal: nothing stands when no URL_DELETED ever succeeded', () => {
  assert.equal(isWithdrawalCurrent(null, null), false);
  assert.equal(isWithdrawalCurrent({ lastAttemptAt: at(1) }, null), false);
  // A failed-only URL_DELETED row has no success timestamp.
  assert.equal(isWithdrawalCurrent(null, { lastAttemptAt: at(2), lastSuccessAt: null }), false);
});

test('withdrawal: a success with no later URL_UPDATED attempt stands', () => {
  assert.equal(isWithdrawalCurrent(null, { lastSuccessAt: at(5) }), true);
  assert.equal(isWithdrawalCurrent({ lastAttemptAt: at(1) }, { lastSuccessAt: at(5) }), true);
});

test('withdrawal: a URL_UPDATED attempt after the withdrawal means the page came back', () => {
  assert.equal(isWithdrawalCurrent({ lastAttemptAt: at(9) }, { lastSuccessAt: at(5) }), false);
});

// ===========================================================================
// 2. shouldWithdrawJob
// ===========================================================================

const withSlug = (overrides) => ({ _id: 'job-1', slug: 'a-job-slug', ...overrides });

test('shouldWithdraw: no slug means no public URL, whatever else is true', () => {
  assert.equal(shouldWithdrawJob({ job: { status: 'Published' }, wasPubliclyIndexable: true }), false);
});

test('shouldWithdraw: a job live a moment ago is always withdrawn', () => {
  // Even with a standing withdrawal on record: its URL_UPDATED may be in flight.
  assert.equal(
    shouldWithdrawJob({
      job: withSlug({ status: 'Published', applicationDeadline: future }),
      wasPubliclyIndexable: true,
      deletedLog: { lastSuccessAt: at(5) },
    }),
    true
  );
});

test('shouldWithdraw: Published but expired, not yet swept -> withdrawn on close/delete', () => {
  assert.equal(
    shouldWithdrawJob({ job: withSlug({ status: 'Published', applicationDeadline: past }) }),
    true
  );
});

test('shouldWithdraw: Published but expired and already swept -> not sent twice', () => {
  assert.equal(
    shouldWithdrawJob({
      job: withSlug({ status: 'Published', applicationDeadline: past }),
      updatedLog: { lastAttemptAt: at(1) },
      deletedLog: { lastSuccessAt: at(5) },
    }),
    false
  );
});

test('shouldWithdraw: a Draft that was never announced is never withdrawn', () => {
  assert.equal(shouldWithdrawJob({ job: withSlug({ status: 'Draft' }) }), false);
});

test('shouldWithdraw: a Closed job Google was told about, never withdrawn -> withdrawn', () => {
  assert.equal(
    shouldWithdrawJob({ job: withSlug({ status: 'Closed' }), updatedLog: { lastAttemptAt: at(1) } }),
    true
  );
});

test('shouldWithdraw: a Closed job already withdrawn, or never announced -> not sent', () => {
  assert.equal(
    shouldWithdrawJob({
      job: withSlug({ status: 'Closed' }),
      updatedLog: { lastAttemptAt: at(1) },
      deletedLog: { lastSuccessAt: at(5) },
    }),
    false
  );
  assert.equal(shouldWithdrawJob({ job: withSlug({ status: 'Closed' }) }), false);
});

// ===========================================================================
// 3. Expiry sweep
// ===========================================================================

const expiredJob = (n) => ({
  _id: `id-${String(n).padStart(5, '0')}`,
  slug: `expired-job-${n}`,
  status: 'Published',
  applicationDeadline: past,
});
const urlOf = (job) => `${SITE}/job/${job.slug}`;

/**
 * In-memory stand-ins for Mongo and Google. `logs` is a live Map the submitter
 * can update, so multi-run scenarios see the audit trail their own runs wrote.
 */
const makeSweep = ({ jobs, logs = new Map(), outcomes = {}, onSubmit } = {}) => {
  const submitted = [];
  const pageCalls = [];

  const findExpiredPage = async ({ afterId, pageSize }) => {
    pageCalls.push({ afterId, pageSize });
    const start = afterId === null ? 0 : jobs.findIndex((job) => job._id === afterId) + 1;
    return jobs.slice(start, start + pageSize);
  };
  const findLogs = async (urls) =>
    new Map(urls.filter((url) => logs.has(url)).map((url) => [url, logs.get(url)]));
  const submit = async (url, options) => {
    submitted.push({ url, ...options });
    onSubmit?.(url);
    return outcomes[url] || { status: 'success', httpStatus: 200 };
  };

  const run = (options = {}) =>
    sweepExpiredJobs({ findExpiredPage, findLogs, submit, logger: silentLogger, ...options });

  return { run, submitted, pageCalls, logs };
};

test('sweep: a backlog of withdrawn jobs no longer hides newer expiries (stall regression)', async () => {
  const withdrawn = Array.from({ length: 60 }, (_, i) => expiredJob(i));
  const fresh = [expiredJob(1000), expiredJob(1001), expiredJob(1002)];
  const logs = new Map(withdrawn.map((job) => [urlOf(job), { updatedLog: null, deletedLog: { lastSuccessAt: at(5) } }]));

  const sweep = makeSweep({ jobs: [...withdrawn, ...fresh], logs });
  const summary = await sweep.run({ limit: 50, pageSize: 20 });

  assert.deepEqual(sweep.submitted.map((entry) => entry.url), fresh.map(urlOf));
  assert.equal(summary.alreadyWithdrawn, 60);
  assert.equal(summary.submitted, 3);
  assert.equal(summary.succeeded, 3);
});

test('sweep: expire -> withdraw -> reopen -> expire again sends URL_DELETED twice, never three times', async () => {
  const job = expiredJob(1);
  const url = urlOf(job);
  let clock = 0;
  const logs = new Map();
  const recordDeletion = (submittedUrl) => {
    const entry = logs.get(submittedUrl) || { updatedLog: null, deletedLog: null };
    entry.deletedLog = { lastSuccessAt: at(++clock) };
    logs.set(submittedUrl, entry);
  };
  const sweep = makeSweep({ jobs: [job], logs, onSubmit: recordDeletion });

  await sweep.run();                         // first expiry
  assert.equal(sweep.submitted.length, 1);

  await sweep.run();                         // still expired, already withdrawn
  assert.equal(sweep.submitted.length, 1);

  logs.get(url).updatedLog = { lastAttemptAt: at(++clock) }; // reopened: URL_UPDATED
  await sweep.run();                         // expired AGAIN
  assert.equal(sweep.submitted.length, 2);

  await sweep.run();                         // no new event
  assert.equal(sweep.submitted.length, 2);
  assert.ok(sweep.submitted.every((entry) => entry.source === 'expiry'));
});

test('sweep: stops reading pages once the batch limit is filled', async () => {
  const jobs = Array.from({ length: 120 }, (_, i) => expiredJob(i));
  const sweep = makeSweep({ jobs });
  const summary = await sweep.run({ limit: 50, pageSize: 200 });

  assert.equal(summary.submitted, 50);
  assert.equal(sweep.pageCalls.length, 1);
  assert.deepEqual(sweep.submitted.map((entry) => entry.url), jobs.slice(0, 50).map(urlOf));
});

test('sweep: maxScan bounds a run that finds nothing to submit', async () => {
  const jobs = Array.from({ length: 500 }, (_, i) => expiredJob(i));
  const logs = new Map(jobs.map((job) => [urlOf(job), { updatedLog: null, deletedLog: { lastSuccessAt: at(5) } }]));
  const sweep = makeSweep({ jobs, logs });
  const summary = await sweep.run({ pageSize: 40, maxScan: 100 });

  assert.equal(summary.scanned, 100);
  assert.deepEqual(sweep.pageCalls.map((call) => call.pageSize), [40, 40, 20]);
  assert.equal(summary.submitted, 0);
});

test('sweep: failures are counted, passed the job id, and retried on the next run', async () => {
  const [ok, quota] = [expiredJob(1), expiredJob(2)];
  const sweep = makeSweep({
    jobs: [ok, quota],
    outcomes: { [urlOf(quota)]: { status: 'failed', httpStatus: 429 } },
  });

  const first = await sweep.run();
  assert.equal(first.succeeded, 1);
  assert.equal(first.failed, 1);
  assert.equal(sweep.submitted[1].jobPost, quota._id);

  // A failure writes no success timestamp, so nothing stands and it is retried.
  await sweep.run();
  assert.equal(sweep.submitted.filter((entry) => entry.url === urlOf(quota)).length, 2);
});

test('sweep: an empty result submits nothing', async () => {
  const sweep = makeSweep({ jobs: [] });
  const summary = await sweep.run();
  assert.equal(summary.scanned, 0);
  assert.equal(sweep.submitted.length, 0);
});

// ===========================================================================
// 4. Manual reindex guard
// ===========================================================================

const JOB_ID = '64b7f0c2a1b2c3d4e5f60718';

/** Stubs JobPost.findById(...).select(...).lean() and runs reindexJob once. */
const runReindex = async (job, type) => {
  const original = JobPost.findById;
  JobPost.findById = () => ({ select: () => ({ lean: async () => job }) });
  try {
    let forwarded = null;
    const res = { status() { return this; }, json(body) { this.body = body; return this; } };
    await indexingController.reindexJob({ body: { jobId: JOB_ID, type } }, res, (error) => { forwarded = error; });
    return { error: forwarded, body: res.body };
  } finally {
    JobPost.findById = original;
  }
};

test('reindex: explicit URL_UPDATED for a non-live job is rejected before submission', async () => {
  for (const job of [
    { _id: JOB_ID, slug: 'a-job-slug', status: 'Draft', applicationDeadline: future },
    { _id: JOB_ID, slug: 'a-job-slug', status: 'Closed', applicationDeadline: future },
    { _id: JOB_ID, slug: 'a-job-slug', status: 'Published', applicationDeadline: past },
  ]) {
    const { error, body } = await runReindex(job, 'URL_UPDATED');
    assert.match(error?.message || '', /URL_UPDATED is not allowed/, `status=${job.status}`);
    assert.equal(body, undefined);
  }
});

test('reindex: explicit URL_DELETED for a live job is rejected before submission', async () => {
  const { error, body } = await runReindex(
    { _id: JOB_ID, slug: 'a-job-slug', status: 'Published', applicationDeadline: future },
    'URL_DELETED'
  );
  assert.match(error?.message || '', /URL_DELETED is not allowed/);
  assert.equal(body, undefined);
});
