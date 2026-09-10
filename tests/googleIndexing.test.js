// tests/googleIndexing.test.js
// ---------------------------------------------------------------------------
// Unit suite for the Google Indexing API integration. Pure — no network, no
// database, no credentials. Every Google call is mocked, and the token
// provider is injected, so the suite never signs a JWT or reaches googleapis.
// Run with: npm test
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  URL_UPDATED,
  URL_DELETED,
  createIndexingService,
  validateJobUrl,
  isValidJobUrl,
  buildCanonicalJobUrl,
  isPubliclyIndexable,
  describeIndexingConfig,
  readIndexingConfig,
} from '../utils/googleIndexing.js';

// ===========================================================================
// Harness
// ===========================================================================

const SITE = 'https://coimbatorejobs.in';
const JOB_URL = `${SITE}/job/video-editor-jobs-in-coimbatore-mec-groups`;

/** Applies a known environment for one test, then restores it. */
const withEnv = (overrides, fn) => {
  const keys = [
    'GOOGLE_INDEXING_ENABLED',
    'GOOGLE_INDEXING_DRY_RUN',
    'GOOGLE_INDEXING_CLIENT_EMAIL',
    'GOOGLE_INDEXING_PRIVATE_KEY',
    'GOOGLE_INDEXING_PROJECT_ID',
    'GOOGLE_INDEXING_SITE_URL',
    'FRONTEND_URL',
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));

  const applied = {
    GOOGLE_INDEXING_ENABLED: 'true',
    GOOGLE_INDEXING_DRY_RUN: 'false',
    GOOGLE_INDEXING_CLIENT_EMAIL: 'test-sa@example.iam.gserviceaccount.com',
    GOOGLE_INDEXING_PRIVATE_KEY: 'test-private-key-material',
    GOOGLE_INDEXING_PROJECT_ID: 'test-project',
    GOOGLE_INDEXING_SITE_URL: SITE,
    ...overrides,
  };

  for (const key of keys) {
    if (applied[key] === undefined) delete process.env[key];
    else process.env[key] = applied[key];
  }

  try {
    return fn();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
};

/** Records every write the service attempts, in place of Mongo. */
const makeLogStore = () => {
  const records = [];
  return { records, record: async (entry) => { records.push(entry); } };
};

/** Mock fetch that replays a queued list of responses and captures requests. */
const makeFetch = (responses) => {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return {
      status: next.status,
      json: async () => {
        if (next.body === undefined) throw new Error('no body');
        return next.body;
      },
    };
  };
  return { fetchImpl, calls };
};

const silentLogger = { log() {}, warn() {}, error() {} };

/** Service wired to mocks: no real token, no real network, no real Mongo. */
const makeService = (responses, extra = {}) => {
  const logStore = makeLogStore();
  const { fetchImpl, calls } = makeFetch(responses);
  const service = createIndexingService({
    fetchImpl,
    getAccessToken: async () => 'fake-access-token',
    logStore,
    logger: silentLogger,
    sleep: async () => {}, // collapse retry backoff
    ...extra,
  });
  return { service, calls, logStore };
};

const OK = { status: 200, body: { urlNotificationMetadata: { url: JOB_URL } } };

// ===========================================================================
// 1. URL validation
// ===========================================================================

test('url validation: accepts a canonical /job/{slug} URL', () => {
  withEnv({}, () => {
    assert.equal(validateJobUrl(JOB_URL).valid, true);
  });
});

test('url validation: rejects the homepage and every SEO landing pattern', () => {
  withEnv({}, () => {
    const rejected = [
      `${SITE}/`,
      SITE,
      `${SITE}/jobs-in-coimbatore`,
      `${SITE}/jobs/industry/it-software`,
      `${SITE}/jobs/location/coimbatore`,
      `${SITE}/jobs/role/video-editor`,
      `${SITE}/jobs/company/mec-groups`,
      `${SITE}/jobs/job-type/full-time`,
      `${SITE}/jobs/work-mode/remote`,
      `${SITE}/job-list`,
    ];
    for (const url of rejected) {
      assert.equal(isValidJobUrl(url), false, `should reject ${url}`);
    }
  });
});

