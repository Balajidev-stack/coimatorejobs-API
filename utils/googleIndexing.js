// ---------------------------------------------------------------------------
// Google Indexing API integration.
//
// Notifies Google when a canonical JobPosting page appears, changes, or stops
// being publicly available. Google only accepts JobPosting and BroadcastEvent
// pages on this API, so ONLY /job/{slug} detail URLs are ever submitted —
// listing and SEO landing pages are rejected by validateJobUrl() before a
// request is built.
//
// Authentication is service-account OAuth2 (JWT -> access token) on the
// https://www.googleapis.com/auth/indexing scope. The Indexing API does not
// accept API keys at all, so GOOGLE_INDEXING_API_KEY is deliberately unused.
//
// Nothing in this module logs, returns, or persists the private key or the
// access token. The status endpoint reports credential PRESENCE only.
// ---------------------------------------------------------------------------
import { JWT } from 'google-auth-library';
import IndexingLog from '../models/indexingLog.model.js';
import { buildPublicJobUrl } from './jobSlug.js';

export const INDEXING_SCOPE = 'https://www.googleapis.com/auth/indexing';
export const PUBLISH_ENDPOINT = 'https://indexing.googleapis.com/v3/urlNotifications:publish';
export const METADATA_ENDPOINT = 'https://indexing.googleapis.com/v3/urlNotifications/metadata';

export const URL_UPDATED = 'URL_UPDATED';
export const URL_DELETED = 'URL_DELETED';

// Google's default per-project ceiling is 200 requests/day; retrying a
// rate-limited call more than a couple of times just burns quota.
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;
const MAX_RESPONSE_CHARS = 2000;

const DEFAULT_SITE_ORIGIN = 'https://coimbatorejobs.in';

// Only lowercase alphanumeric words joined by single hyphens. This is the shape
// buildJobSlugBase() produces, and it excludes anything carrying a slash, query
// string, or fragment.
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const truthy = (value) => ['true', '1', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());

/**
 * Reads indexing configuration from the environment on every call so a process
 * can be reconfigured (and tests can flip flags) without re-importing.
 *
 * Missing GOOGLE_INDEXING_DRY_RUN defaults to false, per the deployment
 * contract. Missing GOOGLE_INDEXING_ENABLED defaults to false so a partial
 * rollout never starts talking to Google by accident.
 */
export const readIndexingConfig = () => {
  const clientEmail = (process.env.GOOGLE_INDEXING_CLIENT_EMAIL || '').trim();
  const rawPrivateKey = process.env.GOOGLE_INDEXING_PRIVATE_KEY || '';
  const privateKey = rawPrivateKey.replace(/\\n/g, '\n').trim();
  const projectId = (process.env.GOOGLE_INDEXING_PROJECT_ID || '').trim();

  const siteOrigin = (() => {
    const raw = (process.env.GOOGLE_INDEXING_SITE_URL || process.env.FRONTEND_URL || DEFAULT_SITE_ORIGIN).trim();
    try {
      return new URL(raw).origin;
    } catch {
      return DEFAULT_SITE_ORIGIN;
    }
  })();

  return {
    enabled: truthy(process.env.GOOGLE_INDEXING_ENABLED),
    dryRun: truthy(process.env.GOOGLE_INDEXING_DRY_RUN),
    clientEmail,
    privateKey,
    projectId,
    siteOrigin,
  };
};

/** True only when both halves of the service-account credential are present. */
export const isIndexingConfigured = (config = readIndexingConfig()) =>
  Boolean(config.clientEmail && config.privateKey);

/**
 * Credential-safe view of the configuration for the diagnostics endpoint.
 * Booleans and the public site origin only — never a value from the key pair.
 */
export const describeIndexingConfig = (config = readIndexingConfig()) => ({
  enabled: config.enabled,
  dryRun: config.dryRun,
  configured: isIndexingConfigured(config),
  credentials: {
    clientEmail: config.clientEmail ? 'PRESENT' : 'MISSING',
    privateKey: config.privateKey ? 'PRESENT' : 'MISSING',
    projectId: config.projectId ? 'PRESENT' : 'MISSING',
  },
  siteOrigin: config.siteOrigin,
  scope: INDEXING_SCOPE,
});

