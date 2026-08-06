// seeds/experienceNormalization.js
// ---------------------------------------------------------------------------
// ONE-TIME PRODUCTION DATA MIGRATION — experience normalization.
//
// Populates experienceMin / experienceMax (YEARS) on existing JobPost documents
// from the free-text `experience` field, so the query engine can serve
// ?experience=<min>-<max> as an indexed numeric range.
//
// Standalone. Nothing in the application imports this file, and it must never
// be wired into the app lifecycle.
//
// ---------------------------------------------------------------------------
// SAFETY CONTRACT
// ---------------------------------------------------------------------------
//   * DRY RUN BY DEFAULT. Writes only with --apply.
//   * Touches ONLY experienceMin and experienceMax. Nothing else — not title,
//     company, slug, description, SEO fields, or the source `experience` value.
//   * NEVER overwrites: only documents where experienceMin does not already
//     exist are considered, so re-running cannot clobber corrected data and the
//     job is resumable if interrupted.
//   * timestamps: false on every bulk operation, so createdAt/updatedAt are NOT
//     touched. Mongoose would otherwise stamp updatedAt on each updateOne.
//   * updateOne + $set only — no model hooks fire, so no slug can move and no
//     job-alert email can be triggered.
//   * Writes a rollback report BEFORE applying.
//
// Parsing lives in utils/jobNormalization.js — the same module the model's
// pre-save hook uses, so a migrated value is identical to one the application
// would generate itself. Do not re-implement it here.
//
// Usage:
//   node seeds/experienceNormalization.js --dry-run
//   node seeds/experienceNormalization.js --apply
//   node seeds/experienceNormalization.js --apply --verbose
// ---------------------------------------------------------------------------
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import connectToDatabase from '../database/mongodb.js';
import JobPost from '../models/jobs.model.js';
import { parseExperienceText } from '../utils/jobNormalization.js';

dotenv.config();

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const VERBOSE = args.includes('--verbose');

const BATCH_SIZE = 500;
const REPORT_PATH = path.resolve(process.cwd(), 'migration-report-experience.json');

const line = (char = '-') => console.log(char.repeat(78));

const migrate = async () => {
  const startedAt = Date.now();
  await connectToDatabase();

  line('=');
  console.log(`Experience normalization — ${APPLY ? 'APPLY (writes enabled)' : 'DRY RUN (no writes)'}`);
  console.log('Fields written: experienceMin, experienceMax  (nothing else)');
  line('=');

  const totalJobs = await JobPost.countDocuments({});

  // "Never overwrite": already-migrated documents are excluded by the query,
  // which also makes the run resumable.
  const alreadyMigrated = await JobPost.countDocuments({
    experienceMin: { $exists: true, $ne: null },
  });

  const candidates = await JobPost.find({ experienceMin: { $exists: false } })
    .select('_id experience experienceMin experienceMax')
    .sort({ createdAt: 1 })
    .lean();

  let updated = 0;
  let parseErrors = 0;
  let written = 0;
  let pending = [];

  const rollback = [];
  const errorSamples = new Map();

  const flush = async () => {
    if (!APPLY || !pending.length) {
      pending = [];
      return;
    }
    await JobPost.bulkWrite(pending, { ordered: false });
    written += pending.length;
    pending = [];
  };

  for (const job of candidates) {
    const range = parseExperienceText(job.experience);

    if (!range) {
      parseErrors += 1;
      const key = String(job.experience ?? '(missing)').trim() || '(empty)';
      errorSamples.set(key, (errorSamples.get(key) || 0) + 1);
      if (VERBOSE) console.log(`  [parse-error] ${job._id}  ${JSON.stringify(job.experience)}`);
      continue;
    }

    updated += 1;

    rollback.push({
      documentId: String(job._id),
      source: { experience: job.experience ?? null },
      oldValues: { experienceMin: null, experienceMax: null },
      newValues: { experienceMin: range.min, experienceMax: range.max },
    });

    if (!APPLY || VERBOSE) {
      console.log(
        `  ${job._id}  old=${JSON.stringify(job.experience)}  ->  new=${range.min}-${range.max}  WOULD UPDATE`,
      );
    }

    pending.push({
      updateOne: {
        filter: { _id: job._id },
        update: { $set: { experienceMin: range.min, experienceMax: range.max } },
        // Do not touch updatedAt — the migration must be invisible in timestamps.
        timestamps: false,
      },
    });

    if (pending.length >= BATCH_SIZE) await flush();
  }

  await flush();

  // Rollback report is written in BOTH modes: in dry run it is the preview, in
  // apply mode it is the undo record.
  fs.writeFileSync(
    REPORT_PATH,
    JSON.stringify(
      {
        migration: 'experienceNormalization',
        mode: APPLY ? 'apply' : 'dry-run',
        generatedAt: new Date().toISOString(),
        fieldsWritten: ['experienceMin', 'experienceMax'],
        totalJobs,
        documentCount: rollback.length,
        documents: rollback,
      },
      null,
      2,
    ),
    'utf8',
  );

  const skipped = totalJobs - alreadyMigrated - updated - parseErrors;
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);

  line('=');
  console.log('REPORT');
  line('-');
  console.log(`Total Jobs        : ${totalJobs}`);
  console.log(`Updated           : ${updated}${APPLY ? '' : '  (would update)'}`);
  console.log(`Skipped           : ${skipped < 0 ? 0 : skipped}`);
  console.log(`Already Migrated  : ${alreadyMigrated}`);
  console.log(`Parse Errors      : ${parseErrors}`);
  console.log(`Documents Written : ${APPLY ? written : 0}`);
  console.log(`Execution Time    : ${elapsed}s`);
  const coverage =
    totalJobs === 0 ? 0 : Math.round(((alreadyMigrated + updated) / totalJobs) * 10000) / 100;
  console.log(`Coverage          : ${coverage}%  ${coverage >= 95 ? '[OK]' : '[BELOW 95% GATE]'}`);
  line('=');
  console.log(`Rollback report   : ${REPORT_PATH}`);

  if (errorSamples.size) {
    line('-');
    console.log('Unparseable `experience` values (value -> count):');
    [...errorSamples.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([value, count]) => console.log(`  ${String(count).padStart(5)}  ${JSON.stringify(value)}`));
    console.log('\nThese jobs are EXCLUDED whenever ?experience= is active.');
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing was written. Re-run with --apply to persist.');
  }

  await mongoose.connection.close();
};

migrate()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Experience normalization FAILED:', error);
    process.exit(1);
  });
