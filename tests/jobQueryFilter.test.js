// tests/jobQueryFilter.test.js
// ---------------------------------------------------------------------------
// Unit suite for the Query Engine translation layer. Pure — no database, no
// network, no fixtures. Run with: npm test
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasQueryTrigger,
  parseJobQuery,
  parseExperienceQuery,
  parseSalaryQuery,
  parsePostedQuery,
  buildJobFilter,
  buildSortSpec,
  buildPagination,
  buildAppliedFilters,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from '../utils/jobQueryFilter.js';

import {
  parseExperienceText,
  parseOfferedSalaryToMonthly,
  structuredSalaryToMonthly,
  deriveSalaryNorm,
} from '../utils/jobNormalization.js';

const oid = (n) => `0000000000000000000000${String(n).padStart(2, '0')}`;

// ===========================================================================
// THE GATE — the single most important behaviour in this phase
// ===========================================================================
test('gate: no params -> legacy path', () => {
  assert.equal(hasQueryTrigger({}), false);
});

test('gate: keyword must NEVER trigger (SearchForm6 sends it today)', () => {
  assert.equal(hasQueryTrigger({ keyword: 'developer' }), false);
});

test('gate: cache-buster and category must never trigger', () => {
  assert.equal(hasQueryTrigger({ _t: '1699999' }), false);
  assert.equal(hasQueryTrigger({ category: 'it' }), false);
  assert.equal(hasQueryTrigger({ keyword: 'dev', _t: '123' }), false);
});

test('gate: unknown params do not trigger', () => {
  assert.equal(hasQueryTrigger({ foo: 'bar', utm_source: 'google' }), false);
});

test('gate: each of the 15 canonical params triggers', () => {
  const canonical = ['q', 'industry', 'role', 'company', 'location', 'experience',
    'salary', 'qualification', 'jobType', 'workMode', 'skills', 'posted',
    'sort', 'page', 'limit'];
  for (const key of canonical) {
    assert.equal(hasQueryTrigger({ [key]: 'x' }), true, `${key} should trigger`);
  }
});

test('gate: accepted aliases trigger', () => {
  for (const key of ['salaryMin', 'salaryMax', 'skill', 'jobtype', 'qualifications', 'education', 'datePosted']) {
    assert.equal(hasQueryTrigger({ [key]: 'x' }), true, `${key} should trigger`);
  }
});

// ===========================================================================
// EXPRESS 5 INPUT HAZARDS
// ===========================================================================
test('array-valued params take the first value and never throw', () => {
  const parsed = parseJobQuery({
    q: ['alpha', 'beta'],
    sort: ['latest', 'oldest'],
    page: ['2', '9'],
    limit: ['10', '50'],
    industry: ['information-technology', 'x'],
  });
  assert.equal(parsed.q, 'alpha');
  assert.equal(parsed.sort, 'latest');
  assert.equal(parsed.page, 2);
  assert.equal(parsed.limit, 10);
  assert.equal(parsed.industry, 'information-technology');
});

test('operator-injection shapes are inert', () => {
  // Express 5 simple parser yields the literal flat key, but guard anyway.
  const parsed = parseJobQuery({ 'industry[$ne]': 'x', industry: { $ne: 'x' } });
  assert.equal(parsed.industry, '');
  const filter = buildJobFilter(parsed, {});
  assert.equal(filter.industry, undefined);
  assert.equal(filter.status, 'Published');
});

test('prototype-pollution keys are ignored', () => {
  const parsed = parseJobQuery({ __proto__: { polluted: true }, q: 'safe' });
  assert.equal(parsed.q, 'safe');
  assert.equal({}.polluted, undefined);
});

test('regex metacharacters in q are escaped', () => {
  const parsed = parseJobQuery({ q: 'c++ (.*)[a-z]' });
  const filter = buildJobFilter(parsed, { textTargets: {} });
  assert.ok(filter.$or[0].title instanceof RegExp);
  assert.ok(filter.$or[0].title.test('C++ (.*)[a-z] Developer'));
  assert.equal(filter.$or[0].title.test('anything else'), false);
});