test('url validation: rejects off-site hosts, http, queries, fragments, and junk', () => {
  withEnv({}, () => {
    assert.equal(isValidJobUrl('https://evil.example.com/job/some-slug'), false);
    assert.equal(isValidJobUrl('http://coimbatorejobs.in/job/some-slug'), false);
    assert.equal(isValidJobUrl(`${JOB_URL}?utm_source=x`), false);
    assert.equal(isValidJobUrl(`${JOB_URL}#apply`), false);
    assert.equal(isValidJobUrl(`${SITE}/job/some-slug/extra`), false);
    assert.equal(isValidJobUrl(`${SITE}/job/Not_A_Slug`), false);
    assert.equal(isValidJobUrl(''), false);
    assert.equal(isValidJobUrl(null), false);
    assert.equal(isValidJobUrl('not-a-url'), false);
  });
});

test('url validation: canonical URL is built from the job slug, blank without one', () => {
  withEnv({}, () => {
    assert.equal(
      buildCanonicalJobUrl({ slug: 'video-editor-jobs-in-coimbatore-mec-groups' }),
      JOB_URL
    );
    assert.equal(buildCanonicalJobUrl({ slug: '' }), '');
    assert.equal(buildCanonicalJobUrl({}), '');
    assert.equal(buildCanonicalJobUrl(null), '');
  });
});

test('url validation: public eligibility follows the sitemap rule', () => {
  const future = new Date(Date.now() + 86400000);
  const past = new Date(Date.now() - 86400000);
  const base = { slug: 'a-job-slug', status: 'Published', applicationDeadline: future };

  assert.equal(isPubliclyIndexable(base), true);
  assert.equal(isPubliclyIndexable({ ...base, status: 'Draft' }), false);
  assert.equal(isPubliclyIndexable({ ...base, status: 'Closed' }), false);
  assert.equal(isPubliclyIndexable({ ...base, applicationDeadline: past }), false);
  assert.equal(isPubliclyIndexable({ ...base, slug: '' }), false);
  assert.equal(isPubliclyIndexable({ ...base, applicationDeadline: null }), false);
  assert.equal(isPubliclyIndexable(null), false);
});

// ===========================================================================
// 2 & 3. Payloads
// ===========================================================================

test('payload: URL_UPDATED posts the exact documented body to the publish endpoint', async () => {
  await withEnv({}, async () => {
    const { service, calls } = makeService([OK]);
    const result = await service.submitUrlUpdated(JOB_URL);

    assert.equal(result.status, 'success');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://indexing.googleapis.com/v3/urlNotifications:publish');
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(calls[0].body, { url: JOB_URL, type: 'URL_UPDATED' });
    assert.equal(calls[0].init.headers.Authorization, 'Bearer fake-access-token');
    assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  });
});

test('payload: URL_DELETED posts type URL_DELETED', async () => {
  await withEnv({}, async () => {
    const { service, calls } = makeService([OK]);
    const result = await service.submitUrlDeleted(JOB_URL);

    assert.equal(result.status, 'success');
    assert.deepEqual(calls[0].body, { url: JOB_URL, type: 'URL_DELETED' });
  });
});

test('payload: a non-canonical URL never reaches Google', async () => {
  await withEnv({}, async () => {
    const { service, calls } = makeService([OK]);
    const result = await service.submitUrlUpdated(`${SITE}/jobs-in-coimbatore`);

    assert.equal(result.status, 'skipped');
    assert.equal(calls.length, 0);
  });
});

test('payload: an unsupported notification type is refused', async () => {
  await withEnv({}, async () => {
    const { service, calls } = makeService([OK]);
    const result = await service.submitNotification(JOB_URL, 'URL_SOMETHING');

    assert.equal(result.status, 'skipped');
    assert.equal(calls.length, 0);
  });
});

// ===========================================================================
// 4 & 5. Dry run and disabled
// ===========================================================================

test('dry run: logs the intended payload and makes no request', async () => {
  await withEnv({ GOOGLE_INDEXING_DRY_RUN: 'true' }, async () => {
    const { service, calls, logStore } = makeService([OK]);
    const result = await service.submitUrlUpdated(JOB_URL);

    assert.equal(result.status, 'dry-run');
    assert.deepEqual(result.payload, { url: JOB_URL, type: URL_UPDATED });
    assert.equal(calls.length, 0);
    assert.equal(logStore.records.length, 1);
    assert.equal(logStore.records[0].status, 'dry-run');
  });
});

test('dry run: defaults to false when the variable is absent', async () => {
  await withEnv({ GOOGLE_INDEXING_DRY_RUN: undefined }, async () => {
    assert.equal(readIndexingConfig().dryRun, false);
    const { service, calls } = makeService([OK]);
    assert.equal((await service.submitUrlUpdated(JOB_URL)).status, 'success');
    assert.equal(calls.length, 1);
  });
});