/**
 * Guards every outbound submission. Returns { valid, reason }.
 *
 * Accepts exactly one shape: https://<site-origin>/job/<slug> with no query
 * string, no fragment, and no extra path segments. Everything else — the
 * homepage, /jobs-in-coimbatore, /jobs/industry/*, /jobs/location/*,
 * /jobs/role/*, /jobs/company/*, /jobs/job-type/*, /jobs/work-mode/*,
 * /job-list, and any off-site URL — is refused here.
 */
export const validateJobUrl = (rawUrl, config = readIndexingConfig()) => {
  const value = String(rawUrl ?? '').trim();
  if (!value) return { valid: false, reason: 'URL is empty' };

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { valid: false, reason: 'URL is not parseable' };
  }

  if (parsed.protocol !== 'https:') {
    return { valid: false, reason: 'URL must use https' };
  }
  if (parsed.origin !== config.siteOrigin) {
    return { valid: false, reason: `URL host must be ${config.siteOrigin}` };
  }
  if (parsed.search || parsed.hash) {
    return { valid: false, reason: 'URL must not carry a query string or fragment' };
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length !== 2 || segments[0] !== 'job') {
    return { valid: false, reason: 'Only canonical /job/{slug} detail pages may be submitted' };
  }
  if (!SLUG_PATTERN.test(segments[1])) {
    return { valid: false, reason: 'Job slug is not in canonical form' };
  }

  return { valid: true, reason: '' };
};

export const isValidJobUrl = (rawUrl, config) => validateJobUrl(rawUrl, config).valid;

/**
 * Canonical public URL for a job, or '' when the job has no slug yet.
 * Reuses buildPublicJobUrl() so the indexing integration can never drift from
 * the URL the notification emails and the sitemap already publish.
 */
export const buildCanonicalJobUrl = (job, config = readIndexingConfig()) => {
  const slug = String(job?.slug ?? '').trim();
  if (!slug) return '';
  return buildPublicJobUrl({ slug }, config.siteOrigin);
};

/**
 * Mirrors the eligibility rule getSitemapJobs() already uses: a job is a public
 * JobPosting page only while it is Published and its deadline has not passed.
 * Drafts and Closed jobs are not public pages and must never be submitted as
 * URL_UPDATED.
 */
export const isPubliclyIndexable = (job, now = new Date()) => {
  if (!job) return false;
  if (String(job.status) !== 'Published') return false;
  if (!String(job.slug ?? '').trim()) return false;
  const deadline = job.applicationDeadline ? new Date(job.applicationDeadline) : null;
  if (!deadline || Number.isNaN(deadline.getTime())) return false;
  return deadline.getTime() >= now.getTime();
};

const truncate = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (!text) return '';
  return text.length > MAX_RESPONSE_CHARS ? `${text.slice(0, MAX_RESPONSE_CHARS)}...[truncated]` : text;
};

/** 401/403/400 are configuration faults — retrying cannot fix them. */
const isRetryableStatus = (status) => status === 429 || (status >= 500 && status <= 599);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Mongo-backed audit trail. Every write is best-effort: a logging failure must
// never propagate into a job create/update/delete request.
const mongoLogStore = {
  async record({ url, type, status, httpStatus, googleResponse, errorMessage, jobPost, source, succeeded }) {
    try {
      const now = new Date();
      const update = {
        $set: {
          status,
          httpStatus: httpStatus ?? null,
          googleResponse: truncate(googleResponse),
          errorMessage: errorMessage || '',
          lastAttemptAt: now,
          source: source || 'unknown',
        },
        $inc: { attempts: 1 },
        $setOnInsert: { url, type, jobPost: jobPost || null },
      };
      if (succeeded) update.$set.lastSuccessAt = now;

      await IndexingLog.findOneAndUpdate({ url, type }, update, { upsert: true, new: true });
    } catch (error) {
      console.error(`[INDEXING_LOG] Failed to persist indexing log for ${type}: ${error.message}`);
    }
  },
};

/**
 * Builds an indexing service. Every external dependency is injectable so the
 * unit suite can exercise the full retry/status matrix without a network call
 * or a Mongo connection.
 */
