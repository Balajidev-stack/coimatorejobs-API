// utils/jobQueryFilter.js
// ---------------------------------------------------------------------------
// The Query Engine's translation layer: request query string -> Mongo filter,
// sort and pagination.
//
// PURE BY DESIGN. This module imports no models and performs no I/O, so it is
// directly unit-testable. Anything that needs a database lookup (slug ->
// ObjectId) is resolved by utils/jobTaxonomyResolver.js and handed in to
// buildJobFilter() as the `resolved` argument.
//
// ---------------------------------------------------------------------------
// THE OPT-IN GATE — the single most important thing in this file
// ---------------------------------------------------------------------------
// GET /candidate-dashboard/jobs has five independent consumers today, and its
// current response (the entire published collection, unfiltered, unpaginated)
// is load-bearing for all of them — including the frontend sitemap builder and
// the legacy job-URL reconciler, which both need the COMPLETE list.
//
// So the endpoint keeps two paths. hasQueryTrigger() decides which one runs.
// When no trigger parameter is present the controller executes the original
// code verbatim and the response is byte-identical to what it has always been.
//
// `keyword` is DELIBERATELY EXCLUDED from the trigger list.
// components/common/job-search/SearchForm6.jsx already sends ?keyword=<term>
// to this endpoint today, and the backend has always ignored it (that component
// filters client-side afterwards). If `keyword` triggered server-side
// filtering, that component's suggestion pool would silently shrink with no
// frontend change and no error to notice. `q` is the new canonical name; the
// frontend will map keyword -> q in a later phase, at which point filtering
// activates intentionally.
//
// `category` and `_t` are excluded for the same class of reason.
// ---------------------------------------------------------------------------

// Canonical parameters (the 15 in scope) plus the server-side aliases that are
// explicitly accepted. No current caller sends any of these to this endpoint,
// so adding them to the trigger set cannot change existing behaviour.
export const TRIGGER_PARAMS = Object.freeze([
  'q',
  'industry',
  'role',
  'company',
  'location',
  'experience',
  'salary',
  'qualification',
  'jobType',
  'workMode',
  'skills',
  'posted',
  'sort',
  'page',
  'limit',
  // accepted aliases
  'salaryMin',
  'salaryMax',
  'skill',
  'jobtype',
  'qualifications',
  'education',
  'datePosted',
]);

// Present on real requests today; must NEVER trigger the filtered path.
export const LEGACY_IGNORED_PARAMS = Object.freeze(['keyword', 'category', '_t']);

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;
export const DEFAULT_SORT = 'latest';
export const SORT_OPTIONS = Object.freeze(['latest', 'oldest', 'relevance']);

// Bounds the regex built from ?q= on an endpoint that has no rate limiter.
export const MAX_Q_LENGTH = 100;

// Bounds multi-value parameters so one request cannot build an enormous $in.
const MAX_LIST_VALUES = 10;

const TRIGGER_SET = new Set(TRIGGER_PARAMS);

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * Express 5 uses the "simple" query parser (Node querystring), so a repeated
 * key such as ?sort=latest&sort=oldest arrives as an ARRAY. Every reader must
 * go through here first — calling .trim() on an array throws and would turn a
 * malformed URL into a 500.
 *
 * The same parser means bracket notation (?industry[$ne]=x) arrives as the
 * literal flat key 'industry[$ne]', never as a nested object, so Mongo operator
 * injection is structurally impossible. The `typeof` guard below is belt and
 * braces in case the parser is ever reconfigured.
 */
const firstValue = (value) => {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (candidate === null || candidate === undefined) return '';
  if (typeof candidate === 'string' || typeof candidate === 'number') {
    return String(candidate).trim();
  }
  return '';
};

export const escapeRegex = (value) =>
  String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const exactInsensitive = (value) => new RegExp(`^${escapeRegex(value)}$`, 'i');
const containsInsensitive = (value) => new RegExp(escapeRegex(value), 'i');

