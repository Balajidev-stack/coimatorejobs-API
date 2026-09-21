// utils/jobHubSummary.js
// ---------------------------------------------------------------------------
// Taxonomy summary for the /jobs-in-coimbatore SEO hub.
//
// The hub has ONE job listing (the query engine). This module supplies only the
// internal-linking data around it: how many live jobs the city has, and which
// categories, roles and other locations currently have live openings — so the
// hub links to taxonomy pages that are backed by real inventory.
//
// PURE BY DESIGN: no models, no I/O. The controller loads the live job set once
// (a single projected query) and hands it in.
// ---------------------------------------------------------------------------

export const DEFAULT_HUB_CITY = 'Coimbatore';
export const DEFAULT_LINK_LIMIT = 12;
export const MAX_LINK_LIMIT = 30;

const toText = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (typeof value === 'object') return toText(value.name || value.title || '');
  return '';
};

/** Lowercase alphanumerics only — separator-insensitive comparison. */
export const compactText = (value) => toText(value).toLowerCase().replace(/[^a-z0-9]/g, '');

export const jobCities = (job) =>
  (Array.isArray(job?.location?.city) ? job.location.city : [job?.location?.city])
    .map(toText)
    .filter(Boolean);

/** Published and the application deadline has not passed. */
export const isLiveJob = (job, now = new Date()) => {
  if (toText(job?.status) !== 'Published') return false;
  const deadline = job?.applicationDeadline ? new Date(job.applicationDeadline) : null;
  if (!deadline || Number.isNaN(deadline.getTime())) return false;
  return deadline.getTime() >= now.getTime();
};

export const isInCity = (job, city = DEFAULT_HUB_CITY) => {
  const target = compactText(city);
  return Boolean(target) && jobCities(job).some((value) => compactText(value) === target);
};

const tally = (jobs, extract, { exclude = '', limit }) => {
  const excluded = compactText(exclude);
  const counts = new Map();
  jobs.forEach((job) => {
    // Count each value once per job even if a job lists it twice.
    new Set(extract(job).map((value) => value.trim()).filter(Boolean)).forEach((name) => {
      const key = compactText(name);
      if (!key || key === excluded) return;
      const entry = counts.get(key);
      if (entry) entry.count += 1;
      else counts.set(key, { name, count: 1 });
    });
  });
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
};

/**
 * @param {Array}  jobs  Job documents. Expired / closed / draft / other-city
 *                       jobs may be present; they are filtered here as well,
 *                       so correctness never depends on the caller's query.
 * @param {Object} [options] { now, city, limit }
 */
export const buildHubSummary = (
  jobs = [],
  { now = new Date(), city = DEFAULT_HUB_CITY, limit = DEFAULT_LINK_LIMIT } = {},
) => {
  const safeLimit = Math.min(Math.max(Number(limit) || DEFAULT_LINK_LIMIT, 1), MAX_LINK_LIMIT);
  const live = (Array.isArray(jobs) ? jobs : []).filter((job) => isLiveJob(job, now));
  const cityJobs = live.filter((job) => isInCity(job, city));

  return {
    city,
    liveOnly: true,
    generatedAt: now.toISOString(),
    total: cityJobs.length,
    categories: tally(cityJobs, (job) => [toText(job?.industry)], { limit: safeLimit }),
    roles: tally(cityJobs, (job) => [toText(job?.role)], { limit: safeLimit }),
    // Other cities with live openings (the hub itself covers the hub city).
    locations: tally(live, jobCities, { exclude: city, limit: safeLimit }),
  };
};
