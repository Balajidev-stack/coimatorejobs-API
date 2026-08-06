// seeds/experienceNormalization.js
// ---------------------------------------------------------------------------
// Backfills JobPost.experienceMin / experienceMax (YEARS) from the free-text
// `experience` field, using utils/jobNormalization.js — the same parser the
// model's pre-save hook uses, so a backfilled value is identical to one the
// model would have generated itself.
//
// WHY THIS EXISTS: ?experience=2-5 cannot be matched against strings like
// "1-3 years". The model derives these numbers on every save from now on, but
// documents written BEFORE the Query Engine landed have no derived values and
// would be invisible to the experience filter until this runs.
//
// SAFETY:
//   * DRY RUN BY DEFAULT. Nothing is written unless --apply is passed.
//   * Writes ONLY experienceMin and experienceMax. No other field is touched.
//   * Uses updateOne with $set, so no model hook fires and no slug can move.
//   * Idempotent: re-running produces the same values and reports 0 changes.
//
// Usage:
//   npm run migrate:experience              # dry run: report only, no writes
//   npm run migrate:experience -- --apply   # real run
//   node seeds/experienceNormalization.js --apply --verbose
//
// Flags:
//   --apply     perform writes (omit for dry run)
//   --verbose   print every job's parsed mapping
// ---------------------------------------------------------------------------
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import connectToDatabase from '../database/mongodb.js';
import JobPost from '../models/jobs.model.js';
import { parseExperienceText } from '../utils/jobNormalization.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const VERBOSE = args.includes('--verbose');

const BATCH_SIZE = 500;
const line = (char = '-') => console.log(char.repeat(78));

const migrateExperience = async () => {
  dotenv.config();
  await connectToDatabase();

  line('=');
  console.log(
    `Experience normalization — ${APPLY ? 'REAL RUN (writes enabled)' : 'DRY RUN (no writes)'}`,
  );
  console.log('Target: experienceMin / experienceMax (years), derived from `experience`');
  line('=');

  const jobs = await JobPost.find({})
    .select('_id experience experienceMin experienceMax')
    .sort({ createdAt: 1 })
    .lean();

  let parsed = 0;
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
    const range = parseExperienceText(job.experience);

    if (!range) {
      unparseable += 1;
      const key = String(job.experience || '(empty)').trim().toLowerCase();
      unparseableSamples.set(key, (unparseableSamples.get(key) || 0) + 1);
      continue;
    }

    parsed += 1;

    const alreadyCorrect =
      job.experienceMin === range.min && job.experienceMax === range.max;

    if (alreadyCorrect) {
      unchanged += 1;
      continue;
    }

    if (VERBOSE) {
      console.log(
        `  ${job._id}  "${job.experience}"  ->  ${range.min} - ${range.max} years`,
      );
    }

    pending.push({
      updateOne: {
        filter: { _id: job._id },
        update: { $set: { experienceMin: range.min, experienceMax: range.max } },
      },
    });

    if (pending.length >= BATCH_SIZE) await flush();
  }

  await flush();

  const total = jobs.length;
  const coverage = total === 0 ? 0 : Math.round((parsed / total) * 10000) / 100;

  line('=');
  console.log(`Total job posts        : ${total}`);
  console.log(`Parsed successfully    : ${parsed}`);
  console.log(`Already correct        : ${unchanged}`);
  console.log(`Needing write          : ${parsed - unchanged}`);
  console.log(`Unparseable (skipped)  : ${unparseable}`);
  console.log(`COVERAGE               : ${coverage}%   ${coverage >= 95 ? '[OK]' : '[BELOW 95% GATE]'}`);
  console.log(`Documents written      : ${APPLY ? written : 0}${APPLY ? '' : '  (dry run)'}`);
  line('=');

  if (unparseableSamples.size) {
    console.log('Unparseable `experience` values (value -> count):');
    [...unparseableSamples.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .forEach(([value, count]) => console.log(`  ${count.toString().padStart(5)}  "${value}"`));
    console.log(
      '\nThese jobs are EXCLUDED whenever ?experience= is active. That is the',
    );
    console.log('documented contract — review the list before accepting it.');
    line('-');
  }

  if (!APPLY) {
    console.log('DRY RUN — nothing was written. Re-run with --apply to persist.');
  }

  await mongoose.connection.close();
};

migrateExperience()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Experience normalization failed:', error);
    process.exit(1);
  });
