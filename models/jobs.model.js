// model/jobs.model.js
import mongoose from 'mongoose';
import JobAlert from './jobAlert.model.js';
import FunctionalArea from './functionalArea.model.js';
import Industry from './industry.model.js';
import Role from './role.model.js';
import Skill from './skill.model.js';
import RoleSuggestion from './roleSuggestion.model.js';
import CompanyProfile from './companyProfile.model.js';
import { sendJobAlertEmail } from '../utils/mailer.js';
import { createNotification, notificationPresets } from '../utils/notificationHelper.js';
import { sendPushToUsers } from '../utils/fcm.js';
import { buildCanonicalJobSlug } from '../utils/jobSlug.js';
import { deriveExperienceRange, deriveSalaryNorm } from '../utils/jobNormalization.js';

export const COLLAR_CATEGORIES = [
  'Blue Collar',
  'White Collar',
  'Black Collar',
  'Grey Collar',
  'Pink Collar',
  'Gold Collar',
  'Green Collar',
  'Red Collar',
];

// Optional structured salary sub-document (Google JobPosting baseSalary source).
// `_id: false` + `default: undefined` on the parent path ensure the sub-document
// (and its currency/unit defaults) is only materialized when salary is actually
// provided, so existing records and salary-less job creation are unaffected.
const salarySchema = new mongoose.Schema({
  min: { type: Number, min: 0 },
  max: { type: Number, min: 0 },
  currency: { type: String, trim: true, uppercase: true, default: 'INR' },
  unit: {
    type: String,
    enum: ['HOUR', 'DAY', 'WEEK', 'MONTH', 'YEAR'],
    default: 'YEAR',
  },
}, { _id: false });

// DERIVED, QUERY-ONLY salary shape — normalized to INR per MONTH.
//
// This is NOT a replacement for `salary` above and never overwrites it.
// `salary` is employer-entered and feeds the Google JobPosting baseSalary;
// `salaryNorm` is machine-derived (utils/jobNormalization.js) purely so the
// ?salary=<min>-<max> filter can run as an indexed numeric range instead of
// parsing free text at query time.
//
// `source` records which input won ('structured' = the salary sub-document,
// 'parsed' = the offeredSalary string) so backfill coverage can be audited.
const salaryNormSchema = new mongoose.Schema({
  min: { type: Number, min: 0 },
  max: { type: Number, min: 0 },
  source: { type: String, enum: ['structured', 'parsed'] },
}, { _id: false });