test('q is length-capped', () => {
  const parsed = parseJobQuery({ q: 'a'.repeat(500) });
  assert.equal(parsed.q.length, 100);
});

// ===========================================================================
// CLAMPING — never reject, always clamp
// ===========================================================================
test('page clamps and never errors', () => {
  assert.equal(parseJobQuery({ page: '0' }).page, 1);
  assert.equal(parseJobQuery({ page: '-5' }).page, 1);
  assert.equal(parseJobQuery({ page: 'abc' }).page, 1);
  assert.equal(parseJobQuery({ page: '3' }).page, 3);
});

test('limit clamps to MAX_LIMIT and defaults', () => {
  assert.equal(parseJobQuery({ limit: '9999' }).limit, MAX_LIMIT);
  assert.equal(parseJobQuery({ limit: 'abc' }).limit, DEFAULT_LIMIT);
  assert.equal(parseJobQuery({ limit: '0' }).limit, DEFAULT_LIMIT);
  assert.equal(parseJobQuery({ limit: '50' }).limit, 50);
  assert.equal(parseJobQuery({ limit: '10' }).limit, 10);
});

test('unknown sort falls back to default', () => {
  assert.equal(parseJobQuery({ sort: 'banana' }).sort, 'latest');
  assert.equal(parseJobQuery({ sort: 'oldest' }).sort, 'oldest');
  assert.equal(parseJobQuery({ sort: 'relevance' }).sort, 'relevance');
});

test('skip is derived from page and limit', () => {
  assert.equal(parseJobQuery({ page: '3', limit: '10' }).skip, 20);
  assert.equal(parseJobQuery({ page: '1' }).skip, 0);
});

// ===========================================================================
// EXPERIENCE
// ===========================================================================
test('experience: numeric range', () => {
  assert.deepEqual(parseExperienceQuery('2-5'), { min: 2, max: 5 });
  assert.deepEqual(parseExperienceQuery('5-2'), { min: 2, max: 5 });
  assert.deepEqual(parseExperienceQuery('3'), { min: 3, max: 3 });
});

test('experience: open-ended survives slugification', () => {
  assert.deepEqual(parseExperienceQuery('10+'), { min: 10, max: 99 });
  assert.deepEqual(parseExperienceQuery('5 plus'), { min: 5, max: 99 });
});

test('experience: every legacy bucket token still resolves', () => {
  assert.deepEqual(parseExperienceQuery('fresher'), { min: 0, max: 1 });
  assert.deepEqual(parseExperienceQuery('less-than-1-year'), { min: 0, max: 1 });
  assert.deepEqual(parseExperienceQuery('1-3-years'), { min: 1, max: 3 });
  assert.deepEqual(parseExperienceQuery('3-5-years'), { min: 3, max: 5 });
  assert.deepEqual(parseExperienceQuery('5-10-years'), { min: 5, max: 10 });
  assert.deepEqual(parseExperienceQuery('10-plus-years'), { min: 10, max: 99 });
});

test('experience: garbage returns null', () => {
  assert.equal(parseExperienceQuery('banana'), null);
  assert.equal(parseExperienceQuery(''), null);
});

test('experience filter uses OVERLAP semantics', () => {
  const parsed = parseJobQuery({ experience: '2-5' });
  const filter = buildJobFilter(parsed, {});
  assert.deepEqual(filter.experienceMin, { $lte: 5 });
  assert.deepEqual(filter.experienceMax, { $gte: 2 });
});

// ===========================================================================
// SALARY
// ===========================================================================
test('salary: range, open-ended, and k-suffix', () => {
  assert.deepEqual(parseSalaryQuery({ salary: '30000-50000' }), { min: 30000, max: 50000 });
  assert.deepEqual(parseSalaryQuery({ salary: '30000-' }), { min: 30000, max: null });
  assert.deepEqual(parseSalaryQuery({ salary: '-50000' }), { min: null, max: 50000 });
  assert.deepEqual(parseSalaryQuery({ salary: '30k-50k' }), { min: 30000, max: 50000 });
});

