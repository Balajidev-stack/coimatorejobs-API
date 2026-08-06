// utils/jobNormalization.js
// ---------------------------------------------------------------------------
// SINGLE SOURCE OF TRUTH for the derived, numeric filter fields on JobPost.
//
// JobPost.experience and JobPost.offeredSalary are free-text strings
// ("1-3 years", "15K - 18K /Month"). Range filtering (?experience=2-5,
// ?salary=30000-50000) cannot be expressed against free text in a Mongo query,
// so the model derives two numeric shapes on save:
//
//   experienceMin / experienceMax   years
//   salaryNorm { min, max, source } INR per MONTH
//
// Three producers must agree byte-for-byte on these values: the model pre-save
// hook, seeds/experienceNormalization.js and seeds/salaryNormalization.js.
// They all import from here. Do NOT re-implement this logic anywhere else —
// a second copy is how the database ends up holding values the model would
// never generate (same rule as utils/jobSlug.js).
//
// This module is intentionally free of mongoose/database imports so it stays
// pure and directly unit-testable.
//
// CONSERVATIVE BY DESIGN: when a value cannot be confidently parsed these
// functions return null and the caller leaves the derived field ABSENT. An
// absent field is excluded by a range filter, which is the documented and
// intended behaviour. Guessing would silently mis-file jobs into salary or
// experience bands they do not belong to.
// ---------------------------------------------------------------------------

// Sentinel upper bound for open-ended experience ("10+ years"). Chosen so that
// any realistic ?experience= upper bound overlaps it.
export const EXPERIENCE_OPEN_ENDED_MAX = 99;

// Google/Mongo-side pay periods we understand, and the factor that converts one
// unit of each into a MONTHLY amount.
//   WEEK : 52 weeks / 12 months
//   DAY  : 22 working days per month
//   HOUR : 8 hours x 22 working days
export const SALARY_UNITS = ['HOUR', 'DAY', 'WEEK', 'MONTH', 'YEAR'];

const MONTHLY_FACTOR = {
  HOUR: 176,
  DAY: 22,
  WEEK: 52 / 12,
  MONTH: 1,
  YEAR: 1 / 12,
};

const toPlainText = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return '';
};

const normalizeText = (value) => toPlainText(value).toLowerCase().replace(/\s+/g, ' ').trim();

const toFiniteNumber = (value) => {
  const number = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(number) ? number : null;
};

const round2 = (value) => Math.round(value * 100) / 100;

// ---------------------------------------------------------------------------
// EXPERIENCE
// ---------------------------------------------------------------------------

/**
 * Parses a job's free-text `experience` into a { min, max } range in YEARS.
 *
 * Handles the shapes the job form and legacy data actually produce:
 *   "Fresher" / "Entry Level" / "No experience"  -> { min: 0,  max: 1  }
 *   "Less than 1 year"                           -> { min: 0,  max: 1  }
 *   "1-3 years"                                  -> { min: 1,  max: 3  }
 *   "10+ years"                                  -> { min: 10, max: 99 }
 *   "2 years"                                    -> { min: 2,  max: 2  }
 *   "6 months"                                   -> { min: 0.5, max: 0.5 }
 *
 * Returns null when no number can be found and no fresher-family phrase matches.
 */