export const createIndexingService = ({
  fetchImpl = globalThis.fetch,
  getAccessToken,
  logStore = mongoLogStore,
  logger = console,
  sleep = defaultSleep,
  maxAttempts = MAX_ATTEMPTS,
} = {}) => {
  let cachedClient = null;
  let cachedClientEmail = '';

  // Default token provider: signs a JWT with the service account key and
  // exchanges it for an access token. google-auth-library caches and refreshes
  // the token internally, so this stays cheap on the hot path.
  const defaultGetAccessToken = async (config) => {
    if (!cachedClient || cachedClientEmail !== config.clientEmail) {
      cachedClient = new JWT({
        email: config.clientEmail,
        key: config.privateKey,
        scopes: [INDEXING_SCOPE],
      });
      cachedClientEmail = config.clientEmail;
    }
    const { access_token: accessToken } = await cachedClient.authorize();
    if (!accessToken) throw new Error('Google returned no access token');
    return accessToken;
  };

  const resolveToken = getAccessToken || defaultGetAccessToken;

  // Audit writes must never sink a submission: the manual reindex endpoint
  // awaits this path, so a Mongo hiccup would otherwise 500 an operator request
  // for a notification Google already accepted.
  const safeRecord = async (entry) => {
    try {
      await logStore.record(entry);
    } catch (error) {
      logger.error?.(`[INDEXING] Failed to record indexing log: ${error.message}`);
    }
  };

  /**
   * Submits one notification. Never throws: returns a result object describing
   * what happened so callers can log it and move on.
   */
  const submitNotification = async (rawUrl, type, { jobPost = null, source = 'unknown' } = {}) => {
    const config = readIndexingConfig();

    if (![URL_UPDATED, URL_DELETED].includes(type)) {
      return { submitted: false, status: 'skipped', reason: `Unsupported notification type: ${type}` };
    }

    const validation = validateJobUrl(rawUrl, config);
    if (!validation.valid) {
      logger.warn?.(`[INDEXING] Refused to submit non-canonical URL (${validation.reason})`);
      return { submitted: false, status: 'skipped', reason: validation.reason };
    }

    const url = String(rawUrl).trim();

    if (!config.enabled) {
      return { submitted: false, status: 'skipped', reason: 'GOOGLE_INDEXING_ENABLED is not true' };
    }

    if (!isIndexingConfigured(config)) {
      logger.warn?.('[INDEXING] Skipped: service account credentials are not configured');
      await safeRecord({
        url, type, status: 'skipped', httpStatus: null, googleResponse: '',
        errorMessage: 'Service account credentials missing', jobPost, source, succeeded: false,
      });
      return { submitted: false, status: 'skipped', reason: 'Credentials missing' };
    }

    if (config.dryRun) {
      logger.log?.(`[INDEXING][DRY_RUN] Would submit ${type} for ${url}`);
      await safeRecord({
        url, type, status: 'dry-run', httpStatus: null,
        googleResponse: JSON.stringify({ url, type }), errorMessage: '',
        jobPost, source, succeeded: false,
      });
      return { submitted: false, status: 'dry-run', reason: 'Dry run enabled', payload: { url, type } };
    }

    let lastResult = { submitted: false, status: 'failed', reason: 'No attempt was made' };

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const accessToken = await resolveToken(config);
        const response = await fetchImpl(PUBLISH_ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ url, type }),
        });

        const httpStatus = response.status;
        let body = null;
        try {
          body = await response.json();
        } catch {
          body = null;
        }

        if (httpStatus === 200) {
          logger.log?.(`[INDEXING] ${type} accepted by Google for ${url}`);
          await safeRecord({
            url, type, status: 'success', httpStatus,
            googleResponse: JSON.stringify(body ?? {}), errorMessage: '',
            jobPost, source, succeeded: true,
          });
          return { submitted: true, status: 'success', httpStatus, response: body };
        }

        const googleMessage = body?.error?.message || `HTTP ${httpStatus}`;

        // Surface the two configuration faults loudly and distinctly — they are
        // the ones an operator must act on, and neither is retryable.
        if (httpStatus === 403) {
          logger.error?.(
            `[INDEXING] 403 from Google for ${url}: ${googleMessage} — ` +
            'Google Search Console ownership/permission required: add the service account as an Owner of the property.'
          );
        } else if (httpStatus === 401) {
          logger.error?.(
            `[INDEXING] 401 from Google for ${url}: ${googleMessage} — ` +
            'service account authentication failed; check GOOGLE_INDEXING_CLIENT_EMAIL / GOOGLE_INDEXING_PRIVATE_KEY.'
          );
        } else {
          logger.error?.(`[INDEXING] ${httpStatus} from Google for ${url}: ${googleMessage}`);
        }

        lastResult = {
          submitted: false,
          status: 'failed',
          httpStatus,
          response: body,
          reason: googleMessage,
          ownershipError: httpStatus === 403,
        };

        if (!isRetryableStatus(httpStatus) || attempt === maxAttempts) {
          await safeRecord({
            url, type, status: 'failed', httpStatus,
            googleResponse: JSON.stringify(body ?? {}), errorMessage: googleMessage,
            jobPost, source, succeeded: false,
          });
          return lastResult;
        }
      } catch (error) {
        // Transport-level failure (DNS, socket, token exchange). Retryable.
        logger.error?.(`[INDEXING] Transport error submitting ${type} for ${url}: ${error.message}`);
        lastResult = { submitted: false, status: 'failed', httpStatus: null, reason: error.message };

        if (attempt === maxAttempts) {
          await safeRecord({
            url, type, status: 'failed', httpStatus: null, googleResponse: '',
            errorMessage: error.message, jobPost, source, succeeded: false,
          });
          return lastResult;
        }
      }

      await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    }

    return lastResult;
  };

  const submitUrlUpdated = (url, options) => submitNotification(url, URL_UPDATED, options);
  const submitUrlDeleted = (url, options) => submitNotification(url, URL_DELETED, options);

  /** Read-only metadata lookup, used by diagnostics. Never throws. */
  const fetchNotificationMetadata = async (rawUrl) => {
    const config = readIndexingConfig();
    const validation = validateJobUrl(rawUrl, config);
    if (!validation.valid) return { ok: false, reason: validation.reason };
    if (!isIndexingConfigured(config)) return { ok: false, reason: 'Credentials missing' };

    try {
      const accessToken = await resolveToken(config);
      const response = await fetchImpl(
        `${METADATA_ENDPOINT}?url=${encodeURIComponent(String(rawUrl).trim())}`,
        { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } }
      );
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { ok: response.status === 200, httpStatus: response.status, response: body };
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  };

  return { submitNotification, submitUrlUpdated, submitUrlDeleted, fetchNotificationMetadata };
};