const jobPostSchema = new mongoose.Schema({
  jobId: {
    type: String,
    unique: true,
    sparse: true,
    trim: true,
    uppercase: true
  },
  employer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Employer is required'],
  },
  companyProfile: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CompanyProfile',
    required: [true, 'Company profile is required'],
  },
  title: {
    type: String,
    required: [true, 'Job title is required'],
    trim: true,
  },
  description: {
    type: String,
    required: [true, 'Job description is required'],
    trim: true,
  },
  contactEmail: {
    type: String,
    required: [true, 'Contact email is required'],
    trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email address'],
  },
  contactUsername: {
    type: String,
    trim: true,
  },
  // specialisms: {
  //   type: [String],
  //   required: [true, 'At least one specialism is required'],
  // },
  jobType: {
    type: String,
    required: [true, 'Job type is required'],
    // enum: ['Full-time', 'Part-time', 'Contract', 'Freelance', 'Internship', 'Temporary'],
  },
  offeredSalary: {
    type: String,
    required: [true, 'Offered salary is required'],
    // enum: ['< ?5 LPA', '?5-10 LPA', '?10-15 LPA', '?15-20 LPA', '?20-30 LPA', '?30+ LPA', 'Negotiable'],
  },
  // Optional structured salary (coexists with the human-readable offeredSalary).
  salary: {
    type: salarySchema,
    default: undefined,
  },
  careerLevel: {
    type: String,
    required: [true, 'Career level is required'],
    // enum: ['Entry Level', 'Intermediate', 'Mid Level', 'Senior Level', 'Executive'],
  },
  experience: {
    type: String,
    required: [true, 'Experience is required'],
    // enum: ['Fresher', '1-3 years', '3-5 years', '5-10 years', '10+ years'],
  },

  // ----------------------- DERIVED FILTER FIELDS -----------------------
  // Machine-derived from `experience` / `offeredSalary` / `salary` by
  // utils/jobNormalization.js. They exist ONLY so the query engine can run
  // ?experience= and ?salary= as indexed numeric ranges — free-text strings
  // cannot be range-matched in a Mongo query.
  //
  // All three are optional with `default: undefined`, so existing documents
  // are untouched until the backfill migrations run and no existing read path
  // observes any change. A value that cannot be confidently parsed is left
  // ABSENT, which excludes the job from a range filter — deliberate, and
  // documented in the API contract.
  //
  // Units: experienceMin/Max in YEARS, salaryNorm in INR per MONTH.
  // Open-ended experience ("10+ years") stores max = 99 (EXPERIENCE_OPEN_ENDED_MAX).
  experienceMin: {
    type: Number,
    default: undefined,
  },
  experienceMax: {
    type: Number,
    default: undefined,
  },
  salaryNorm: {
    type: salaryNormSchema,
    default: undefined,
  },
  // ---------------------------------------------------------------------
  gender: {
    type: String,
    // enum: ['Male', 'Female', 'Other', 'No Preference'],
    default: 'No Preference',
  },
  // industry: {
  //   type: String,
  //   required: [true, 'Industry is required'],
  //   trim: true,
  // },
    // New fields for better categorization
  functionalAreas: {
    type: [mongoose.Schema.Types.ObjectId],
    ref: 'FunctionalArea',
    required: [true, 'At least one functional area is required'],
  },
  industry: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Industry',
    required: [true, 'Industry is required'],
  },
  role: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Role',
    default: null,
  },
  collarCategory: {
    type: String,
    required: [true, 'Collar category is required'],
    enum: COLLAR_CATEGORIES,
    trim: true,
  },
  skills: {
    type: [mongoose.Schema.Types.ObjectId],
    ref: 'Skill',
    default: [],
  },
  seoKeywords: {
    type: [String],
    default: [],
  },
  slug: {
    type: String,
    unique: true,
    sparse: true, // Allow null before first save
    trim: true,
    index: true,
  },

  qualification: {
    type: [String],
    required: [true, 'Qualification is required'],
    // enum: [ '10th', '12th', 'Diploma', 'Bachelor', 'Master', 'Doctorate', 'Other' ],
  },
  applicationDeadline: {
    type: Date,
    required: [true, 'Application deadline is required'],
  },
  positions: {
    total: {
      type: Number,
      required: [true, 'Number of positions is required'],
      min: 1,
    },
    remaining: {
      type: Number,
      // default: 0,
      default: function() { return this.total; },
    },
  },
  applicantCount: {
    type: Number,
    default: 0,
  },
  // Added maxApplicants field
  maxApplicants: {
    type: Number,
    default: null, // null means unlimited
  },
  location: {
    country: {
      type: String,
      required: [true, 'Country is required'],
      trim: true,
    },
    city: [{  // <-- Notice the Brackets [] making it an array
      type: String,
      required: [true, 'City is required'],
      trim: true,
    }],
    completeAddress: {
      type: String,
      required: [true, 'Complete address is required'],
      trim: true,
    },
  },
  remoteWork: {
    // Added for 2025 trend: remote work options
    type: String,
    // enum: ['On-site', 'Hybrid', 'Remote'],
    default: 'On-site',
  },
  status: {
    type: String,
    enum: ['Draft', 'Published', 'Closed'],
    default: 'Published',
  },
  candidateSelectionSource: {
    type: String,
    enum: ['unknown', 'coimbatorejobs', 'external', 'not_selected'],
    default: 'unknown',
  },
  candidateSelectionSourceUpdatedAt: {
    type: Date,
    default: null,
  },
  candidateSelectionSourceUpdatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  closedAt: {
    type: Date,
    default: null,
  },
  closedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  closedByRole: {
    type: String,
    enum: ['employer', 'hr-admin', 'superadmin', 'system', null],
    default: null,
  },
  // for trending jobs
  profileViews: { type: Number, default: 0 },
  dailyViews: [{
    date: String,
    count: { type: Number, default: 0 },
    unique: { type: Number, default: 0 } // optional: track unique daily
  }],
  uniqueViewers: [{
    viewer: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    lastViewed: { type: Date, default: Date.now }
  }],

  // for the new hr-admin role fix
  postedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    default: function() { return this.employer; } // fallback for old data
  }

}, { timestamps: true });