/**
 * Separator-tolerant "contains" pattern.
 *
 * The current client matcher compares qualifications after stripping every
 * non-alphanumeric character from BOTH sides, so "b tech" matches a stored
 * "B.Tech". A Mongo regex cannot normalize the stored value, so instead the
 * search term's word boundaries become "any run of non-alphanumerics":
 *
 *   "b tech"  ->  /b[^a-z0-9]*tech/i   which matches "B.Tech", "B Tech", "BTech"
 *
 * Without this, slugification round-tripping ("B.Tech" -> "b-tech" -> "b tech")
 * would silently stop matching the very values it came from.
 */
const looseContains = (value) => {
  const tokens = String(value ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (!tokens.length) return null;
  return new RegExp(tokens.map(escapeRegex).join('[^a-zA-Z0-9]*'), 'i');
};

const toSlug = (value) =>
  firstValue(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const deSlug = (slug) => String(slug ?? '').split('-').filter(Boolean).join(' ');

const toList = (value, { slugify = true } = {}) => {
  const raw = firstValue(value);
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(',')
        .map((item) => (slugify ? toSlug(item) : item.trim()))
        .filter(Boolean),
    ),
  ].slice(0, MAX_LIST_VALUES);
};

const toPositiveInt = (value) => {
  const raw = firstValue(value);
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

// ---------------------------------------------------------------------------
// Alias tables — ported VERBATIM from the current client-side matcher in
// components/job-listing-pages/job-list/FilterJobsBox.jsx so that URLs already
// in circulation keep resolving to exactly the same jobs.
// ---------------------------------------------------------------------------

const EXPERIENCE_TOKEN_MAP = {
  '0': { min: 0, max: 1 },
  '0-year': { min: 0, max: 1 },
  '0-years': { min: 0, max: 1 },
  '0-year-experience': { min: 0, max: 1 },
  fresh: { min: 0, max: 1 },
  fresher: { min: 0, max: 1 },
  'less-than-1-year': { min: 0, max: 1 },
  '0-1-year': { min: 0, max: 1 },
  '1-3-year': { min: 1, max: 3 },
  '1-3-years': { min: 1, max: 3 },
  '3-5-year': { min: 3, max: 5 },
  '3-5-years': { min: 3, max: 5 },
  '5-10-year': { min: 5, max: 10 },
  '5-10-years': { min: 5, max: 10 },
  '10-plus-year': { min: 10, max: 99 },
  '10-plus-years': { min: 10, max: 99 },
};

const JOB_TYPE_QUERY_MAP = {
  freelancer: 'freelancer',
  'free-lancer': 'freelancer',
  'free-lance': 'freelancer',
  freelance: 'freelancer',
  'full-time': 'full-time',
  fulltime: 'full-time',
  'part-time': 'part-time',
  parttime: 'part-time',
  internship: 'internship',
  intership: 'internship',
  contract: 'contract',
  temporary: 'temporary',
};

// Stored jobType values are free text (the schema has no enum) and vary in
// spacing and hyphenation: "Full-time", "Full Time", "Free Lancer", "Freelance".
// Each canonical token therefore maps to a set of tolerant DB-side patterns
// rather than a single equality match.
const JOB_TYPE_DB_PATTERNS = {
  freelancer: [/^free[\s-]*lanc(e|er)$/i, /^freelanc(e|er)$/i],
  'full-time': [/^full[\s-]*time$/i],
  'part-time': [/^part[\s-]*time$/i],
  internship: [/^inter?n(ship)?$/i],
  contract: [/^contract(or)?$/i],
  temporary: [/^temp(orary)?$/i],
};

const WORK_MODE_MAP = {
  remote: 'Remote',
  hybrid: 'Hybrid',
  onsite: 'On-site',
  'on-site': 'On-site',
  office: 'On-site',
};

const POSTED_HOURS_MAP = {
  '1h': 1,
  '24h': 24,
  '1d': 24,
  '7d': 24 * 7,
  '7days': 24 * 7,
  '14d': 24 * 14,
  '14days': 24 * 14,
  '30d': 24 * 30,
  '30days': 24 * 30,
};

// ---------------------------------------------------------------------------
// Value parsers
// ---------------------------------------------------------------------------

/**
 * ?experience=  -> { min, max } in YEARS, or null.
 * Accepts the new numeric form ("2-5", "5+", "3") and every legacy bucket token
 * the current frontend already emits ("fresher", "1-3-years", "10-plus-years").
 */
export const parseExperienceQuery = (value) => {
  const raw = firstValue(value).toLowerCase();
  if (!raw) return null;

  const token = toSlug(raw);
  if (!token) return null;

  if (EXPERIENCE_TOKEN_MAP[token]) return { ...EXPERIENCE_TOKEN_MAP[token] };

  // Open-endedness must be detected on the RAW value: slugification strips "+"
  // ("10+" -> "10"), which would otherwise turn an open-ended request into an
  // exact-year match.
  const isOpenEnded = /\+|\bplus\b|\babove\b|\bonwards\b/.test(raw);

  // Generic open-ended slug form: "5-plus", "5-plus-years", "8-above".
  // The token map covers only the specific legacy "10-plus-year(s)" strings,
  // so this handles every other N.
  const openEndedToken = token.match(/^(\d+)-(?:plus|above|onwards)(?:-years?)?$/);
  if (openEndedToken) return { min: Number(openEndedToken[1]), max: 99 };

  const range = token.match(/^(\d+)-(\d+)$/);
  if (range) {
    const min = Number(range[1]);
    const max = Number(range[2]);
    return min <= max ? { min, max } : { min: max, max: min };
  }

  const single = token.match(/^(\d+)$/);
  if (single) {
    const min = Number(single[1]);
    return { min, max: isOpenEnded ? 99 : min };
  }

  return null;
};

/** "30k" -> 30000, "30000" -> 30000, "" -> null. Plain INR per month. */
const parseSalaryToken = (token) => {
  const raw = String(token ?? '').trim().toLowerCase();
  if (!raw) return null;
  const match = raw.match(/^(\d+(?:\.\d+)?)(k)?$/);
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.round(match[2] ? number * 1000 : number);
};

/**
 * ?salary=  -> { min, max } in INR per MONTH, or null. `max: null` means
 * open-ended. A bare single value is read as "at least this much".
 * salaryMin / salaryMax are accepted as overrides (legacy alias).
 */
export const parseSalaryQuery = (query = {}) => {
  const raw = firstValue(query.salary).toLowerCase();
  let min = null;
  let max = null;

  if (raw) {
    const parts = raw.split('-');
    if (parts.length >= 2) {
      min = parseSalaryToken(parts[0]);
      max = parseSalaryToken(parts[1]);
    } else {
      min = parseSalaryToken(parts[0]);
      max = null;
    }
  }

  const overrideMin = parseSalaryToken(firstValue(query.salaryMin));
  const overrideMax = parseSalaryToken(firstValue(query.salaryMax));
  if (overrideMin !== null) min = overrideMin;
  if (overrideMax !== null) max = overrideMax;

  if (min === null && max === null) return null;
  if (min !== null && max !== null && min > max) [min, max] = [max, min];

  return { min, max };
};

/** ?posted= -> a Date cutoff, or null when the token is unrecognized. */
export const parsePostedQuery = (value, now = Date.now()) => {
  const token = toSlug(value);
  if (!token) return null;
  const hours = POSTED_HOURS_MAP[token];
  if (!hours) return null;
  return new Date(now - hours * 60 * 60 * 1000);
};

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/**
 * True when the request carries at least one Query Engine parameter.
 * False -> the controller must run the untouched legacy path.
 */
export const hasQueryTrigger = (query = {}) => {
  if (!query || typeof query !== 'object') return false;
  return Object.keys(query).some((key) => TRIGGER_SET.has(key));
};

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * Normalizes a raw req.query into the descriptor the rest of the engine uses.
 *
 * CLAMP, NEVER REJECT. Invalid input yields a sane result set, never a 4xx.
 * A crawler, a stale bookmark or a hand-edited URL must not produce an error
 * page: page=0 -> 1, limit=9999 -> 50, sort=banana -> latest.
 */
export const parseJobQuery = (query = {}) => {
  const q = firstValue(query.q).slice(0, MAX_Q_LENGTH);

  const industry = toSlug(query.industry);
  const role = toSlug(query.role);
  const company = toSlug(query.company);
  const location = toSlug(query.location);

  const experience = parseExperienceQuery(query.experience);
  const salary = parseSalaryQuery(query);

  // Partial matching is preserved here on purpose: the current client matcher
  // does a substring comparison on qualification, and tightening it to an exact
  // match would silently change which jobs a live URL returns.
  const qualification = toList(
    firstValue(query.qualification) ||
      firstValue(query.qualifications) ||
      firstValue(query.education),
  ).map(deSlug);

  const jobType = toList(firstValue(query.jobType) || firstValue(query.jobtype))
    .map((token) => JOB_TYPE_QUERY_MAP[token] || token)
    .filter(Boolean);

  const workMode = WORK_MODE_MAP[toSlug(query.workMode)] || '';

  const skills = toList(firstValue(query.skills) || firstValue(query.skill));

  const posted = parsePostedQuery(firstValue(query.posted) || firstValue(query.datePosted));

  const requestedSort = firstValue(query.sort).toLowerCase();
  const sort = SORT_OPTIONS.includes(requestedSort) ? requestedSort : DEFAULT_SORT;

  const page = toPositiveInt(query.page) ?? 1;

  const requestedLimit = toPositiveInt(query.limit);
  const limit = requestedLimit === null ? DEFAULT_LIMIT : Math.min(requestedLimit, MAX_LIMIT);

  return {
    q,
    industry,
    role,
    company,
    location,
    experience,
    salary,
    qualification,
    jobType,
    workMode,
    skills,
    posted,
    sort,
    page,
    limit,
    skip: (page - 1) * limit,
  };
};

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Assembles the Mongo filter.
 *
 * A requested taxonomy value that resolved to nothing produces `$in: []`, which
 * matches no documents. That is intentional: an unknown ?industry= returns an
 * empty result set with HTTP 200, never a 404.
 *
 * `status: 'Published'` is applied LAST and unconditionally so no user input
 * can widen visibility.
 *
 * DELIBERATELY ABSENT: any applicationDeadline condition. The legacy path has
 * never filtered expired jobs (only the sitemap feed does), so adding an expiry
 * filter here would silently shrink every result count relative to today's
 * behaviour. That inconsistency is pre-existing and is preserved on purpose.
 */
export const buildJobFilter = (parsed = {}, resolved = {}) => {
  const filter = {};

  if (parsed.q) {
    const pattern = containsInsensitive(parsed.q);
    const targets = resolved.textTargets || {};
    const or = [{ title: pattern }, { seoKeywords: pattern }];

    if (targets.roleIds?.length) or.push({ role: { $in: targets.roleIds } });
    if (targets.industryIds?.length) or.push({ industry: { $in: targets.industryIds } });
    if (targets.companyIds?.length) or.push({ companyProfile: { $in: targets.companyIds } });

    filter.$or = or;
  }

  if (parsed.industry) {
    filter.industry = { $in: resolved.industry?.ids || [] };
  }

  if (parsed.role) {
    filter.role = { $in: resolved.role?.ids || [] };
  }

  if (parsed.company) {
    filter.companyProfile = { $in: resolved.company?.ids || [] };
  }

  if (parsed.location) {
    const cityName = resolved.location?.name || '';
    // location.city is an array of plain strings, so this is a multikey match:
    // a multi-city job matches on any one of its cities.
    filter['location.city'] = cityName ? { $in: [exactInsensitive(cityName)] } : { $in: [] };
  }

  if (parsed.experience) {
    // OVERLAP, not containment: a "1-3 years" job matches ?experience=2-5.
    filter.experienceMin = { $lte: parsed.experience.max };
    filter.experienceMax = { $gte: parsed.experience.min };
  }

  if (parsed.salary) {
    // Overlap again. Jobs whose salary could not be normalized have no
    // salaryNorm at all and are therefore excluded whenever this filter is
    // active — documented behaviour, not a bug.
    if (parsed.salary.max !== null && parsed.salary.max !== undefined) {
      filter['salaryNorm.min'] = { $lte: parsed.salary.max };
    }
    if (parsed.salary.min !== null && parsed.salary.min !== undefined) {
      filter['salaryNorm.max'] = { $gte: parsed.salary.min };
    }
  }

  if (parsed.qualification?.length) {
    const patterns = parsed.qualification.map(looseContains).filter(Boolean);
    // Partial (substring) matching is preserved deliberately — the current
    // client matcher does the same, and tightening it to exact equality would
    // change which jobs a live URL returns.
    filter.qualification = { $in: patterns };
  }

  if (parsed.jobType?.length) {
    const patterns = parsed.jobType.flatMap(
      (token) => JOB_TYPE_DB_PATTERNS[token] || [exactInsensitive(deSlug(token)), exactInsensitive(token)],
    );
    filter.jobType = { $in: patterns };
  }

  if (parsed.workMode) {
    filter.remoteWork = parsed.workMode;
  }

  if (parsed.skills?.length) {
    // OR semantics ($in, not $all) to match the current client behaviour, where
    // a job surfaces if ANY of its skills matches.
    filter.skills = { $in: resolved.skills?.ids || [] };
  }

  if (parsed.posted) {
    filter.createdAt = { $gte: parsed.posted };
  }

  filter.status = 'Published';

  return filter;
};

/**
 * `_id` is included as a tiebreaker so documents sharing a createdAt cannot
 * reshuffle between pages, which would drop or duplicate rows across a
 * paginated set. The compound indexes in models/jobs.model.js carry a matching
 * trailing _id key so this stays index-supported.
 */
export const buildSortSpec = (sort = DEFAULT_SORT) => {
  if (sort === 'oldest') return { createdAt: 1, _id: 1 };
  // 'relevance' aliases to 'latest' in this phase.
  return { createdAt: -1, _id: -1 };
};

export const buildPagination = (parsed = {}, total = 0) => {
  const limit = parsed.limit || DEFAULT_LIMIT;
  const page = parsed.page || 1;
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

  return {
    page,
    limit,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1 && totalPages > 0,
  };
};

/**
 * Echo of what the server actually resolved. Lets a client render
 * "Industry: Information Technology" from server truth instead of re-deriving
 * it, and makes an unresolvable value visible instead of silent.
 */
export const buildAppliedFilters = (parsed = {}, resolved = {}) => {
  const applied = {};

  if (parsed.q) applied.q = parsed.q;

  if (parsed.industry) {
    applied.industry = {
      requested: parsed.industry,
      resolved: resolved.industry?.items || [],
      matched: Boolean(resolved.industry?.matched),
    };
  }
  if (parsed.role) {
    applied.role = {
      requested: parsed.role,
      resolved: resolved.role?.items || [],
      matched: Boolean(resolved.role?.matched),
    };
  }
  if (parsed.company) {
    applied.company = {
      requested: parsed.company,
      resolved: resolved.company?.items || [],
      matched: Boolean(resolved.company?.matched),
    };
  }
  if (parsed.location) {
    applied.location = {
      requested: parsed.location,
      resolved: resolved.location?.name || '',
      matched: Boolean(resolved.location?.matched),
    };
  }
  if (parsed.skills?.length) {
    applied.skills = {
      requested: parsed.skills,
      resolved: resolved.skills?.items || [],
      matched: Boolean(resolved.skills?.matched),
    };
  }

  if (parsed.experience) applied.experience = parsed.experience;
  if (parsed.salary) applied.salary = parsed.salary;
  if (parsed.qualification?.length) applied.qualification = parsed.qualification;
  if (parsed.jobType?.length) applied.jobType = parsed.jobType;
  if (parsed.workMode) applied.workMode = parsed.workMode;
  if (parsed.posted) applied.posted = parsed.posted.toISOString();

  applied.sort = parsed.sort;

  return applied;
};
