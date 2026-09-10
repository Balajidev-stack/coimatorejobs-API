// ---------------------------------------------------------------------------
// Admin-facing controls for the Google Indexing API integration.
//
// Two endpoints: a manual re-index for a single job, and a read-only status
// panel. Neither ever accepts a URL from the client — the canonical URL is
// always derived from the job document — and neither ever returns a credential
// value, only a PRESENT/MISSING marker.
// ---------------------------------------------------------------------------
import mongoose from 'mongoose';

import JobPost from '../models/jobs.model.js';
import IndexingLog from '../models/indexingLog.model.js';
import { BadRequestError, NotFoundError } from '../utils/errors.js';
import {
  URL_UPDATED,
  URL_DELETED,
  buildCanonicalJobUrl,
  describeIndexingConfig,
  isPubliclyIndexable,
  submitUrlUpdated,
  submitUrlDeleted,
} from '../utils/googleIndexing.js';

const indexingController = {};

/**
 * POST /api/v1/indexing/reindex
 * Body: { jobId: "<ObjectId>", type?: "URL_UPDATED" | "URL_DELETED" }
 *
 * The client identifies a job; the server resolves the canonical URL from the
 * database. An arbitrary URL in the request body is ignored by construction —
 * there is no code path that reads one.
 *
 * When `type` is omitted the notification is inferred from the job's current
 * public state: a live Published job gets URL_UPDATED, anything else (Draft,
 * Closed, past deadline) gets URL_DELETED.
 *
 * Unlike the lifecycle hooks this one awaits the Google round trip, so the
 * operator triggering it sees the real HTTP status.
 */
indexingController.reindexJob = async (req, res, next) => {
  try {
    const { jobId, type } = req.body || {};

    if (!jobId || !mongoose.Types.ObjectId.isValid(String(jobId))) {
      throw new BadRequestError('A valid jobId is required');
    }
    if (type !== undefined && ![URL_UPDATED, URL_DELETED].includes(type)) {
      throw new BadRequestError(`type must be ${URL_UPDATED} or ${URL_DELETED}`);
    }

    const job = await JobPost.findById(jobId).select('slug status applicationDeadline title').lean();
    if (!job) {
      throw new NotFoundError('Job post not found');
    }

    const url = buildCanonicalJobUrl(job);
    if (!url) {
      throw new BadRequestError('This job has no canonical slug and cannot be submitted for indexing');
    }

    const isLive = isPubliclyIndexable(job);
    const resolvedType = type || (isLive ? URL_UPDATED : URL_DELETED);

    // An explicit type must agree with the page's real public state. Announcing
    // a Draft/Closed/expired page as updated, or a live page as deleted, would
    // mislead Google and spend quota on a notification it will contradict.
    if (type === URL_UPDATED && !isLive) {
      throw new BadRequestError('This job is not a live public page (Draft, Closed, or past its deadline); URL_UPDATED is not allowed');
    }
    if (type === URL_DELETED && isLive) {
      throw new BadRequestError('This job is still a live public page; URL_DELETED is not allowed');
    }

    const submit = resolvedType === URL_UPDATED ? submitUrlUpdated : submitUrlDeleted;

    const result = await submit(url, { jobPost: job._id, source: 'manual' });

    return res.status(200).json({
      success: result.status === 'success' || result.status === 'dry-run',
      url,
      type: resolvedType,
      status: result.status,
      httpStatus: result.httpStatus ?? null,
      googleResponse: result.response ?? null,
      reason: result.reason || '',
      // Make the one operator-actionable failure impossible to miss.
      ...(result.ownershipError
        ? { action: 'Google Search Console ownership/permission required for this property' }
        : {}),
      note:
        result.status === 'success'
          ? 'Google accepted the indexing notification. This is not confirmation that the page has been indexed.'
          : undefined,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/indexing/status
 *
 * Configuration flags, credential presence, the most recent attempt, and
 * aggregate counts. Returns no secret of any kind.
 */
indexingController.getIndexingStatus = async (req, res, next) => {
  try {
    const config = describeIndexingConfig();

    const [counts, lastAttempt, lastSuccess] = await Promise.all([
      IndexingLog.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      IndexingLog.findOne({}).sort({ lastAttemptAt: -1 }).select('url type status httpStatus lastAttemptAt errorMessage').lean(),
      IndexingLog.findOne({ lastSuccessAt: { $ne: null } }).sort({ lastSuccessAt: -1 }).select('url type lastSuccessAt').lean(),
    ]);

    const statistics = counts.reduce(
      (acc, row) => ({ ...acc, [row._id]: row.count }),
      { success: 0, failed: 0, skipped: 0, 'dry-run': 0, pending: 0 }
    );

    return res.status(200).json({
      success: true,
      indexing: config,
      statistics: {
        ...statistics,
        total: Object.values(statistics).reduce((sum, n) => sum + n, 0),
      },
      lastAttempt: lastAttempt || null,
      lastSuccess: lastSuccess || null,
    });
  } catch (error) {
    next(error);
  }
};

export default indexingController;