// Auto-generate slug and seoKeywords on save (pull from all levels: industry, functionalAreas, role, skills)
// old slug/seo generation logic is commented out below for reference, but the new logic is more robust and handles more edge cases (2026-03-06)
// jobPostSchema.pre('save', async function (next) {
//   if (this.isModified('title') || this.isModified('location.city') || !this.slug) {
//     const baseSlug = this.title
//       .toLowerCase()
//       .replace(/[^a-z0-9]+/g, '-')
//       .replace(/^-+|-+$/g, '');

//     // this.slug = `${baseSlug}-${this.location.city.toLowerCase()}-${this._id}`;
//     const citySlug = Array.isArray(this.location.city) ? this.location.city[0].toLowerCase() : this.location.city?.toLowerCase();

//     this.slug = `${baseSlug}-${citySlug}-${this._id}`;
//   }

//   if (!this.seoKeywords || this.seoKeywords.length === 0) {
//     const areas = await FunctionalArea.find({ _id: { $in: this.functionalAreas } });
//     const industry = await Industry.findById(this.industry);
//     const role = await Role.findById(this.role);
//     const skills = await Skill.find({ _id: { $in: this.skills } });
//     const cityName = Array.isArray(this.location.city) ? this.location.city[0].toLowerCase() : this.location.city?.toLowerCase();

//     this.seoKeywords = [
//       ...new Set([
//         ...areas.flatMap(a => a.keywords || []),
//         ...(industry?.keywords || []),
//         ...(role?.keywords || []),
//         ...skills.flatMap(s => s.keywords || []),
//         role?.name?.toLowerCase(),
//         `${role?.name?.toLowerCase()} jobs`,
//         `${role?.name?.toLowerCase()} jobs in ${cityName}`
//         // `${role?.name?.toLowerCase()} jobs in ${this.location.city.toLowerCase()}`
//       ])
//     ];
//   }

//   next();
// });

// ------------------ SLUG GENERATION ------------------
// Canonical format: {job-title}-jobs-in-{primary-city}-{company-name}
//
// All slug string logic lives in utils/jobSlug.js — the single source of truth
// shared with the migration and any future seed script. This model contributes
// only the database-backed pieces: resolving the company name and answering
// "is this slug already taken?".

// Uniqueness predicate for buildCanonicalJobSlug: a candidate is taken when any
// OTHER JobPost already holds it (the document being saved is excluded so a
// re-save never bumps its own slug to -2).
const makeSlugTakenCheck = (excludeId) => async (candidate) =>
  Boolean(
    await JobPost.exists({
      slug: candidate,
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    })
  );

async function resolveCompanyName(companyProfileId) {
  if (!companyProfileId) return null;
  const company = await CompanyProfile.findById(companyProfileId).select('companyName');
  return company?.companyName || null;
}

