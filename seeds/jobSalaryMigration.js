// seeds/jobSalaryMigration.js
// One-off, idempotent migration: best-effort backfill of the structured
// `salary` sub-document from the legacy free-text `offeredSalary` string.
//
// Rules:
//   - Only touches jobs that do NOT already have a structured `salary`
//     (so re-runs are safe and manually-set salaries are never overwritten).
//   - Parsing is best-effort. When the string cannot be parsed confidently
//     (e.g. "Negotiable"), the job is skipped and `salary` stays undefined —
//     never write incorrect values.
//   - Uses updateOne($set), which does NOT trigger the findOneAndUpdate slug
//     hook, so slugs remain stable.
import dotenv from 'dotenv';
import connectToDatabase from '../database/mongodb.js';
import JobPost from '../models/jobs.model.js';

const LAKH = 100000;
const ALLOWED_UNITS = ['HOUR', 'DAY', 'WEEK', 'MONTH', 'YEAR'];

// Best-effort parse of a legacy offeredSalary string into { min, max, currency, unit }.
// Returns undefined when nothing usable can be derived.
const parseSalaryString = (raw) => {
  if (!raw || typeof raw !== 'string') return undefined;

  const text = raw.toLowerCase().trim();
  if (!text || text.includes('negotiable') || text.includes('disclosed')) return undefined;

  const nums = (text.match(/\d+(?:\.\d+)?/g) || [])
    .map(Number)
    .filter((n) => !Number.isNaN(n));
  if (nums.length === 0) return undefined;

  // Lakhs-per-annum is the dominant local convention; detect it explicitly.
  const isLPA = /lpa|lakh|lac|per annum|p\.?a\.?|\/\s*year|per year/.test(text);
  const isMonthly = /month|\/\s*mo|\bpm\b|per month/.test(text);
  const isHourly = /hour|\/\s*hr|\bph\b|per hour/.test(text);

  const multiplier = isLPA ? LAKH : 1;
  let unit = 'YEAR';
  if (isHourly) unit = 'HOUR';
  else if (isMonthly) unit = 'MONTH';
  if (!ALLOWED_UNITS.includes(unit)) unit = 'YEAR';

  let min;
  let max;

  if (nums.length >= 2) {
    min = nums[0] * multiplier;
    max = nums[1] * multiplier;
  } else {
    const single = nums[0] * multiplier;
    if (/<|below|under|up\s*to|upto|max/.test(text)) {
      max = single;
    } else if (/\+|above|over|min|more than|starting|onwards/.test(text)) {
      min = single;
    } else {
      min = single;
      max = single;
    }
  }

  if (min !== undefined && max !== undefined && min > max) {
    [min, max] = [max, min];
  }

  const result = { currency: 'INR', unit };
  if (min !== undefined) result.min = min;
  if (max !== undefined) result.max = max;

  if (result.min === undefined && result.max === undefined) return undefined;
  return result;
};

const migrateJobSalaries = async () => {
  dotenv.config();
  await connectToDatabase();

  // Idempotent: only consider jobs without a structured salary yet.
  const jobs = await JobPost.find({
    $or: [{ salary: { $exists: false } }, { salary: null }],
  }).select('_id offeredSalary salary');

  let updated = 0;
  let skipped = 0;

  for (const job of jobs) {
    const parsed = parseSalaryString(job.offeredSalary);

    if (!parsed) {
      skipped += 1;
      continue;
    }

    await JobPost.updateOne({ _id: job._id }, { $set: { salary: parsed } });
    updated += 1;
    console.log(
      `Updated job ${job._id}: "${job.offeredSalary}" -> ${JSON.stringify(parsed)}`
    );
  }

  console.log(
    `Salary migration completed. Updated: ${updated}, skipped (unparseable): ${skipped}, scanned: ${jobs.length}`
  );
  process.exit();
};

migrateJobSalaries().catch((err) => {
  console.error('Job salary migration failed:', err);
  process.exit(1);
});
