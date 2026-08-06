// tests/getAllJobPosts.contract.test.js
// ---------------------------------------------------------------------------
// Contract test for the two-path controller. Runs WITHOUT a database by
// stubbing the JobPost model's query builders and recording how they were
// called.
//
// What this proves:
//   * a request with no Query Engine parameter executes the ORIGINAL query
//     (filter { status:'Published' }, sort { createdAt:-1 }, no skip, no limit,
//     no .lean()) and responds with exactly { success, jobPosts }
//   * ?keyword= — which SearchForm6 sends today — still takes that path
//   * a request with a trigger paginates, sorts with the _id tiebreaker, and
//     adds `pagination` / `appliedFilters` WITHOUT renaming jobPosts
//
// The filtered-path cases deliberately use only parameters that need no
// taxonomy lookup (page/limit/sort/workMode/experience), so no master
// collection is touched and the test stays database-free.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';

import JobPost from '../models/jobs.model.js';
import candidateController from '../controller/candidate.controller.js';

// --- test doubles ----------------------------------------------------------

const makeChain = (result, record) => {
  const chain = {};
  for (const method of ['populate', 'select', 'sort', 'skip', 'limit', 'lean']) {
    chain[method] = (...args) => {
      record.calls.push([method, ...args]);
      return chain;
    };
  }
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return chain;
};

