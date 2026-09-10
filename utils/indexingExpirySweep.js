// ---------------------------------------------------------------------------
// Expiry sweep for the Google Indexing API.
//
// The backend has no in-process scheduler (no cron, node-schedule, agenda, or
// setInterval anywhere in the codebase), and inventing one inside the web
// process would put a background timer in every Render instance. So expiry is
// exposed as a plain async function driven by an external trigger:
// `npm run indexing:sweep-expired`, run from a Render Cron Job or any host
// scheduler.
//
// A job "expires" silently — its applicationDeadline simply passes, with no
// write to the document — so nothing in the request path can notice it. This
// sweep is what turns that silent transition into a URL_DELETED notification.
//
// Two properties matter for correctness:
//
//   * Already-withdrawn jobs are excluded BEFORE they count toward the batch
//     limit. The sweep never rewrites a job, so withdrawn jobs stay Published
//     with a past deadline forever; filtering them after the limit let a
//     backlog of them permanently hide newer expiries.
//
//   * "Already withdrawn" means a URL_DELETED success that is newer than the
//     last URL_UPDATED attempt (isWithdrawalCurrent). A job that expires, is
//     reopened, and expires again is therefore withdrawn a second time.
// ---------------------------------------------------------------------------
import JobPost from '../models/jobs.model.js';
import {
  buildCanonicalJobUrl,
  findIndexingLogs,
  isWithdrawalCurrent,
  submitUrlDeleted,
} from './googleIndexing.js';

// Rows read per page while looking for jobs that still need withdrawing.
const DEFAULT_PAGE_SIZE = 200;

// Ceiling on rows inspected in one run, so a large backlog of long-withdrawn
// jobs cannot turn a single run into an unbounded collection scan.
const DEFAULT_MAX_SCAN = 5000;

/** One page of still-Published, past-deadline jobs with a slug, in _id order. */
const findExpiredJobsPage = ({ now, afterId, pageSize }) =>
  JobPost.find({
    status: 'Published',
    applicationDeadline: { $lt: now },
    slug: { $exists: true, $nin: [null, ''], $regex: /\S/ },
    ...(afterId ? { _id: { $gt: afterId } } : {}),
  })
    .select('_id slug status applicationDeadline')
    .sort({ _id: 1 })
    .limit(pageSize)
    .lean();

/**
 * Finds jobs whose deadline has passed and withdraws their canonical URLs from
 * Google, skipping any URL whose withdrawal still stands.
 *
 * @param {Object}   [options]
 * @param {number}   [options.limit=50]       Max URLs submitted per run — keeps a
 *                                            single run well inside Google's
 *                                            200/day quota.
 * @param {Date}     [options.now]            Injectable clock for tests.
 * @param {Object}   [options.logger]
 * @param {number}   [options.pageSize=200]   Rows read per page.
 * @param {number}   [options.maxScan=5000]   Max rows inspected per run.
 * @param {Function} [options.findExpiredPage] Injectable page reader (tests).
 * @param {Function} [options.findLogs]        Injectable audit-trail reader (tests).
 * @param {Function} [options.submit]          Injectable URL_DELETED submitter (tests).
 * @returns {Promise<{scanned:number, alreadyWithdrawn:number, submitted:number, succeeded:number, failed:number, skipped:number, results:Array}>}
 */
export const sweepExpiredJobs = async ({
  limit = 50,
  now = new Date(),
  logger = console,
  pageSize = DEFAULT_PAGE_SIZE,
  maxScan = DEFAULT_MAX_SCAN,
  findExpiredPage = findExpiredJobsPage,
  findLogs = findIndexingLogs,
  submit = submitUrlDeleted,
} = {}) => {
  const summary = {
    scanned: 0,
    alreadyWithdrawn: 0,
    submitted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    results: [],
  };

  // Phase 1: collect up to `limit` jobs that genuinely still need URL_DELETED.
  const pending = [];
  let afterId = null;

  while (pending.length < limit && summary.scanned < maxScan) {
    const requested = Math.min(pageSize, maxScan - summary.scanned);
    const page = await findExpiredPage({ now, afterId, pageSize: requested });
    if (!page.length) break;

    summary.scanned += page.length;
    afterId = page[page.length - 1]._id;

    const entries = page.map((job) => ({ job, url: buildCanonicalJobUrl(job) }));
    // One audit-trail query per page instead of one per job.
    const logs = await findLogs(entries.map((entry) => entry.url).filter(Boolean));

    for (const entry of entries) {
      if (pending.length >= limit) break;

      if (!entry.url) {
        summary.skipped += 1;
        continue;
      }

      const { updatedLog = null, deletedLog = null } = logs.get(entry.url) || {};
      if (isWithdrawalCurrent(updatedLog, deletedLog)) {
        summary.alreadyWithdrawn += 1;
        summary.skipped += 1;
        continue;
      }

      pending.push(entry);
    }

    if (page.length < requested) break;
  }

  // Phase 2: submit sequentially — a burst of parallel requests would only hit
  // Google's per-minute quota sooner.
  for (const { job, url } of pending) {
    const result = await submit(url, { jobPost: job._id, source: 'expiry' });
    summary.submitted += 1;
    if (result.status === 'success') summary.succeeded += 1;
    else if (result.status === 'failed') summary.failed += 1;
    else summary.skipped += 1;

    summary.results.push({ url, status: result.status, httpStatus: result.httpStatus ?? null });
  }

  logger.log?.(
    `[INDEXING_SWEEP] scanned=${summary.scanned} alreadyWithdrawn=${summary.alreadyWithdrawn} ` +
    `submitted=${summary.submitted} succeeded=${summary.succeeded} failed=${summary.failed} skipped=${summary.skipped}`
  );

  return summary;
};

export default sweepExpiredJobs;