test('salary: legacy salaryMin/salaryMax aliases override', () => {
  assert.deepEqual(parseSalaryQuery({ salaryMin: '20000', salaryMax: '40000' }), { min: 20000, max: 40000 });
});

test('salary: inverted range is corrected', () => {
  assert.deepEqual(parseSalaryQuery({ salary: '50000-30000' }), { min: 30000, max: 50000 });
});

test('salary filter omits the open bound', () => {
  const openMax = buildJobFilter(parseJobQuery({ salary: '30000-' }), {});
  assert.equal(openMax['salaryNorm.min'], undefined);
  assert.deepEqual(openMax['salaryNorm.max'], { $gte: 30000 });
});

// ===========================================================================
// POSTED
// ===========================================================================
test('posted: new and legacy tokens', () => {
  const now = Date.UTC(2026, 0, 15, 12, 0, 0);
  assert.equal(parsePostedQuery('24h', now).toISOString(), new Date(now - 864e5).toISOString());
  assert.equal(parsePostedQuery('7d', now).toISOString(), new Date(now - 6048e5).toISOString());
  assert.equal(parsePostedQuery('7days', now).toISOString(), new Date(now - 6048e5).toISOString());
  assert.equal(parsePostedQuery('30days', now).toISOString(), new Date(now - 2592e6).toISOString());
});

test('posted: unrecognized token omits the filter', () => {
  assert.equal(parsePostedQuery('99y'), null);
  assert.equal(buildJobFilter(parseJobQuery({ posted: '99y' }), {}).createdAt, undefined);
});

// ===========================================================================
// JOB TYPE / WORK MODE / QUALIFICATION / SKILLS
// ===========================================================================
test('jobType: legacy aliases map to canonical tokens', () => {
  assert.deepEqual(parseJobQuery({ jobType: 'freelancer' }).jobType, ['freelancer']);
  assert.deepEqual(parseJobQuery({ jobType: 'free-lancer' }).jobType, ['freelancer']);
  assert.deepEqual(parseJobQuery({ jobType: 'intership' }).jobType, ['internship']);
  assert.deepEqual(parseJobQuery({ jobtype: 'fulltime' }).jobType, ['full-time']);
});

test('jobType: DB patterns tolerate real stored spellings', () => {
  const filter = buildJobFilter(parseJobQuery({ jobType: 'freelancer,full-time' }), {});
  const matches = (value) => filter.jobType.$in.some((re) => re.test(value));
  assert.ok(matches('Free Lancer'));
  assert.ok(matches('Freelance'));
  assert.ok(matches('Full-time'));
  assert.ok(matches('Full Time'));
  assert.equal(matches('Internship'), false);
});

test('workMode maps to the remoteWork field', () => {
  assert.equal(buildJobFilter(parseJobQuery({ workMode: 'remote' }), {}).remoteWork, 'Remote');
  assert.equal(buildJobFilter(parseJobQuery({ workMode: 'on-site' }), {}).remoteWork, 'On-site');
  assert.equal(buildJobFilter(parseJobQuery({ workMode: 'onsite' }), {}).remoteWork, 'On-site');
  assert.equal(buildJobFilter(parseJobQuery({ workMode: 'hybrid' }), {}).remoteWork, 'Hybrid');
});

test('qualification survives slug round-tripping (B.Tech case)', () => {
  const filter = buildJobFilter(parseJobQuery({ qualification: 'B.Tech' }), {});
  const re = filter.qualification.$in[0];
  assert.ok(re.test('B.Tech'));
  assert.ok(re.test('B Tech'));
  assert.ok(re.test('BTech'));
  assert.ok(re.test('Bachelor of B.Tech Engineering'));
});

