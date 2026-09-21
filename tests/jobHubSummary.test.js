import test from 'node:test';
import assert from 'node:assert/strict';

import { buildHubSummary, isInCity, isLiveJob } from '../utils/jobHubSummary.js';
import { createJobHubController } from '../controller/jobHub.controller.js';

const NOW = new Date('2026-09-21T10:00:00Z');
const FUTURE = new Date('2026-10-30T00:00:00Z');
const PAST = new Date('2026-09-01T00:00:00Z');

const job = (overrides = {}) => ({
  status: 'Published',
  applicationDeadline: FUTURE,
  location: { city: ['Coimbatore'] },
  industry: { name: 'IT / Software' },
  role: { name: 'Software Developer' },
  ...overrides,
});

const fixture = () => [
  job(),
  job({ role: { name: 'Manual Tester' } }),
  job({ industry: { name: 'Finance' }, role: { name: 'Accountant' } }),
  job({ location: { city: ['Tiruppur', 'Coimbatore'] }, industry: { name: 'Retail' }, role: { name: 'Sales Executive' } }),
  // excluded from the Coimbatore count and taxonomy:
  job({ applicationDeadline: PAST, industry: { name: 'Expired Industry' } }),
  job({ status: 'Closed', industry: { name: 'Closed Industry' } }),
  job({ status: 'Draft', industry: { name: 'Draft Industry' } }),
  job({ location: { city: ['Chennai'] }, industry: { name: 'Chennai Only Industry' } }),
];

test('isLiveJob: Published and deadline not passed', () => {
  assert.equal(isLiveJob(job(), NOW), true);
  assert.equal(isLiveJob(job({ applicationDeadline: PAST }), NOW), false);
  assert.equal(isLiveJob(job({ status: 'Closed' }), NOW), false);
  assert.equal(isLiveJob(job({ status: 'Draft' }), NOW), false);
  assert.equal(isLiveJob(job({ applicationDeadline: null }), NOW), false);
});

test('isInCity: any listed city, case/separator insensitive', () => {
  assert.equal(isInCity(job({ location: { city: ['Tiruppur', ' coimbatore'] } })), true);
  assert.equal(isInCity(job({ location: { city: ['Chennai'] } })), false);
});

test('buildHubSummary: count and taxonomy come only from live Coimbatore jobs', () => {
  const summary = buildHubSummary(fixture(), { now: NOW });
  assert.equal(summary.total, 4);
  assert.equal(summary.liveOnly, true);

  const categories = summary.categories.map((item) => item.name);
  assert.deepEqual(categories, ['IT / Software', 'Finance', 'Retail']);
  for (const excluded of ['Expired Industry', 'Closed Industry', 'Draft Industry', 'Chennai Only Industry']) {
    assert.equal(categories.includes(excluded), false, excluded);
  }
  assert.deepEqual(summary.categories[0], { name: 'IT / Software', count: 2 });
  assert.ok(summary.roles.some((item) => item.name === 'Software Developer'));
});

test('buildHubSummary: locations are other cities with live jobs, never the hub city', () => {
  const summary = buildHubSummary(fixture(), { now: NOW });
  assert.deepEqual(summary.locations.map((item) => item.name).sort(), ['Chennai', 'Tiruppur']);
});

test('buildHubSummary: returns no job listings', () => {
  const summary = buildHubSummary(fixture(), { now: NOW });
  assert.equal('sections' in summary, false);
  assert.equal('jobs' in summary, false);
});

test('buildHubSummary: empty input and link limit', () => {
  assert.deepEqual(buildHubSummary([], { now: NOW }).categories, []);
  const many = Array.from({ length: 40 }, (_, i) => job({ industry: { name: `Industry ${i}` } }));
  assert.equal(buildHubSummary(many, { now: NOW, limit: 5 }).categories.length, 5);
});

const mockRes = () => {
  const res = { statusCode: 0, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};

test('controller: returns the summary and caches it for the TTL', async () => {
  let loads = 0;
  let clockValue = NOW;
  const controller = createJobHubController({
    loadJobs: async () => { loads += 1; return fixture(); },
    clock: () => clockValue,
    ttlMs: 60000,
  });

  const res = mockRes();
  await controller.getHubSummary({ query: {} }, res, (error) => { throw error; });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.city, 'Coimbatore');
  assert.equal(res.body.total, 4);

  await controller.getHubSummary({ query: {} }, mockRes(), () => {});
  assert.equal(loads, 1, 'served from cache within TTL');

  clockValue = new Date(NOW.getTime() + 61000);
  await controller.getHubSummary({ query: {} }, mockRes(), () => {});
  assert.equal(loads, 2, 'reloaded after TTL');
});

test('controller: loader failure goes to the error handler', async () => {
  const controller = createJobHubController({
    loadJobs: async () => { throw new Error('db down'); },
    clock: () => NOW,
  });
  let forwarded = null;
  await controller.getHubSummary({ query: {} }, mockRes(), (error) => { forwarded = error; });
  assert.equal(forwarded?.message, 'db down');
});