const stubJobPost = (rows, total) => {
  const record = { filter: undefined, calls: [], countFilter: undefined, counted: false };

  const originalFind = JobPost.find;
  const originalCount = JobPost.countDocuments;

  JobPost.find = (filter) => {
    record.filter = filter;
    return makeChain(rows, record);
  };
  JobPost.countDocuments = async (filter) => {
    record.counted = true;
    record.countFilter = filter;
    return total;
  };

  record.restore = () => {
    JobPost.find = originalFind;
    JobPost.countDocuments = originalCount;
  };

  return record;
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

const invoke = async (query, rows = [], total = 0) => {
  const record = stubJobPost(rows, total);
  const res = makeRes();
  let forwardedError = null;
  try {
    await candidateController.getAllJobPosts(
      { query, user: null },
      res,
      (err) => { forwardedError = err; },
    );
  } finally {
    record.restore();
  }
  return { record, res, forwardedError };
};

const findArg = (calls, method) => calls.find((c) => c[0] === method);

const SAMPLE = [
  { _id: 'a1', title: 'Software Developer', collarCategory: 'White Collar', role: { name: 'Dev' } },
  { _id: 'a2', title: 'Sales Executive', collarCategory: 'Blue Collar', role: null },
];

// ===========================================================================
// LEGACY PATH
// ===========================================================================

test('legacy: no params -> original query and original response shape', async () => {
  const { record, res, forwardedError } = await invoke({}, SAMPLE);

  assert.equal(forwardedError, null);
  assert.equal(res.statusCode, 200);

  // Exactly the original filter and sort.
  assert.deepEqual(record.filter, { status: 'Published' });
  assert.deepEqual(findArg(record.calls, 'sort'), ['sort', { createdAt: -1 }]);

  // No pagination, and critically NO .lean() on the legacy path.
  assert.equal(findArg(record.calls, 'skip'), undefined);
  assert.equal(findArg(record.calls, 'limit'), undefined);
  assert.equal(findArg(record.calls, 'lean'), undefined);
  assert.equal(record.counted, false, 'legacy path must not run countDocuments');

  // Response contract: exactly two keys, in order.
  assert.deepEqual(Object.keys(res.body), ['success', 'jobPosts']);
  assert.equal(res.body.success, true);
  assert.equal(res.body.jobPosts.length, 2);
  assert.equal(res.body.pagination, undefined);
  assert.equal(res.body.appliedFilters, undefined);
});

test('legacy: the five populates are unchanged and in order', async () => {
  const { record } = await invoke({});
  const populates = record.calls.filter((c) => c[0] === 'populate').map((c) => [c[1], c[2]]);

  assert.deepEqual(populates, [
    ['companyProfile', 'companyName logo publicPhone phone'],
    ['skills', 'name slug keywords'],
    ['industry', 'name'],
    ['functionalAreas', 'name'],
    ['role', 'name defaultCollarCategory'],
  ]);
  assert.deepEqual(findArg(record.calls, 'select'), ['select', '-__v -applicantCount']);
});

test('legacy: ?keyword= (sent by SearchForm6 today) still takes the legacy path', async () => {
  const { record, res } = await invoke({ keyword: 'developer' }, SAMPLE);

  assert.deepEqual(record.filter, { status: 'Published' });
  assert.equal(record.counted, false);
  assert.deepEqual(Object.keys(res.body), ['success', 'jobPosts']);
  assert.equal(res.body.jobPosts.length, 2, 'must return the FULL list, unfiltered');
});

test('legacy: cache-buster and unknown params take the legacy path', async () => {
  for (const query of [{ _t: '1699999' }, { utm_source: 'google' }, { category: 'it' }]) {
    const { record, res } = await invoke(query, SAMPLE);
    assert.deepEqual(record.filter, { status: 'Published' }, JSON.stringify(query));
    assert.deepEqual(Object.keys(res.body), ['success', 'jobPosts']);
  }
});

test('legacy: collarCategory override still applied', async () => {
  const { res } = await invoke({}, [
    { _id: 'x', collarCategory: 'Blue Collar', role: { defaultCollarCategory: 'Gold Collar' } },
  ]);
  assert.equal(res.body.jobPosts[0].collarCategory, 'Gold Collar');
});

// ===========================================================================
// FILTERED PATH
// ===========================================================================

test('filtered: pagination applied and metadata added', async () => {
  const { record, res } = await invoke({ page: '2', limit: '10' }, SAMPLE, 45);

  assert.equal(record.counted, true, 'filtered path must count for pagination');
  assert.deepEqual(findArg(record.calls, 'skip'), ['skip', 10]);
  assert.deepEqual(findArg(record.calls, 'limit'), ['limit', 10]);
  assert.ok(findArg(record.calls, 'lean'), 'filtered path uses lean()');

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.ok(Array.isArray(res.body.jobPosts), 'jobPosts key name is unchanged');
  assert.deepEqual(res.body.pagination, {
    page: 2, limit: 10, total: 45, totalPages: 5, hasNext: true, hasPrev: true,
  });
  assert.ok(res.body.appliedFilters);
});

test('filtered: sort carries the _id tiebreaker', async () => {
  const latest = await invoke({ page: '1' }, [], 0);
  assert.deepEqual(findArg(latest.record.calls, 'sort'), ['sort', { createdAt: -1, _id: -1 }]);

  const oldest = await invoke({ sort: 'oldest' }, [], 0);
  assert.deepEqual(findArg(oldest.record.calls, 'sort'), ['sort', { createdAt: 1, _id: 1 }]);
});

test('filtered: element shape matches legacy (same populates and select)', async () => {
  const { record } = await invoke({ page: '1' });
  const populates = record.calls.filter((c) => c[0] === 'populate').map((c) => [c[1], c[2]]);

  assert.deepEqual(populates, [
    ['companyProfile', 'companyName logo publicPhone phone'],
    ['skills', 'name slug keywords'],
    ['industry', 'name'],
    ['functionalAreas', 'name'],
    ['role', 'name defaultCollarCategory'],
  ]);
  assert.deepEqual(findArg(record.calls, 'select'), ['select', '-__v -applicantCount']);
});

test('filtered: filters reach the Mongo query and status stays Published', async () => {
  const { record } = await invoke({ workMode: 'remote', experience: '2-5' }, [], 0);

  assert.equal(record.filter.status, 'Published');
  assert.equal(record.filter.remoteWork, 'Remote');
  assert.deepEqual(record.filter.experienceMin, { $lte: 5 });
  assert.deepEqual(record.filter.experienceMax, { $gte: 2 });
  assert.equal('applicationDeadline' in record.filter, false, 'expiry semantics preserved');
  assert.deepEqual(record.countFilter, record.filter, 'count uses the same filter as find');
});

test('filtered: out-of-range page returns 200 with an empty list, never 404', async () => {
  const { res } = await invoke({ page: '999' }, [], 45);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.jobPosts, []);
  assert.equal(res.body.pagination.totalPages, 3);
  assert.equal(res.body.pagination.hasNext, false);
});

test('filtered: malformed values clamp instead of erroring', async () => {
  const { record, res, forwardedError } = await invoke(
    { page: 'abc', limit: '99999', sort: 'banana' }, [], 5,
  );

  assert.equal(forwardedError, null);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(findArg(record.calls, 'skip'), ['skip', 0]);
  assert.deepEqual(findArg(record.calls, 'limit'), ['limit', 50]);
  assert.deepEqual(findArg(record.calls, 'sort'), ['sort', { createdAt: -1, _id: -1 }]);
});

test('filtered: repeated query keys (Express 5 arrays) do not 500', async () => {
  const { res, forwardedError } = await invoke(
    { page: ['2', '7'], sort: ['oldest', 'latest'], workMode: ['remote', 'hybrid'] }, [], 10,
  );

  assert.equal(forwardedError, null);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.pagination.page, 2);
});
