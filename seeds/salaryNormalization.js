// seeds/salaryNormalization.js
// ---------------------------------------------------------------------------
// Backfills JobPost.salaryNorm { min, max, source } — INR per MONTH — from the
// structured `salary` sub-document when present, otherwise by parsing the
// free-text `offeredSalary` string. Uses utils/jobNormalization.js, the same
// module the model's pre-save hook uses, so a backfilled value is identical to
// one the model would have generated itself.
//
// WHY THIS EXISTS: ?salary=30000-50000 cannot be matched against strings like
// "15K - 18K /Month". Documents written before the Query Engine landed have no
// salaryNorm and would be invisible to the salary filter until this runs.
//
// SAFETY:
//   * DRY RUN BY DEFAULT. Nothing is written unless --apply is passed.
//   * Writes ONLY salaryNorm. The `salary` sub-document is READ, never written
//     — it feeds the Google JobPosting baseSalary on the frontend and must not
//     be altered by this phase.
//   * Uses updateOne with $set, so no model hook fires and no slug can move.
//   * Idempotent: re-running produces the same values and reports 0 changes.
//
// Usage:
//   npm run migrate:salary-norm              # dry run: report only, no writes
//   npm run migrate:salary-norm -- --apply   # real run
//   node seeds/salaryNormalization.js --apply --verbose
//
// Flags:
//   --apply     perform writes (omit for dry run)
//   --verbose   print every job's parsed mapping
// ---------------------------------------------------------------------------
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import connectToDatabase from '../database/mongodb.js';
import JobPost from '../models/jobs.model.js';
import { deriveSalaryNorm } from '../utils/jobNormalization.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const VERBOSE = args.includes('--verbose');

const BATCH_SIZE = 500;
const line = (char = '-') => console.log(char.repeat(78));

const migrateSalaryNorm = async () => {
  dotenv.config();
  await connectToDatabase();

  line('=');
  console.log(
    `Salary normalization — ${APPLY ? 'REAL RUN (writes enabled)' : 'DRY RUN (no writes)'}`,
  );
  console.log('Target: salaryNorm { min, max, source } in INR per MONTH');
  line('=');

  const jobs = await JobPost.find({})
    .select('_id offeredSalary salary salaryNorm')
    .sort({ createdAt: 1 })
    .lean();

  let parsed = 0;
  let fromStructured = 0;
  let fromText = 0;
  let unparseable = 0;
  let unchanged = 0;
  let pending = [];
  let written = 0;

  const unparseableSamples = new Map();

  const flush = async () => {
    if (!APPLY || !pending.length) {
      pending = [];
      return;
    }
    await JobPost.bulkWrite(pending, { ordered: false });
    written += pending.length;
    pending = [];
  };

  for (const job of jobs) {
    const norm = deriveSalaryNorm(job);

    if (!norm) {
      unparseable += 1;
      const key = String(job.offeredSalary || '(empty)').trim().toLowerCase();
      unparseableSamples.set(key, (unparseableSamples.get(key) || 0) + 1);
      continue;
    }

    parsed += 1;
    if (norm.source === 'structured') fromStructured += 1;
    else fromText += 1;

    const existing = job.salaryNorm;
    const alreadyCorrect =
      existing &&
      existing.min === norm.min &&
      existing.max === norm.max &&
      existing.source === norm.source;

    if (alreadyCorrect) {
      unchanged += 1;
      continue;
    }

    if (VERBOSE) {
      console.log(
        `  ${job._id}  "${job.offeredSalary}"  ->  ${norm.min} - ${norm.max} INR/month  (${norm.source})`,
      );
    }

    pending.push({
      updateOne: {
        filter: { _id: job._id },
        update: { $set: { salaryNorm: norm } },
      },
    });

    if (pending.length >= BATCH_SIZE) await flush();
  }

  await flush();

  const total = jobs.length;
  const coverage = total === 0 ? 0 : Math.round((parsed / total) * 10000) / 100;

  line('=');
  console.log(`Total job posts          : ${total}`);
  console.log(`Parsed successfully      : ${parsed}`);
  console.log(`  from salary sub-doc    : ${fromStructured}`);
  console.log(`  from offeredSalary text: ${fromText}`);
  console.log(`Already correct          : ${unchanged}`);
  console.log(`Needing write            : ${parsed - unchanged}`);
  console.log(`Unparseable (skipped)    : ${unparseable}`);
  console.log(`COVERAGE                 : ${coverage}%   ${coverage >= 95 ? '[OK]' : '[BELOW 95% GATE]'}`);
  console.log(`Documents written        : ${APPLY ? written : 0}${APPLY ? '' : '  (dry run)'}`);
  line('=');

  if (unparseableSamples.size) {
    console.log('Unparseable `offeredSalary` values (value -> count):');
    [...unparseableSamples.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .forEach(([value, count]) => console.log(`  ${count.toString().padStart(5)}  "${value}"`));
    console.log(
      '\n"Negotiable" and any string with no identifiable pay period parse to',
    );
    console.log('nothing BY DESIGN. Those jobs are EXCLUDED whenever ?salary= is active.');
    line('-');
  }

  if (!APPLY) {
    console.log('DRY RUN — nothing was written. Re-run with --apply to persist.');
  }

  await mongoose.connection.close();
};

migrateSalaryNorm()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Salary normalization failed:', error);
    process.exit(1);
  });