// Auto-generate slug and seoKeywords on save
jobPostSchema.pre("save", async function (next) {
  try {

    // ---------- SLUG ----------
    // Canonical slugs are IMMUTABLE after creation to preserve permanent SEO URLs
    // (Rule 7). Only generate when the document has no slug yet (new jobs, or
    // legacy docs that predate slug generation). Ordinary edits to
    // title/location/company must NOT regenerate an existing slug. Reformatting
    // existing slugs is the migration's job, never a save's side effect.
    if (!this.slug) {
      const companyName = await resolveCompanyName(this.companyProfile);
      const generated = await buildCanonicalJobSlug(
        { title: this.title, companyName, city: this.location?.city },
        makeSlugTakenCheck(this._id)
      );
      // Leave slug unset when no title is available rather than storing a
      // meaningless slug — the sparse unique index permits absent slugs.
      if (generated) this.slug = generated;
    }

    // ---------- SEO KEYWORDS ----------
    if (
      !this.seoKeywords ||
      this.isModified("industry") ||
      this.isModified("role") ||
      this.isModified("skills") ||
      this.isModified("functionalAreas")
    ) {

      const areas = await FunctionalArea.find({
        _id: { $in: this.functionalAreas || [] }
      });

      const industry = this.industry
        ? await Industry.findById(this.industry)
        : null;

      const role = this.role
        ? await Role.findById(this.role)
        : null;

      const skills = await Skill.find({
        _id: { $in: this.skills || [] }
      });

      const cityName = Array.isArray(this.location?.city)
        ? this.location.city[0]?.toLowerCase()
        : this.location?.city?.toLowerCase() || "india";

      this.seoKeywords = [
        ...new Set([
          ...areas.flatMap(a => a.keywords || []),
          ...(industry?.keywords || []),
          ...(role?.keywords || []),
          ...skills.flatMap(s => s.keywords || []),

          role?.name?.toLowerCase(),

          `${role?.name?.toLowerCase()} jobs`,
          `${role?.name?.toLowerCase()} jobs in ${cityName}`
        ])
      ];
    }

    // ---------- DERIVED FILTER FIELDS ----------
    // Deliberately LAST, deliberately in its OWN try/catch, and deliberately
    // never touching this.slug.
    //
    // The post('save') hooks below send job-alert emails, in-app notifications
    // and FCM pushes. A throw anywhere in this pre-save hook aborts the save
    // entirely — no job created and no alerts delivered. Derivation is a
    // convenience for filtering, never a reason to fail a write, so any parse
    // failure degrades to "field absent" and the save proceeds.
    try {
      if (this.isNew || this.isModified('experience')) {
        const range = deriveExperienceRange(this);
        if (range) {
          this.experienceMin = range.min;
          this.experienceMax = range.max;
        } else {
          this.experienceMin = undefined;
          this.experienceMax = undefined;
        }
      }

      if (this.isNew || this.isModified('offeredSalary') || this.isModified('salary')) {
        const norm = deriveSalaryNorm(this);
        this.salaryNorm = norm || undefined;
      }
    } catch (derivationError) {
      console.error('Derived filter field generation skipped:', derivationError?.message || derivationError);
    }

    next();

  } catch (err) {
    console.error("Slug/SEO generation error:", err);
    next(err);
  }
});

jobPostSchema.pre("findOneAndUpdate", async function (next) {
  try {

    const update = this.getUpdate();
    const existing = await this.model.findOne(this.getQuery());

    if (!existing) return next();

    // Canonical slugs are IMMUTABLE after creation (Rule 7). Never regenerate an
    // existing slug when title/location/company are edited — this keeps permanent
    // SEO URLs stable. Only backfill a slug for legacy docs that don't have one.
    if (!existing.slug) {
      const title = update?.title || update?.$set?.title || existing.title;
      const city =
        update?.location?.city ||
        update?.["location.city"] ||
        update?.$set?.["location.city"] ||
        update?.$set?.location?.city ||
        existing.location?.city;

      const companyName = await resolveCompanyName(existing.companyProfile);
      const generated = await buildCanonicalJobSlug(
        { title, companyName, city },
        makeSlugTakenCheck(existing._id)
      );

      if (generated) {
        // The update may arrive as `{ $set: {...} }` (how updateJobPost calls
        // this) or as a plain object. Write into whichever shape is in use so the
        // result never mixes operators with top-level paths.
        if (update && update.$set) update.$set.slug = generated;
        else update.slug = generated;
        this.setUpdate(update);
      }
    }

    // ---------- DERIVED FILTER FIELDS (update path) ----------
    // Keeps experienceMin/Max and salaryNorm in step when an employer edits
    // experience or salary through updateJobPost (which uses findOneAndUpdate
    // and therefore never runs the pre('save') hook above).
    //
    // Own try/catch for the same reason as the save path: a parse failure must
    // never fail an employer's job edit.
    try {
      const nextUpdate = this.getUpdate() || {};
      const $set = nextUpdate.$set || {};
      const pick = (field) => ($set[field] !== undefined ? $set[field] : nextUpdate[field]);

      const experienceChanged = pick('experience') !== undefined;
      const salaryChanged =
        pick('offeredSalary') !== undefined || pick('salary') !== undefined;

      // Also backfill when the derived fields are simply missing on a legacy
      // document, so an ordinary edit heals it without a migration re-run.
      const needsExperienceBackfill =
        existing.experienceMin === undefined || existing.experienceMin === null;
      const needsSalaryBackfill = !existing.salaryNorm;

      const writeDerived = (field, value) => {
        if (nextUpdate.$set) nextUpdate.$set[field] = value;
        else nextUpdate[field] = value;
      };

      let touched = false;

      if (experienceChanged || needsExperienceBackfill) {
        const range = deriveExperienceRange({
          experience: pick('experience') ?? existing.experience,
        });
        if (range) {
          writeDerived('experienceMin', range.min);
          writeDerived('experienceMax', range.max);
          touched = true;
        }
      }

      if (salaryChanged || needsSalaryBackfill) {
        const norm = deriveSalaryNorm({
          offeredSalary: pick('offeredSalary') ?? existing.offeredSalary,
          salary: pick('salary') ?? existing.salary,
        });
        if (norm) {
          writeDerived('salaryNorm', norm);
          touched = true;
        }
      }

      if (touched) this.setUpdate(nextUpdate);
    } catch (derivationError) {
      console.error('Derived filter field update skipped:', derivationError?.message || derivationError);
    }

    next();

  } catch (err) {
    console.error("Slug update error:", err);
    next(err);
  }
});


