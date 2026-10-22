// tests/jobOpenPositions.test.js
// ---------------------------------------------------------------------------
// Filled jobs (positions.remaining <= 0) are not live: they are excluded from
// the query engine, and are not publicly indexable. Pure — no database.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';

import { OPEN_POSITIONS_CLAUSE, hasOpenPositions, withOpenPositions } from '../utils/jobOpenPositions.js';
import { buildJobFilter } from '../utils/jobQueryFilter.js';
import { isPubliclyIndexable } from '../utils/googleIndexing.js';

test('hasOpenPositions: filled is closed, untracked stays open', () => {
  assert.equal(hasOpenPositions({ positions: { total: 3, remaining: 0 } }), false);
  assert.equal(hasOpenPositions({ positions: { total: 3, remaining: -1 } }), false);
  assert.equal(hasOpenPositions({ positions: { total: 3, remaining: 2 } }), true);
  assert.equal(hasOpenPositions({ positions: { total: 3 } }), true);
  assert.equal(hasOpenPositions({}), true);
  assert.equal(hasOpenPositions({ positions: { remaining: null } }), true);
});

test('withOpenPositions keeps an existing $and and never clobbers $or', () => {
  const filter = withOpenPositions({ $or: [{ title: /x/ }], $and: [{ a: 1 }] });
  assert.deepEqual(filter.$or, [{ title: /x/ }]);
  assert.deepEqual(filter.$and, [{ a: 1 }, OPEN_POSITIONS_CLAUSE]);
});

test('buildJobFilter excludes filled jobs alongside the status / deadline gate', () => {
  const now = new Date('2026-10-22T00:00:00Z');
  const filter = buildJobFilter({ q: 'react' }, { textTargets: {} }, { now });
  assert.equal(filter.status, 'Published');
  assert.deepEqual(filter.applicationDeadline, { $gte: now });
  assert.ok(filter.$and.includes(OPEN_POSITIONS_CLAUSE));
  assert.ok(Array.isArray(filter.$or), 'q matching is preserved');
});

test('isPubliclyIndexable: a filled job is not indexable', () => {
  const now = new Date('2026-10-22T00:00:00Z');
  const base = { status: 'Published', slug: 'php-developer-jobs-in-coimbatore-acme', applicationDeadline: '2026-11-30' };
  assert.equal(isPubliclyIndexable(base, now), true);
  assert.equal(isPubliclyIndexable({ ...base, positions: { total: 3, remaining: 1 } }, now), true);
  assert.equal(isPubliclyIndexable({ ...base, positions: { total: 3, remaining: 0 } }, now), false);
});
