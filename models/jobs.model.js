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

const jobPostSchema = new mongoose.Schema({
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

// ------------------ SLUG GENERATOR ------------------
// Format: title-company-city (falls back to title-city if company name is unavailable)
const slugifyPart = (value) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

function generateSlug(title, companyName, cities) {
  const titleSlug = slugifyPart(title);
  const companySlug = slugifyPart(companyName);

  let citySlug = "india";
  if (Array.isArray(cities) && cities.length > 0) {
    citySlug = slugifyPart(cities.join("-"));
  } else if (typeof cities === "string") {
    citySlug = slugifyPart(cities);
  }

  const parts = [titleSlug, companySlug, citySlug].filter(Boolean);
  return parts.join("-");
}

// Appends -2, -3, ... until the slug is unique (excluding the document being saved)
async function ensureUniqueSlug(baseSlug, excludeId) {
  let candidate = baseSlug;
  let index = 2;
  while (
    await JobPost.exists({
      slug: candidate,
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    })
  ) {
    candidate = `${baseSlug}-${index}`;
    index += 1;
  }
  return candidate;
}

async function resolveCompanyName(companyProfileId) {
  if (!companyProfileId) return null;
  const company = await CompanyProfile.findById(companyProfileId).select('companyName');
  return company?.companyName || null;
}

// Auto-generate slug and seoKeywords on save
jobPostSchema.pre("save", async function (next) {
  try {

    // ---------- SLUG ----------
    if (
      this.isModified("title") ||
      this.isModified("location.city") ||
      this.isModified("companyProfile") ||
      !this.slug
    ) {
      const companyName = await resolveCompanyName(this.companyProfile);
      const baseSlug = generateSlug(this.title, companyName, this.location?.city);
      this.slug = await ensureUniqueSlug(baseSlug, this._id);
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

    const cityChanged =
      update?.location?.city !== undefined ||
      update?.["location.city"] !== undefined;
    const titleChanged = update?.title !== undefined;

    // Only regenerate the slug when the fields it's derived from actually change.
    // companyProfile is fixed at job creation, so it never changes here.
    if (titleChanged || cityChanged || !existing.slug) {
      const title = update.title || existing.title;
      const city =
        update?.location?.city ||
        update?.["location.city"] ||
        existing.location?.city;

      const companyName = await resolveCompanyName(existing.companyProfile);
      const baseSlug = generateSlug(title, companyName, city);
      update.slug = await ensureUniqueSlug(baseSlug, existing._id);

      this.setUpdate(update);
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

    const alerts = await JobAlert.find({ isActive: true }).populate('candidate', 'email');
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

const JobPost = mongoose.model('JobPost', jobPostSchema);

export default JobPost;