/**
 * Mongoose post-save hook for JobPost.
 * Triggers job alert notifications if a new published job matches any alert criteria.
 */
jobPostSchema.post('save', async function (doc) {
  try {
    if (doc.status !== 'Published') return;

    // Populate company name
    const populatedDoc = await mongoose.model('JobPost')
      .findById(doc._id)
      .populate('companyProfile', 'companyName')
      .populate('functionalAreas', 'name')
      .populate('industry', 'name')
      .populate('role', 'name')
      .populate('skills', 'name');

    const alerts = await JobAlert.find({ isActive: true }).populate('candidate', '_id email');
    console.log('Found job alerts:', alerts);
    
    for (const alert of alerts) {
      if (!alert.candidate?.email) continue;

      const matches = matchJobToAlert(populatedDoc, alert.criteria);
      if (matches && alert.candidate.email) {
        await sendJobAlertEmail({
          recipient: alert.candidate.email,
          jobTitle: populatedDoc.title,
          companyName: populatedDoc.companyProfile.companyName,
          jobId: populatedDoc._id,
        });

        const notificationPayload = {
          ...notificationPresets.jobAlert(populatedDoc.title, populatedDoc.companyProfile.companyName),
          jobPost: populatedDoc._id,
          actionUrl: `/job/${populatedDoc._id}`,
        };

        await createNotification(alert.candidate._id, 'job_alert', notificationPayload);
        await sendPushToUsers([alert.candidate._id], {
          title: notificationPayload.title,
          body: notificationPayload.description,
          link: `${process.env.FRONTEND_URL}${notificationPayload.actionUrl}`,
          data: {
            type: 'job_alert',
            jobPostId: populatedDoc._id,
            alertId: alert._id,
            actionUrl: notificationPayload.actionUrl,
          },
        });
      }
    }
  } catch (err) {
    console.error('Error in jobPost save hook:', err);
  }
});