test('disabled: enabled=false makes no request at all', async () => {
  await withEnv({ GOOGLE_INDEXING_ENABLED: 'false' }, async () => {
    const { service, calls } = makeService([OK]);
    const result = await service.submitUrlUpdated(JOB_URL);

    assert.equal(result.status, 'skipped');
    assert.equal(calls.length, 0);
  });
});

test('disabled: a missing ENABLED flag is treated as disabled', async () => {
  await withEnv({ GOOGLE_INDEXING_ENABLED: undefined }, async () => {
    const { service, calls } = makeService([OK]);
    assert.equal((await service.submitUrlUpdated(JOB_URL)).status, 'skipped');
    assert.equal(calls.length, 0);
  });
});

test('disabled: missing credentials skip instead of throwing', async () => {
  await withEnv({ GOOGLE_INDEXING_PRIVATE_KEY: undefined }, async () => {
    const { service, calls } = makeService([OK]);
    const result = await service.submitUrlUpdated(JOB_URL);

    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'Credentials missing');
    assert.equal(calls.length, 0);
  });
});

// ===========================================================================
// 6. OAuth configuration
// ===========================================================================

test('oauth: config reports presence only and never a credential value', () => {
  withEnv({}, () => {
    const described = describeIndexingConfig();

    assert.equal(described.scope, 'https://www.googleapis.com/auth/indexing');
    assert.equal(described.enabled, true);
    assert.equal(described.configured, true);
    assert.equal(described.credentials.clientEmail, 'PRESENT');
    assert.equal(described.credentials.privateKey, 'PRESENT');
    assert.equal(described.credentials.projectId, 'PRESENT');

    const serialized = JSON.stringify(described);
    assert.equal(serialized.includes('test-private-key-material'), false);
    assert.equal(serialized.includes('test-sa@example.iam.gserviceaccount.com'), false);
  });
});

test('oauth: escaped newlines in the private key are restored', () => {
  withEnv({ GOOGLE_INDEXING_PRIVATE_KEY: 'line-one\\nline-two' }, () => {
    assert.equal(readIndexingConfig().privateKey, 'line-one\nline-two');
  });
});

test('oauth: missing credentials report MISSING', () => {
  withEnv({ GOOGLE_INDEXING_CLIENT_EMAIL: undefined, GOOGLE_INDEXING_PRIVATE_KEY: undefined }, () => {
    const described = describeIndexingConfig();
    assert.equal(described.configured, false);
    assert.equal(described.credentials.clientEmail, 'MISSING');
    assert.equal(described.credentials.privateKey, 'MISSING');
  });
});

// ===========================================================================
// 7-11. Google response handling
// ===========================================================================

test('google 200: recorded as success with a success timestamp', async () => {
  await withEnv({}, async () => {
    const { service, logStore } = makeService([OK]);
    const result = await service.submitUrlUpdated(JOB_URL, { source: 'create' });

    assert.equal(result.submitted, true);
    assert.equal(result.httpStatus, 200);
    assert.equal(logStore.records[0].status, 'success');
    assert.equal(logStore.records[0].succeeded, true);
    assert.equal(logStore.records[0].source, 'create');
  });
});

test('google 401: fails immediately without retrying', async () => {
  await withEnv({}, async () => {
    const { service, calls } = makeService([
      { status: 401, body: { error: { code: 401, message: 'Invalid credentials' } } },
    ]);
    const result = await service.submitUrlUpdated(JOB_URL);

    assert.equal(result.status, 'failed');
    assert.equal(result.httpStatus, 401);
    assert.equal(calls.length, 1, '401 must not be retried');
  });
});

test('google 403: flagged as an ownership error and not retried', async () => {
  await withEnv({}, async () => {
    const { service, calls, logStore } = makeService([
      {
        status: 403,
        body: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Permission denied. Failed to verify the URL ownership.' } },
      },
    ]);
    const result = await service.submitUrlUpdated(JOB_URL);

    assert.equal(result.status, 'failed');
    assert.equal(result.httpStatus, 403);
    assert.equal(result.ownershipError, true);
    assert.equal(calls.length, 1, '403 must not be retried');
    assert.match(logStore.records[0].errorMessage, /ownership/i);
  });
});

test('google 429: retried up to the attempt ceiling, then reported failed', async () => {
  await withEnv({}, async () => {
    const { service, calls } = makeService([
      { status: 429, body: { error: { code: 429, message: 'Quota exceeded' } } },
    ]);
    const result = await service.submitUrlUpdated(JOB_URL);

    assert.equal(result.status, 'failed');
    assert.equal(result.httpStatus, 429);
    assert.equal(calls.length, 3, '429 is retryable and should exhaust all 3 attempts');
  });
});

