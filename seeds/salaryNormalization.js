// seeds/salaryNormalization.js
// ---------------------------------------------------------------------------
// ONE-TIME PRODUCTION DATA MIGRATION — salary normalization.
//
// Populates salaryNorm { min, max, source } on existing JobPost documents so
// the query engine can serve ?salary=<min>-<max> as an indexed numeric range.
//
// Standalone. Nothing in the application imports this file.
//
// ---------------------------------------------------------------------------
// UNITS: salaryNorm.min / .max are INR PER MONTH. ALWAYS.
// ---------------------------------------------------------------------------
// Every source format is converted to a monthly figure — "5 LPA" is stored as
// 41667, not 500000.
//
// This is not a stylistic choice. utils/jobQueryFilter.js resolves
// ?salary=30000-50000 by comparing against salaryNorm.min/max as MONTHLY rupees
// (Phase 1). Storing an annual figure would make a 5 LPA job invisible to
// "30k-50k" (its true monthly pay) and instead match "1,00,000+", which is
// wrong in both directions.
//
// ---------------------------------------------------------------------------
// salaryNorm.source is PROVENANCE, not a pay period.
// ---------------------------------------------------------------------------
// Allowed values are 'structured' (taken from the optional `salary` sub-document
// the employer form can populate) and 'parsed' (derived from the free-text
// offeredSalary string). That enum is declared on salaryNormSchema in
// models/jobs.model.js.
//
// Writing a pay period ('monthly' / 'annual') there would violate the enum. A
// bulkWrite $set bypasses validators so the write itself would succeed — but the
// next time an employer edits that job, doc.save() validates the whole document
// and throws a ValidationError, breaking job editing for every migrated job.
//
// The detected pay period IS captured, per document, in the rollback report, so
// nothing is lost for auditing.
//
// ---------------------------------------------------------------------------
// SAFETY CONTRACT
// ---------------------------------------------------------------------------
//   * DRY RUN BY DEFAULT. Writes only with --apply.
//   * Touches ONLY salaryNorm. The source fields `offeredSalary` and `salary`
//     are READ, never written — `salary` feeds the Google JobPosting baseSalary.
//   * NEVER overwrites: only documents without salaryNorm are considered.
//   * timestamps: false on every bulk operation — createdAt/updatedAt untouched.
//   * updateOne + $set only — no model hooks fire.
//   * Writes a rollback report BEFORE applying.
//   * "Negotiable", empty strings and implausible values are SKIPPED, not
//     guessed. A skipped job is simply excluded while ?salary= is active.
//
// Usage:
//   node seeds/salaryNormalization.js --dry-run
//   node seeds/salaryNormalization.js --apply
//   node seeds/salaryNormalization.js --apply --verbose
// ---------------------------------------------------------------------------
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import connectToDatabase from '../database/mongodb.js';
import JobPost from '../models/jobs.model.js';
import { deriveSalaryNorm, detectSalaryPeriod } from '../utils/jobNormalization.js';

dotenv.config();

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const VERBOSE = args.includes('--verbose');

const BATCH_SIZE = 500;
const REPORT_PATH = path.resolve(process.cwd(), 'migration-report-salary.json');

const line = (char = '-') => console.log(char.repeat(78));

const migrate = async () => {
  const startedAt = Date.now();
  await connectToDatabase();

  line('=');
  console.log(`Salary normalization — ${APPLY ? 'APPLY (writes enabled)' : 'DRY RUN (no writes)'}`);
  console.log('Fields written: salaryNorm { min, max, source }  (nothing else)');
  console.log('Units: INR per MONTH. source = provenance (structured | parsed).');
  line('=');

  const totalJobs = await JobPost.countDocuments({});
  const alreadyMigrated = await JobPost.countDocuments({
    salaryNorm: { $exists: true, $ne: null },
  });

  const candidates = await JobPost.find({ salaryNorm: { $exists: false } })
    .select('_id offeredSalary salary salaryNorm')
    .sort({ createdAt: 1 })
    .lean();

  let updated = 0;
  let fromStructured = 0;
  let fromText = 0;
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
    const norm = deriveSalaryNorm(job);

    if (!norm) {
      parseErrors += 1;
      const key = String(job.offeredSalary ?? '(missing)').trim() || '(empty)';
      errorSamples.set(key, (errorSamples.get(key) || 0) + 1);
      if (VERBOSE) console.log(`  [skip] ${job._id}  ${JSON.stringify(job.offeredSalary)}`);
      continue;
    }

    updated += 1;
    if (norm.source === 'structured') fromStructured += 1;
    else fromText += 1;

    rollback.push({
      documentId: String(job._id),
      source: {
        offeredSalary: job.offeredSalary ?? null,
        salary: job.salary ?? null,
        detectedPeriod: detectSalaryPeriod(job.offeredSalary), // audit only
      },
      oldValues: { salaryNorm: null },
      newValues: { salaryNorm: { min: norm.min, max: norm.max, source: norm.source } },
    });

    if (!APPLY || VERBOSE) {
      console.log(
        `  ${job._id}  old=${JSON.stringify(job.offeredSalary)}  ->  new=${norm.min}-${norm.max} INR/month (${norm.source})  WOULD UPDATE`,
      );
    }

    pending.push({
      updateOne: {
        filter: { _id: job._id },
        update: { $set: { salaryNorm: { min: norm.min, max: norm.max, source: norm.source } } },
        timestamps: false,
      },
    });

    if (pending.length >= BATCH_SIZE) await flush();
  }

  await flush();

  fs.writeFileSync(
    REPORT_PATH,
    JSON.stringify(
      {
        migration: 'salaryNormalization',
        mode: APPLY ? 'apply' : 'dry-run',
        generatedAt: new Date().toISOString(),
        units: 'INR per month',
        fieldsWritten: ['salaryNorm'],
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
  console.log(`Total Jobs         : ${totalJobs}`);
  console.log(`Updated            : ${updated}${APPLY ? '' : '  (would update)'}`);
  console.log(`  from salary sub-doc : ${fromStructured}`);
  console.log(`  from offeredSalary  : ${fromText}`);
  console.log(`Skipped            : ${skipped < 0 ? 0 : skipped}`);
  console.log(`Already Migrated   : ${alreadyMigrated}`);
  console.log(`Parse Errors       : ${parseErrors}`);
  console.log(`Documents Written  : ${APPLY ? written : 0}`);
  console.log(`Execution Time     : ${elapsed}s`);
  const coverage =
    totalJobs === 0 ? 0 : Math.round(((alreadyMigrated + updated) / totalJobs) * 10000) / 100;
  console.log(`Coverage           : ${coverage}%  ${coverage >= 95 ? '[OK]' : '[BELOW 95% GATE]'}`);
  line('=');
  console.log(`Rollback report    : ${REPORT_PATH}`);

  if (errorSamples.size) {
    line('-');
    console.log('Skipped `offeredSalary` values (value -> count):');
    [...errorSamples.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([value, count]) => console.log(`  ${String(count).padStart(5)}  ${JSON.stringify(value)}`));
    console.log('\n"Negotiable", blank values and implausible figures are skipped BY DESIGN.');
    console.log('Those jobs are EXCLUDED whenever ?salary= is active.');
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing was written. Re-run with --apply to persist.');
  }

  await mongoose.connection.close();
};

migrate()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Salary normalization FAILED:', error);
    process.exit(1);
  });