// Post-save hook to suggest new roles based on job postings
jobPostSchema.post('save', async function (doc) {
  try {
    const normalized = doc.title
      .toLowerCase()
      .replace(/\b(senior|junior|night|shift|male|female)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const existingRole = await Role.findOne({
      name: new RegExp(`^${normalized}$`, 'i')
    });

    if (existingRole) return;

    const suggestion = await RoleSuggestion.findOneAndUpdate(
      { normalizedTitle: normalized },
      {
        $setOnInsert: {
          title: doc.title,
          normalizedTitle: normalized,
        },
        $inc: { count: 1 },
        $set: { lastSeen: new Date() }
      },
      { upsert: true, new: true }
    );

    if (suggestion?.count === 20) {
      console.log(`Role "${doc.title}" reached 20 postings - suggest admin review`);
    }
  } catch (err) {
    console.error('Role suggestion hook failed:', err?.message || err);
  }
});
/**
 * Determines if a job post matches the alert criteria.
 * @param {Object} job - The job post document
 * @param {Object} criteria - The alert criteria
 * @returns {boolean} - True if the job matches the alert criteria
 */
function matchJobToAlert(job, criteria) {

  // Updated to use new fields
  if (criteria.functionalAreas?.length > 0 &&
      !criteria.functionalAreas.some(id => job.functionalAreas.some(fa => fa._id.toString() === id.toString()))) {
    return false;
  }

  if (criteria.industry && job.industry?._id.toString() !== criteria.industry) return false;

  if (criteria.role && job.role?._id.toString() !== criteria.role) return false;

  if (criteria.skills?.length > 0 &&
      !criteria.skills.some(id => job.skills.some(s => s._id.toString() === id.toString()))) {
    return false;
  }

  // old criteria field - commented out
  // if (criteria.categories?.length > 0 &&
  //     !criteria.categories.some(cat => job.specialisms.includes(cat))) return false;

  if (criteria.location?.city) {
    const alertCities = Array.isArray(criteria.location.city)
      ? criteria.location.city.map((city) => String(city).toLowerCase())
      : [String(criteria.location.city).toLowerCase()];

    const jobCities = Array.isArray(job.location?.city)
      ? job.location.city.map((city) => String(city).toLowerCase())
      : [String(job.location?.city || '').toLowerCase()];

    const hasCityMatch = alertCities.some((city) => jobCities.includes(city));
    if (!hasCityMatch) return false;
  }

  if (criteria.salaryRange && job.offeredSalary !== 'Negotiable') {
    // Improved parse: handle ? and ranges like '?5-10 LPA'
    let minSalary = 0;
    const match = job.offeredSalary.match(/(\d+)(?:-(\d+))?/);
    if (match) minSalary = parseInt(match[1]) * 100000; // LPA to absolute
    if (minSalary < criteria.salaryRange.min || (criteria.salaryRange.max && minSalary > criteria.salaryRange.max)) {
      return false;
    }
  }

  // commented out old salary range matching for now
  // if (criteria.salaryRange && job.offeredSalary !== 'Negotiable') {
  //   const jobSalary = parseFloat(job.offeredSalary.replace('$', '')) || 0;
  //   if (jobSalary < criteria.salaryRange.min ||
  //       (criteria.salaryRange.max && jobSalary > criteria.salaryRange.max)) return false;
  // }

  if (criteria.jobType && criteria.jobType !== job.jobType) return false;
  if (criteria.experience && criteria.experience !== job.experience) return false;

  if (criteria.keywords?.length > 0) {
    const text = `${job.title} ${job.description}`.toLowerCase();
    if (!criteria.keywords.some(kw => text.includes(kw.toLowerCase()))) return false;
  }

  // commented out old keyword matching for now
  // if (criteria.keywords?.length > 0 &&
  //     !criteria.keywords.some(kw => job.title.includes(kw) || job.description.includes(kw))) return false;

  return true;
}

jobPostSchema.index({ industry: 1 });
jobPostSchema.index({ functionalAreas: 1 });
jobPostSchema.index({ role: 1 });
jobPostSchema.index({ 'location.city': 1 });
jobPostSchema.index({ skills: 1 });
jobPostSchema.index({ "uniqueViewers.viewer": 1 });

// ------------------- QUERY ENGINE INDEXES (additive) -------------------
// Every index below is NEW. None of the six above is dropped or altered.
//
// Nothing was previously indexed on `status`, which was tolerable while the
// listing endpoint returned the whole collection unsorted-by-index. Once the
// query engine adds skip/limit + an explicit sort, an unindexed sort becomes a
// hard failure: MongoDB aborts in-memory sorts above 32 MB.
//
// The trailing `_id: -1` is deliberate. The query engine sorts by
// { createdAt: -1, _id: -1 } so that ties cannot reshuffle between pages
// (which would drop or duplicate rows across a paginated set). Including _id
// as an explicit index key keeps that full sort index-supported. Mongo can
// walk these indexes in reverse to satisfy the { createdAt: 1, _id: 1 }
// ordering used by sort=oldest, so one index serves both directions.
jobPostSchema.index({ status: 1, createdAt: -1, _id: -1 });
jobPostSchema.index({ status: 1, 'location.city': 1, createdAt: -1, _id: -1 });
jobPostSchema.index({ status: 1, industry: 1, createdAt: -1, _id: -1 });
jobPostSchema.index({ status: 1, role: 1, createdAt: -1, _id: -1 });
// `companyProfile` had no index of any kind before this line.
jobPostSchema.index({ status: 1, companyProfile: 1, createdAt: -1, _id: -1 });
jobPostSchema.index({ status: 1, skills: 1, createdAt: -1, _id: -1 });
jobPostSchema.index({ status: 1, experienceMin: 1, experienceMax: 1 });
jobPostSchema.index({ status: 1, 'salaryNorm.min': 1, 'salaryNorm.max': 1 });
// -----------------------------------------------------------------------

const JobPost = mongoose.model('JobPost', jobPostSchema);

export default JobPost;