// Process-wide singleton used by the controllers.
const indexingService = createIndexingService();

export const submitUrlUpdated = (url, options) => indexingService.submitUrlUpdated(url, options);
export const submitUrlDeleted = (url, options) => indexingService.submitUrlDeleted(url, options);
export const fetchNotificationMetadata = (url) => indexingService.fetchNotificationMetadata(url);

/**
 * Fire-and-forget entry point for the job lifecycle hooks.
 *
 * Resolves the canonical URL from the job document itself (never from client
 * input), then submits without awaiting the network round trip, so a slow or
 * unavailable Google never delays a job create/update/delete response. Any
 * rejection is caught and logged; it can never surface to the API caller.
 */
export const notifyJobIndexing = (job, type, source = 'unknown') => {
  try {
    const url = buildCanonicalJobUrl(job);
    if (!url) return;

    void indexingService
      .submitNotification(url, type, { jobPost: job?._id ?? null, source })
      .catch((error) => {
        console.error(`[INDEXING] Unhandled indexing failure (${type}): ${error.message}`);
      });
  } catch (error) {
    console.error(`[INDEXING] Failed to queue ${type} notification: ${error.message}`);
  }
};

/** Convenience wrappers used by the job controller. */
export const notifyJobPublished = (job, source) => {
  if (isPubliclyIndexable(job)) notifyJobIndexing(job, URL_UPDATED, source);
};

export const notifyJobRemoved = (job, source) => {
  if (String(job?.slug ?? '').trim()) notifyJobIndexing(job, URL_DELETED, source);
};

// ---------------------------------------------------------------------------
// Withdrawal bookkeeping.
//
// A URL_DELETED is only worth sending while Google may still hold the URL. The
// IndexingLog rows answer that: URL_DELETED.lastSuccessAt is when Google was
// last told the page is gone, and URL_UPDATED.lastAttemptAt is when the page
// was last announced as live. Attempts count, not just successes: URL_UPDATED
// is only ever attempted while the job is a live page, so an attempt alone
// proves the page came back after any earlier withdrawal.
// ---------------------------------------------------------------------------

