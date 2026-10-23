// tests/indexingLiveBackfill.test.js
// ---------------------------------------------------------------------------
// The live-job backfill: announces only live /job/{slug} pages Google has not
// yet accepted since their last update; dry-run sends nothing. No database,
// no network — every collaborator is injected.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';

import { backfillLiveJobs, isAnnouncementCurrent, MAX_BACKFILL_LIMIT } from '../utils/indexingLiveBackfill.js';

const NOW = new Date('2026-10-22T00:00:00Z');
const job = (id, extra = {}) => ({
  _id: id,
  slug: `role-${id}-jobs-in-coimbatore-acme`,
  status: 'Published',
  applicationDeadline: '2026-12-01',
  updatedAt: '2026-10-20T00:00:00Z',
  ...extra,
});
const silent = { log: () => {} };

const run = (jobs, logs = new Map(), options = {}) => {
  const sent = [];
  return backfillLiveJobs({
    now: NOW,
    logger: silent,
    findLivePage: async ({ after }) => (after ? [] : jobs),
    findLogs: async () => logs,
    submit: async (url) => {
      sent.push(url);
      return { status: 'success', httpStatus: 200 };
    },
    ...options,
  }).then((summary) => ({ summary, sent }));
};

test('isAnnouncementCurrent: success after the last update is current', () => {
  const j = job('a');
  assert.equal(isAnnouncementCurrent(j, { lastSuccessAt: '2026-10-21T00:00:00Z' }), true);
  assert.equal(isAnnouncementCurrent(j, { lastSuccessAt: '2026-10-19T00:00:00Z' }), false, 'edited since');
  assert.equal(isAnnouncementCurrent(j, { lastAttemptAt: '2026-10-21T00:00:00Z' }), false, 'attempt is not success');
  assert.equal(isAnnouncementCurrent(j, null), false);
});

test('announces only un-announced live jobs, as /job/{slug} URLs', async () => {
  const fresh = job('a');
  const announced = job('b');
  const filled = job('c', { positions: { total: 2, remaining: 0 } });
  const logs = new Map([
    ['https://coimbatorejobs.in/job/role-b-jobs-in-coimbatore-acme', { updatedLog: { lastSuccessAt: '2026-10-21T00:00:00Z' } }],
  ]);
  const { summary, sent } = await run([fresh, announced, filled], logs);
  assert.deepEqual(sent, ['https://coimbatorejobs.in/job/role-a-jobs-in-coimbatore-acme']);
  assert.equal(summary.alreadyAnnounced, 1);
  assert.equal(summary.notLive, 1);
  assert.equal(summary.succeeded, 1);
  for (const url of sent) assert.match(url, /^https:\/\/coimbatorejobs\.in\/job\/[a-z0-9-]+$/);
});

test('dry run sends nothing but reports the pending URLs', async () => {
  const { summary, sent } = await run([job('a'), job('b')], new Map(), { dryRun: true });
  assert.deepEqual(sent, []);
  assert.equal(summary.pending.length, 2);
  assert.equal(summary.submitted, 0);
});

test('limit caps a run and can never exceed the daily-quota-safe maximum', async () => {
  const many = Array.from({ length: 300 }, (_, i) => job(`j${i}`));
  const capped = await run(many, new Map(), { limit: 5 });
  assert.equal(capped.sent.length, 5);
  const huge = await run(many, new Map(), { limit: 10000 });
  assert.equal(huge.sent.length, MAX_BACKFILL_LIMIT);
});

test('excluded slugs (e.g. test jobs) are never submitted', async () => {
  const { summary, sent } = await run([job('a'), job('test')], new Map(), { excludeSlugs: ['role-test-jobs-in-coimbatore-acme'] });
  assert.deepEqual(sent, ['https://coimbatorejobs.in/job/role-a-jobs-in-coimbatore-acme']);
  assert.equal(summary.excluded, 1);
});