export const parseExperienceText = (value) => {
  const raw = normalizeText(value);
  if (!raw) return null;

  // Fresher family resolves to EXACTLY 0 years.
  //
  // max is 0, not 1, on purpose: with max=1 a "Freshers" job also satisfied
  // ?experience=1-3 (overlap needs experienceMax >= 1), so fresher roles leaked
  // into 1-3 year searches. Production data confirms "Freshers" is its own
  // distinct value (87 of 256 jobs) alongside a separate "0-1 Years" bucket,
  // so the two must not collapse onto the same range.
  if (/fresher|fresh graduate|no experience|entry[- ]level/.test(raw)) {
    return { min: 0, max: 0 };
  }
  if (/less than (1|a|one) year|under (1|a|one) year/.test(raw)) {
    return { min: 0, max: 1 };
  }

  const numbers = raw.match(/\d+(?:\.\d+)?/g);
  if (!numbers || !numbers.length) return null;

  const inMonths = /month/.test(raw);
  const toYears = (token) => {
    const number = toFiniteNumber(token);
    if (number === null) return null;
    return inMonths ? number / 12 : number;
  };

  const openEnded = /\+|plus|above|and above|more than|onwards|over/.test(raw);

  let min = toYears(numbers[0]);
  let max = numbers.length >= 2 ? toYears(numbers[1]) : (openEnded ? EXPERIENCE_OPEN_ENDED_MAX : min);

  if (min === null || max === null) return null;
  if (min < 0 || max < 0) return null;
  if (min > max) [min, max] = [max, min];

  return { min: round2(min), max: round2(max) };
};

/**
 * Derives { min, max } for a job document (or plain object).
 */
export const deriveExperienceRange = (job) => parseExperienceText(job?.experience);

// ---------------------------------------------------------------------------
// SALARY
// ---------------------------------------------------------------------------

// Plausibility bounds for a MONTHLY Indian salary, in INR.
//
// These exist because production data contains strings that parse cleanly but
// mean nothing, e.g. "20000 - 35000 LPA" (the author meant rupees, but LPA
// multiplies by 100000 -> Rs.16.6 crore/month) and "18500 Thousands - 25000
// Thousands" (-> Rs.1.85 crore/month). Publishing those would put absurd jobs
// into every high-salary filter result.
//
// Deliberately wide: Rs.1,000/month clears genuine entry-level stipends and
// Rs.10,00,000/month (Rs.1.2 crore/year) clears any real posting on this board.
export const MIN_PLAUSIBLE_MONTHLY_INR = 1000;
export const MAX_PLAUSIBLE_MONTHLY_INR = 1000000;

const buildMonthlyRange = (lowRaw, highRaw, multiplier, unit) => {
  const factor = MONTHLY_FACTOR[unit];
  if (!factor) return null;

  const low = Math.round(Math.min(lowRaw, highRaw) * multiplier * factor);
  const high = Math.round(Math.max(lowRaw, highRaw) * multiplier * factor);

  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  // A zero or negative bound means the source string was corrupt (the known
  // "0K" legacy case). Omit rather than publish a false band.
  if (low <= 0 || high <= 0) return null;

  // Corrupt-but-parseable source -> omit rather than publish a false band.
  if (low < MIN_PLAUSIBLE_MONTHLY_INR || high > MAX_PLAUSIBLE_MONTHLY_INR) return null;

  return { min: low, max: high };
};

/**
 * PREFERRED source: the optional structured `salary` sub-document, whose
 * min/max/currency/unit are already validated against the unit enum.
 *
 * Non-INR salaries return null: the ?salary= filter operates in INR and a
 * cross-currency comparison would silently mis-band the job.
 *
 * NOTE: this function READS the `salary` sub-document and never writes to it.
 * That field feeds the Google JobPosting baseSalary in the frontend's
 * structuredData.js — it must not be mutated by this phase.
 */
export const structuredSalaryToMonthly = (salary) => {
  if (!salary || typeof salary !== 'object') return null;

  const min = toFiniteNumber(salary.min);
  const max = toFiniteNumber(salary.max);
  if (min === null && max === null) return null;

  const low = min === null ? max : min;
  const high = max === null ? min : max;
  if (low === null || high === null) return null;

  const currency = String(salary.currency || 'INR').toUpperCase();
  if (currency !== 'INR') return null;

  const rawUnit = String(salary.unit || 'YEAR').toUpperCase();
  const unit = SALARY_UNITS.includes(rawUnit) ? rawUnit : 'YEAR';

  return buildMonthlyRange(low, high, 1, unit);
};