test('skills use OR semantics and are capped', () => {
  const parsed = parseJobQuery({ skills: 'react,node,go' });
  assert.deepEqual(parsed.skills, ['react', 'node', 'go']);
  const filter = buildJobFilter(parsed, { skills: { ids: [oid(1), oid(2)] } });
  assert.deepEqual(filter.skills, { $in: [oid(1), oid(2)] });
  assert.equal(parseJobQuery({ skills: Array.from({ length: 40 }, (_, i) => `s${i}`).join(',') }).skills.length, 10);
});

// ===========================================================================
// FILTER ASSEMBLY INVARIANTS
// ===========================================================================
test('status Published is always present', () => {
  for (const q of [{}, { q: 'dev' }, { industry: 'it' }, { page: '5' }]) {
    assert.equal(buildJobFilter(parseJobQuery(q), { textTargets: {} }).status, 'Published');
  }
});

test('applicationDeadline is NEVER added (expiry semantics preserved)', () => {
  const filter = buildJobFilter(
    parseJobQuery({ q: 'dev', industry: 'it', posted: '7d', sort: 'oldest' }),
    { textTargets: {}, industry: { ids: [oid(1)] } },
  );
  assert.equal('applicationDeadline' in filter, false);
});

test('unresolved taxonomy yields an empty $in, not a missing filter', () => {
  const filter = buildJobFilter(parseJobQuery({ industry: 'does-not-exist' }), {
    industry: { ids: [], items: [], matched: false },
  });
  assert.deepEqual(filter.industry, { $in: [] });
});

