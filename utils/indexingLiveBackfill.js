// ---------------------------------------------------------------------------
// Live-job backfill for the Google Indexing API.
//
// The lifecycle hooks announce a job when it is created, edited, approved or
// reopened. A live job is never announced when it went live before the
// integration existed, or when its notification failed (credentials missing,
// quota, network). This backfill finds those jobs and sends URL_UPDATED for
// them — individual /job/{slug} pages only, the one page type Google's
// Indexing API accepts (JobPosting pages). Listing / keyword / filter URLs are
// never submitted; they are discovered through the sitemap and internal links.
//
// "Already announced" = a successful URL_UPDATED at or after the job's last
// update (IndexingLog). Those are skipped, so repeated runs cost no quota.
//
// Newest jobs first. `limit` caps one run below Google's default 200/day
// quota, which the lifecycle hooks and the expiry sweep share.
// ---------------------------------------------------------------------------
import JobPost from '../models/jobs.model.js';
import {
  buildCanonicalJobUrl,
  findIndexingLogs,
  isPubliclyIndexable,
  submitUrlUpdated,
} from './googleIndexing.js';
import { withOpenPositions } from './jobOpenPositions.js';

const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_MAX_SCAN = 5000;
export const MAX_BACKFILL_LIMIT = 150;

const toTime = (value) => {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
};

/** True when Google already accepted URL_UPDATED for the job's current version. */
export const isAnnouncementCurrent = (job, updatedLog) => {
  const announcedAt = toTime(updatedLog?.lastSuccessAt);
  if (announcedAt === null) return false;
  const changedAt = toTime(job?.updatedAt) ?? toTime(job?.createdAt) ?? 0;
  return announcedAt >= changedAt;
};

/** One page of live jobs, newest first (keyset pagination on updatedAt, _id). */
const findLiveJobsPage = ({ now, after, pageSize }) => {
  const filter = withOpenPositions({
    status: 'Published',
    applicationDeadline: { $gte: now },
    slug: { $exists: true, $nin: [null, ''] },
  });
  if (after) {
    filter.$or = [
      { updatedAt: { $lt: after.updatedAt } },
      { updatedAt: after.updatedAt, _id: { $lt: after._id } },
    ];
  }
  return JobPost.find(filter)
    .select('_id slug status applicationDeadline positions createdAt updatedAt')
    .sort({ updatedAt: -1, _id: -1 })
    .limit(pageSize)
    .lean();
};

/**
 * @param {Object}   [options]
 * @param {number}   [options.limit=100]    Max URL_UPDATED notifications this run.
 * @param {boolean}  [options.dryRun=false] Report what would be sent; send nothing.
 * @param {string[]} [options.excludeSlugs]  Job slugs never to submit (e.g. test jobs).
 * @returns {Promise<{scanned:number, alreadyAnnounced:number, notLive:number, submitted:number, succeeded:number, failed:number, skipped:number, pending:string[], results:Array}>}
 */
export const backfillLiveJobs = async ({
  limit = 100,
  dryRun = false,
  excludeSlugs = [],
  now = new Date(),
  logger = console,
  pageSize = DEFAULT_PAGE_SIZE,
  maxScan = DEFAULT_MAX_SCAN,
  findLivePage = findLiveJobsPage,
  findLogs = findIndexingLogs,
  submit = submitUrlUpdated,
} = {}) => {
  const cap = Math.max(0, Math.min(Number(limit) || 0, MAX_BACKFILL_LIMIT));
  const summary = {
    scanned: 0,
    alreadyAnnounced: 0,
    notLive: 0,
    excluded: 0,
    submitted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    pending: [],
    results: [],
  };

  const excluded = new Set(excludeSlugs.map(String));
  const pending = [];
  let after = null;

  while (pending.length < cap && summary.scanned < maxScan) {
    const requested = Math.min(pageSize, maxScan - summary.scanned);
    const page = await findLivePage({ now, after, pageSize: requested });
    if (!page.length) break;

    summary.scanned += page.length;
    after = page[page.length - 1];

    const entries = page.map((job) => ({ job, url: buildCanonicalJobUrl(job) }));
    const logs = await findLogs(entries.map((entry) => entry.url).filter(Boolean));

    for (const entry of entries) {
      if (pending.length >= cap) break;
      if (!entry.url) {
        summary.skipped += 1;
        continue;
      }
      // Same eligibility rule as every other URL_UPDATED path.
      if (!isPubliclyIndexable(entry.job, now)) {
        summary.notLive += 1;
        continue;
      }
      if (excluded.has(String(entry.job.slug))) {
        summary.excluded += 1;
        continue;
      }
      const { updatedLog = null } = logs.get(entry.url) || {};
      if (isAnnouncementCurrent(entry.job, updatedLog)) {
        summary.alreadyAnnounced += 1;
        continue;
      }
      pending.push(entry);
    }

    if (page.length < requested) break;
  }

  summary.pending = pending.map((entry) => entry.url);

  if (!dryRun) {
    // Sequential: a parallel burst only reaches the per-minute quota sooner.
    for (const { job, url } of pending) {
      const result = await submit(url, { jobPost: job._id, source: 'backfill' });
      summary.submitted += 1;
      if (result.status === 'success') summary.succeeded += 1;
      else if (result.status === 'failed') summary.failed += 1;
      else summary.skipped += 1;
      summary.results.push({ url, status: result.status, httpStatus: result.httpStatus ?? null });
    }
  }

  logger.log?.(
    `[INDEXING_BACKFILL] dryRun=${dryRun} scanned=${summary.scanned} alreadyAnnounced=${summary.alreadyAnnounced} ` +
    `notLive=${summary.notLive} excluded=${summary.excluded} pending=${pending.length} submitted=${summary.submitted} ` +
    `succeeded=${summary.succeeded} failed=${summary.failed} skipped=${summary.skipped}`
  );

  return summary;
};

export default backfillLiveJobs;