/**
 * FALLBACK source: parse the human-readable `offeredSalary` string into a
 * MONTHLY INR range.
 *
 * The employer form emits "<min>K - <max>K /Month" and "<min> - <max> LPA",
 * plus assorted legacy strings. The thousands multiplier is anchored to a
 * digit ("15k", "15 k") so a stray "k" cannot trigger it — the same anchoring
 * bug that was previously fixed in the frontend's JobPosting schema builder.
 *
 * When no pay period can be identified the salary is OMITTED rather than
 * guessed. "Negotiable" (no digits) therefore returns null.
 */
export const parseOfferedSalaryToMonthly = (value) => {
  const normalized = normalizeText(value);
  if (!normalized) return null;

  const numbers = normalized.match(/\d+(?:,\d+)*(?:\.\d+)?/g) || [];
  if (!numbers.length) return null;

  const low = toFiniteNumber(numbers[0]);
  const high = toFiniteNumber(numbers[1] ?? numbers[0]);
  if (low === null || high === null) return null;

  const isLakh = /lpa|lakh/.test(normalized);
  // "thousand(s)" is included because it is the second most common salary
  // format in production ("12 Thousands - 15 Thousands" — 73 of 256 job
  // documents). Without it those strings carry no recognisable pay period and
  // were rejected outright, capping salary coverage at 71.5%.
  const isThousand = /\d\s*k\b/.test(normalized) || /thousand/.test(normalized);

  let multiplier = 1;
  let unit = '';

  if (isLakh) {
    multiplier = 100000;
    unit = 'YEAR';
  } else if (isThousand) {
    multiplier = 1000;
  }

  if (!unit) {
    if (/month|monthly|\bpm\b/.test(normalized)) unit = 'MONTH';
    else if (/year|yearly|annual|annum|\bpa\b/.test(normalized)) unit = 'YEAR';
    else if (/week/.test(normalized)) unit = 'WEEK';
    else if (/\bday\b|daily/.test(normalized)) unit = 'DAY';
    else if (/hour|hourly/.test(normalized)) unit = 'HOUR';
  }

  // A thousands-denominated figure with no stated period is monthly in this
  // dataset ("12 Thousands - 15 Thousands" is Rs.12,000-15,000 per month; the
  // annual reading would be far below minimum wage).
  if (!unit && isThousand) unit = 'MONTH';

  // No identifiable pay period -> omit rather than invent one.
  if (!unit) return null;

  return buildMonthlyRange(low, high, multiplier, unit);
};

/**
 * The pay period detected in a free-text salary string — FOR AUDIT ONLY.
 *
 * Written to the migration rollback report so a human can see how each raw
 * value was interpreted. Deliberately NOT written to salaryNorm.source: that
 * field records PROVENANCE ('structured' | 'parsed') and is constrained by an
 * enum in models/jobs.model.js. See the note on deriveSalaryNorm.
 */
export const detectSalaryPeriod = (value) => {
  const normalized = normalizeText(value);
  if (!normalized) return '';
  if (/lpa|lakh/.test(normalized)) return 'annual';
  if (/month|monthly|\bpm\b/.test(normalized)) return 'monthly';
  if (/year|yearly|annual|annum|\bpa\b/.test(normalized)) return 'annual';
  if (/week/.test(normalized)) return 'weekly';
  if (/\bday\b|daily/.test(normalized)) return 'daily';
  if (/hour|hourly/.test(normalized)) return 'hourly';
  if (/\d\s*k\b|thousand/.test(normalized)) return 'monthly';
  return '';
};

/**
 * Derives the `salaryNorm` sub-document for a job.
 * Structured sub-document first, free-text second. `source` records which one
 * won so backfill coverage can be audited per provenance.
 */
export const deriveSalaryNorm = (job) => {
  const structured = structuredSalaryToMonthly(job?.salary);
  if (structured) return { ...structured, source: 'structured' };

  const parsed = parseOfferedSalaryToMonthly(job?.offeredSalary);
  if (parsed) return { ...parsed, source: 'parsed' };

  return null;
};