test('no forbidden Mongo operators are ever emitted', () => {
  const filter = buildJobFilter(
    parseJobQuery({ q: 'a', industry: 'b', role: 'c', company: 'd', location: 'e',
      experience: '2-5', salary: '1000-2000', qualification: 'x', jobType: 'full-time',
      workMode: 'remote', skills: 'y', posted: '7d' }),
    { textTargets: { roleIds: [oid(1)] }, industry: { ids: [oid(2)] }, role: { ids: [oid(3)] },
      company: { ids: [oid(4)] }, location: { name: 'Coimbatore' }, skills: { ids: [oid(5)] } },
  );
  const serialized = JSON.stringify(filter, (k, v) => (v instanceof RegExp ? v.source : v));
  for (const forbidden of ['$where', '$expr', '$function', '$accumulator']) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} must not appear`);
  }
});

test('location matches the multikey city array case-insensitively', () => {
  const filter = buildJobFilter(parseJobQuery({ location: 'coimbatore' }), {
    location: { name: 'Coimbatore', matched: true },
  });
  assert.ok(filter['location.city'].$in[0].test('coimbatore'));
  assert.ok(filter['location.city'].$in[0].test('Coimbatore'));
  assert.equal(filter['location.city'].$in[0].test('Coimbatore North'), false);
});

// ===========================================================================
// SORT + PAGINATION
// ===========================================================================
test('sort spec includes the _id tiebreaker', () => {
  assert.deepEqual(buildSortSpec('latest'), { createdAt: -1, _id: -1 });
  assert.deepEqual(buildSortSpec('oldest'), { createdAt: 1, _id: 1 });
  assert.deepEqual(buildSortSpec('relevance'), { createdAt: -1, _id: -1 });
});

test('pagination metadata is correct', () => {
  assert.deepEqual(buildPagination({ page: 2, limit: 20 }, 45),
    { page: 2, limit: 20, total: 45, totalPages: 3, hasNext: true, hasPrev: true });
  assert.deepEqual(buildPagination({ page: 1, limit: 20 }, 0),
    { page: 1, limit: 20, total: 0, totalPages: 0, hasNext: false, hasPrev: false });
  assert.deepEqual(buildPagination({ page: 3, limit: 20 }, 45),
    { page: 3, limit: 20, total: 45, totalPages: 3, hasNext: false, hasPrev: true });
});

test('appliedFilters echoes resolution state', () => {
  const parsed = parseJobQuery({ industry: 'information-technology', sort: 'oldest' });
  const applied = buildAppliedFilters(parsed, {
    industry: { items: [{ id: oid(1), name: 'Information Technology', slug: 'information-technology' }], matched: true },
  });
  assert.equal(applied.industry.matched, true);
  assert.equal(applied.industry.resolved[0].name, 'Information Technology');
  assert.equal(applied.sort, 'oldest');
});

// ===========================================================================
// NORMALIZATION (shared by the model hook and both migrations)
// ===========================================================================
test('experience text parsing', () => {
  // "Freshers" is its own bucket in production (87 of 256 jobs) and is distinct
  // from "0-1 Years" (50 jobs). max=0 keeps fresher roles out of ?experience=1-3.
  assert.deepEqual(parseExperienceText('Fresher'), { min: 0, max: 0 });
  assert.deepEqual(parseExperienceText('Freshers'), { min: 0, max: 0 });
  assert.deepEqual(parseExperienceText('Less than 1 year'), { min: 0, max: 1 });
  assert.deepEqual(parseExperienceText('1-3 years'), { min: 1, max: 3 });
  assert.deepEqual(parseExperienceText('10+ years'), { min: 10, max: 99 });
  assert.deepEqual(parseExperienceText('2 years'), { min: 2, max: 2 });
  assert.deepEqual(parseExperienceText('6 months'), { min: 0.5, max: 0.5 });
  assert.equal(parseExperienceText(''), null);
  assert.equal(parseExperienceText('unspecified'), null);
});

test('offeredSalary parsing normalizes to INR/month', () => {
  assert.deepEqual(parseOfferedSalaryToMonthly('15K - 18K /Month'), { min: 15000, max: 18000 });
  assert.deepEqual(parseOfferedSalaryToMonthly('30000 - 50000 per month'), { min: 30000, max: 50000 });
  // 5 LPA = 500000/yr = 41667/month
  assert.deepEqual(parseOfferedSalaryToMonthly('5 - 10 LPA'), { min: 41667, max: 83333 });
});

test('offeredSalary omits rather than guesses', () => {
  assert.equal(parseOfferedSalaryToMonthly('Negotiable'), null);
  assert.equal(parseOfferedSalaryToMonthly('20000 - 30000'), null, 'no pay period -> omit');
  assert.equal(parseOfferedSalaryToMonthly('0K - 20K /Month'), null, 'corrupt 0 bound -> omit');
});

test('offeredSalary handles the "Thousands" production format', () => {
  // 73 of 256 production jobs use this shape and previously parsed to null.
  assert.deepEqual(parseOfferedSalaryToMonthly('12 Thousands - 15 Thousands'), { min: 12000, max: 15000 });
  assert.deepEqual(parseOfferedSalaryToMonthly('75 Thousands - 100 Thousands'), { min: 75000, max: 100000 });
});

test('offeredSalary rejects implausible parses', () => {
  // Real production values whose literal reading is nonsense.
  assert.equal(parseOfferedSalaryToMonthly('20000 - 35000 LPA'), null, 'Rs.16 crore/month -> omit');
  assert.equal(
    parseOfferedSalaryToMonthly('18500 Thousands - 25000 Thousands'),
    null,
    'Rs.1.85 crore/month -> omit',
  );
});

test('structured salary wins over text and rejects non-INR', () => {
  const job = { salary: { min: 600000, max: 1200000, currency: 'INR', unit: 'YEAR' }, offeredSalary: '15K /Month' };
  assert.deepEqual(deriveSalaryNorm(job), { min: 50000, max: 100000, source: 'structured' });
  assert.equal(structuredSalaryToMonthly({ min: 1000, max: 2000, currency: 'USD', unit: 'MONTH' }), null);
});

test('deriveSalaryNorm falls back to text and records provenance', () => {
  assert.deepEqual(deriveSalaryNorm({ offeredSalary: '15K - 18K /Month' }),
    { min: 15000, max: 18000, source: 'parsed' });
  assert.equal(deriveSalaryNorm({ offeredSalary: 'Negotiable' }), null);
});