test('google 5xx: retried, and a later success is reported as success', async () => {
  await withEnv({}, async () => {
    const { service, calls } = makeService([
      { status: 503, body: { error: { code: 503, message: 'Service unavailable' } } },
      OK,
    ]);
    const result = await service.submitUrlUpdated(JOB_URL);

    assert.equal(result.status, 'success');
    assert.equal(calls.length, 2, 'should have retried once then succeeded');
  });
});

test('google 5xx: gives up after the attempt ceiling', async () => {
  await withEnv({}, async () => {
    const { service, calls } = makeService([
      { status: 500, body: { error: { code: 500, message: 'Internal error' } } },
    ]);
    const result = await service.submitUrlUpdated(JOB_URL);

    assert.equal(result.status, 'failed');
    assert.equal(calls.length, 3);
  });
});

test('google transport error: caught, retried, and reported without throwing', async () => {
  await withEnv({}, async () => {
    const { service, calls } = makeService([new Error('socket hang up')]);
    const result = await service.submitUrlUpdated(JOB_URL);

    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'socket hang up');
    assert.equal(calls.length, 3);
  });
});

test('google: a failing token exchange never throws out of the service', async () => {
  await withEnv({}, async () => {
    const logStore = makeLogStore();
    const service = createIndexingService({
      fetchImpl: async () => { throw new Error('fetch should not be reached'); },
      getAccessToken: async () => { throw new Error('invalid_grant'); },
      logStore,
      logger: silentLogger,
      sleep: async () => {},
    });

    const result = await service.submitUrlUpdated(JOB_URL);
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'invalid_grant');
  });
});

// ===========================================================================
// 12-14. Indexing failure must never break the job lifecycle
// ===========================================================================

// Mirrors the controller hooks: build the URL from the job, submit, swallow.
// If submitNotification() ever rejected instead of resolving, these would fail.
const runLifecycleHook = async (service, job, type) => {
  const url = buildCanonicalJobUrl(job);
  const outcome = { hookCompleted: false, indexing: null };
  await service.submitNotification(url, type, { jobPost: job._id, source: 'test' })
    .then((res) => { outcome.indexing = res; });
  outcome.hookCompleted = true;
  return outcome;
};

const liveJob = {
  _id: 'job-1',
  slug: 'video-editor-jobs-in-coimbatore-mec-groups',
  status: 'Published',
  applicationDeadline: new Date(Date.now() + 86400000),
};

test('lifecycle: a 403 during job creation does not break the create flow', async () => {
  await withEnv({}, async () => {
    const { service } = makeService([
      { status: 403, body: { error: { code: 403, message: 'Permission denied. Failed to verify the URL ownership.' } } },
    ]);
    const outcome = await runLifecycleHook(service, liveJob, URL_UPDATED);

    assert.equal(outcome.hookCompleted, true, 'job creation must still complete');
    assert.equal(outcome.indexing.status, 'failed');
  });
});

test('lifecycle: a 500 during job update does not break the update flow', async () => {
  await withEnv({}, async () => {
    const { service } = makeService([{ status: 500, body: { error: { message: 'boom' } } }]);
    const outcome = await runLifecycleHook(service, liveJob, URL_UPDATED);

    assert.equal(outcome.hookCompleted, true, 'job update must still complete');
    assert.equal(outcome.indexing.status, 'failed');
  });
});

test('lifecycle: a transport failure during job deletion does not break the delete flow', async () => {
  await withEnv({}, async () => {
    const { service } = makeService([new Error('ECONNREFUSED')]);
    const outcome = await runLifecycleHook(service, liveJob, URL_DELETED);

    assert.equal(outcome.hookCompleted, true, 'job deletion must still complete');
    assert.equal(outcome.indexing.status, 'failed');
  });
});

test('lifecycle: a Mongo log write failure does not break the submission', async () => {
  await withEnv({}, async () => {
    const { fetchImpl } = makeFetch([OK]);
    const service = createIndexingService({
      fetchImpl,
      getAccessToken: async () => 'fake-access-token',
      logStore: { record: async () => { throw new Error('mongo down'); } },
      logger: silentLogger,
      sleep: async () => {},
    });

    // The manual reindex endpoint awaits this call, so a broken audit write
    // must not turn a notification Google accepted into a 500.
    const result = await service.submitUrlUpdated(JOB_URL);
    assert.equal(result.status, 'success');
    assert.equal(result.httpStatus, 200);
  });
});