const toTime = (value) => {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
};

/**
 * True while a successful URL_DELETED still stands: Google was told the URL is
 * gone and the page has not been announced as live since. This is what lets a
 * job that expires, is reopened, and expires AGAIN receive a second URL_DELETED,
 * while a job that simply stays expired receives exactly one.
 */
export const isWithdrawalCurrent = (updatedLog, deletedLog) => {
  const withdrawnAt = toTime(deletedLog?.lastSuccessAt);
  if (withdrawnAt === null) return false;
  const republishedAt = toTime(updatedLog?.lastAttemptAt);
  return republishedAt === null || withdrawnAt >= republishedAt;
};

/**
 * Decides whether a job that is not (or no longer) a live page still needs a
 * URL_DELETED. `job` is the state BEFORE the change (closure, deletion, edit).
 *
 *   no slug                        -> never had a public URL
 *   was live a moment ago          -> yes, unconditionally
 *   a withdrawal already stands    -> no (prevents duplicates)
 *   still Published but expired    -> yes: the page is still served (noindex)
 *                                     and was listed while live, so Google may
 *                                     hold it even though the sweep has not run
 *   Draft / Closed                 -> only if Google was ever told it was live
 */
export const shouldWithdrawJob = ({ job, wasPubliclyIndexable = false, updatedLog = null, deletedLog = null } = {}) => {
  if (!String(job?.slug ?? '').trim()) return false;
  if (wasPubliclyIndexable) return true;
  if (isWithdrawalCurrent(updatedLog, deletedLog)) return false;
  if (String(job?.status) === 'Published') return true;
  return toTime(updatedLog?.lastAttemptAt) !== null;
};

/**
 * Loads the URL_UPDATED / URL_DELETED audit rows for a set of URLs in one query.
 * Returns Map<url, { updatedLog, deletedLog }>; URLs with no rows are absent.
 */
export const findIndexingLogs = async (urls = []) => {
  const unique = [...new Set(urls.filter(Boolean))];
  const byUrl = new Map();
  if (!unique.length) return byUrl;

  const rows = await IndexingLog.find({ url: { $in: unique }, type: { $in: [URL_UPDATED, URL_DELETED] } })
    .select('url type lastAttemptAt lastSuccessAt')
    .lean();

  for (const row of rows) {
    const entry = byUrl.get(row.url) || { updatedLog: null, deletedLog: null };
    if (row.type === URL_UPDATED) entry.updatedLog = row;
    else entry.deletedLog = row;
    byUrl.set(row.url, entry);
  }
  return byUrl;
};

/**
 * Fire-and-forget URL_DELETED for a job leaving public view: closure, deletion,
 * account removal. Unlike notifyJobRemoved() it also covers a job that had
 * ALREADY stopped being live (Published but past its deadline) before the
 * expiry sweep withdrew it, by consulting the audit trail. Never throws.
 *
 * @param {Object}  job     State BEFORE the change; needs _id, slug and status.
 * @param {string}  source  Recorded on the IndexingLog row.
 * @param {Object}  [options]
 * @param {boolean} [options.wasPubliclyIndexable] isPubliclyIndexable(job), captured before the change.
 */
export const notifyJobWithdrawal = (job, source = 'unknown', { wasPubliclyIndexable = false } = {}) => {
  try {
    const url = buildCanonicalJobUrl(job);
    if (!url) return;

    // Live until a moment ago: send without a lookup. The lookup would also be
    // unreliable here, since a URL_UPDATED for this page may still be in flight.
    if (wasPubliclyIndexable) {
      notifyJobRemoved(job, source);
      return;
    }

    // Nothing would be sent anyway; skip the audit-trail read.
    if (!readIndexingConfig().enabled) return;

    void findIndexingLogs([url])
      .then((logs) => {
        const { updatedLog = null, deletedLog = null } = logs.get(url) || {};
        if (!shouldWithdrawJob({ job, updatedLog, deletedLog })) return undefined;
        return indexingService.submitNotification(url, URL_DELETED, { jobPost: job?._id ?? null, source });
      })
      .catch((error) => {
        console.error(`[INDEXING] Withdrawal check failed (${source}): ${error.message}`);
      });
  } catch (error) {
    console.error(`[INDEXING] Failed to queue withdrawal (${source}): ${error.message}`);
  }
};

export default indexingService;
