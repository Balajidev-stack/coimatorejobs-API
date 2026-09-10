import mongoose from "mongoose";
import JobPost from '../models/jobs.model.js';
import CompanyProfile from '../models/companyProfile.model.js';
import User from '../models/user.model.js';
import Role from '../models/role.model.js';
import Location from '../models/location.model.js';
import Skill from '../models/skill.model.js';
import Industry from '../models/industry.model.js';
import FunctionalArea from '../models/functionalArea.model.js';
import EmployerResumeDownloadLog from '../models/employerResumeDownloadLog.model.js';
import { sendSuperadminAlertEmail, sendEmployerJobPostedEmail } from '../utils/mailer.js';
import { SUPERADMIN_EMAIL } from '../config/env.js';
import { createNotification, notificationPresets } from '../utils/notificationHelper.js';
import { sendPushToUsers } from '../utils/fcm.js';
import { ForbiddenError, BadRequestError, NotFoundError } from "../utils/errors.js";
import { isValidEmailAddress, normalizeEmail } from "../utils/emailValidation.js";
import { COLLAR_CATEGORIES } from '../models/jobs.model.js';
import { buildPublicJobPath, buildPublicJobUrl } from '../utils/jobSlug.js';
import {
  isPubliclyIndexable,
  notifyJobPublished,
  notifyJobWithdrawal,
} from '../utils/googleIndexing.js';
import {
  getEmployerResumeDownloadUsage,
  getFeatureLimit,
  requireEmployerJobPostLimit,
  resolveEmployerPlan,
} from '../utils/employerPlanAccess.js';
import crypto from 'crypto';

const jobsController = {};
const MONTHLY_RESUME_LIMIT = 5;
const JOB_ID_PREFIX = "JOB";
const INTERNAL_EMPLOYER_EMAIL_REGEX = /^employer_.*_@internal\.coimbatorejobs\.in$/i;

const buildJobId = () =>
  `${JOB_ID_PREFIX}-${crypto.randomInt(10000000, 100000000)}`;

const generateUniqueJobId = async (session = null) => {
  let candidate = buildJobId();

  while (await JobPost.exists({ jobId: candidate }).session(session)) {
    candidate = buildJobId();
  }

  return candidate;
};

const ensureJobId = async (job, session = null) => {
  if (!job) return job;

  const currentJobId = String(job.jobId || "").trim().toUpperCase();
  if (currentJobId) return job;

  job.jobId = await generateUniqueJobId(session);
  if (typeof job.save === "function") {
    await job.save({ session, validateBeforeSave: false });
  } else if (job._id) {
    await JobPost.updateOne(
      { _id: job._id, $or: [{ jobId: { $exists: false } }, { jobId: "" }, { jobId: null }] },
      { $set: { jobId: job.jobId } },
      { session }
    );
  }

  return job;
};

const ensureJobIds = async (jobs = []) => {
  for (const job of jobs) {
    await ensureJobId(job);
  }
  return jobs;
};

const isRealEmail = (value = '') => {
  const email = normalizeEmail(value);
  return (
    email &&
    isValidEmailAddress(email) &&
    !email.endsWith('@internal.coimbatorejobs.in') &&
    !INTERNAL_EMPLOYER_EMAIL_REGEX.test(email)
  );
};

const addRealEmail = (recipients, value) => {
  const email = normalizeEmail(value);
  if (isRealEmail(email)) recipients.add(email);
};

const buildPublicJobLink = (job) => {
  const frontendBaseUrl = String(process.env.FRONTEND_URL || 'https://coimbatorejobs.in').trim().replace(/\/+$/, '');
  const publicId = job?.slug || job?._id;
  return `${frontendBaseUrl}/job/${publicId}`;
};

const buildEmailJobDetails = (job) => ({
  jobType: job?.jobType,
  experience: job?.experience,
  offeredSalary: job?.offeredSalary,
  industry: job?.industry?.name,
  functionalArea: Array.isArray(job?.functionalAreas)
    ? job.functionalAreas.map((area) => area?.name).filter(Boolean)
    : undefined,
  role: job?.role?.name,
  location: Array.isArray(job?.location?.city)
    ? job.location.city.join(', ')
    : job?.location?.city,
  positions: job?.positions?.total,
  applicationDeadline: job?.applicationDeadline,
});

const getIstMonthKey = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
  }).format(new Date());

const toSafeString = (value) => String(value ?? '').trim();
const slugifyValue = (value) =>
  toSafeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const createUniqueSlug = async (Model, baseValue) => {
  const base = slugifyValue(baseValue) || `custom-${Date.now()}`;
  let candidate = base;
  let index = 1;
  while (await Model.exists({ slug: candidate })) {
    candidate = `${base}-${index}`;
    index += 1;
  }
  return candidate;
};

const applyCurrentRoleCollarCategory = (job) => {
  if (!job) return job;
  const plainJob = typeof job.toObject === 'function' ? job.toObject() : { ...job };
  const roleDefaultCollar = plainJob?.role?.defaultCollarCategory || '';

  return {
    ...plainJob,
    collarCategory: roleDefaultCollar || plainJob.collarCategory || '',
  };
};

const SALARY_UNITS = ['HOUR', 'DAY', 'WEEK', 'MONTH', 'YEAR'];

// Validates and normalizes an optional structured salary payload.
// Returns `undefined` when no usable salary (no min/max) is supplied so the
// stored document stays salary-less; throws BadRequestError on invalid input.
const normalizeSalaryInput = (salary) => {
  if (salary === undefined || salary === null || salary === '') return undefined;
  if (typeof salary !== 'object' || Array.isArray(salary)) {
    throw new BadRequestError('salary must be an object with min/max/currency/unit');
  }

  const result = {};

  const parseAmount = (value, label) => {
    if (value === undefined || value === null || value === '') return undefined;
    const num = Number(value);
    if (Number.isNaN(num) || num < 0) {
      throw new BadRequestError(`salary.${label} must be a non-negative number`);
    }
    return num;
  };

  const min = parseAmount(salary.min, 'min');
  const max = parseAmount(salary.max, 'max');

  // No numeric bounds => treat as no structured salary (keep legacy behavior).
  if (min === undefined && max === undefined) return undefined;

  if (min !== undefined && max !== undefined && min > max) {
    throw new BadRequestError('salary.min must be less than or equal to salary.max');
  }

  if (min !== undefined) result.min = min;
  if (max !== undefined) result.max = max;

  result.currency = salary.currency
    ? String(salary.currency).trim().toUpperCase()
    : 'INR';

  const unit = salary.unit ? String(salary.unit).trim().toUpperCase() : 'YEAR';
  if (!SALARY_UNITS.includes(unit)) {
    throw new BadRequestError(`salary.unit must be one of: ${SALARY_UNITS.join(', ')}`);
  }
  result.unit = unit;

  return result;
};

// Maps the free-text jobType to Google JobPosting `employmentType` enum values.
const EMPLOYMENT_TYPE_MAP = {
  fulltime: 'FULL_TIME',
  parttime: 'PART_TIME',
  contract: 'CONTRACTOR',
  contractor: 'CONTRACTOR',
  freelance: 'CONTRACTOR',
  internship: 'INTERN',
  intern: 'INTERN',
  temporary: 'TEMPORARY',
};

// Derives normalized, SEO-friendly fields (Google JobPosting) from existing job
// data. Purely additive and read-only — no stored data or schema is changed.
// Fields resolve to `undefined` when unavailable so they are omitted from JSON.
const buildJobPostingSeoFields = (job) => {
  if (!job) return {};

  const employmentKey = String(job.jobType || '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  const employmentType = EMPLOYMENT_TYPE_MAP[employmentKey];

  const jobLocationType =
    String(job.remoteWork || '').toLowerCase() === 'remote'
      ? 'TELECOMMUTE'
      : undefined;

  const cityValue = Array.isArray(job.location?.city)
    ? job.location.city[0]
    : job.location?.city;
  const addressLocality = cityValue ? String(cityValue).trim() : undefined;

  const educationRequirements =
    Array.isArray(job.qualification) && job.qualification.length > 0
      ? job.qualification
      : undefined;

  const experienceRequirements = job.experience || undefined;

  return {
    ...(employmentType ? { employmentType } : {}),
    ...(jobLocationType ? { jobLocationType } : {}),
    ...(addressLocality ? { addressLocality } : {}),
    ...(educationRequirements ? { educationRequirements } : {}),
    ...(experienceRequirements ? { experienceRequirements } : {}),
  };
};

const resolveIndustryId = async (industryValue) => {
  const normalized = toSafeString(industryValue);
  if (!normalized) throw new BadRequestError('Invalid or missing industry');

  if (mongoose.Types.ObjectId.isValid(normalized)) {
    const found = await Industry.findById(normalized).select('_id');
    if (found) return found._id;
  }

  const regex = new RegExp(`^${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  const existing = await Industry.findOne({ name: regex }).select('_id');
  if (existing) return existing._id;

  const slug = await createUniqueSlug(Industry, normalized);
  const created = await Industry.create({ name: normalized, slug, isActive: true });
  return created._id;
};

const resolveFunctionalAreaIds = async (functionalAreasInput, industryId) => {
  if (!Array.isArray(functionalAreasInput) || functionalAreasInput.length === 0) {
    throw new BadRequestError('functionalAreas required (array)');
  }

  const ids = [];
  for (const area of functionalAreasInput) {
    const value = toSafeString(area);
    if (!value) continue;

    if (mongoose.Types.ObjectId.isValid(value)) {
      const found = await FunctionalArea.findById(value).select('_id');
      if (found) {
        ids.push(found._id);
        continue;
      }
    }

    const regex = new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    let existing = await FunctionalArea.findOne({ name: regex, industry: industryId }).select('_id');
    if (!existing) {
      existing = await FunctionalArea.findOne({ name: regex, isGlobal: true }).select('_id');
    }
    if (!existing) {
      // Fallback: name is globally unique in DB (name_1 unique index),
      // so reuse any existing same-name functional area regardless of industry.
      existing = await FunctionalArea.findOne({ name: regex }).select('_id');
    }

    if (existing) {
      ids.push(existing._id);
      continue;
    }

    try {
      const slug = await createUniqueSlug(FunctionalArea, value);
      const created = await FunctionalArea.create({
        name: value,
        slug,
        industry: industryId,
        isGlobal: false,
        isActive: true,
      });
      ids.push(created._id);
    } catch (error) {
      // Handle race/parallel requests creating same functional area name.
      if (error?.code === 11000) {
        const duplicate = await FunctionalArea.findOne({ name: regex }).select('_id');
        if (duplicate) {
          ids.push(duplicate._id);
          continue;
        }
      }
      throw error;
    }
  }

  const uniqueIds = Array.from(new Set(ids.map((id) => String(id))));
  if (!uniqueIds.length) {
    throw new BadRequestError('functionalAreas required (array)');
  }
  return uniqueIds;
};

const resolveRoleId = async (roleValue, functionalAreaIds, actorId = null, collarCategory = null) => {
  const normalized = toSafeString(roleValue);
  if (!normalized) return null;

  if (mongoose.Types.ObjectId.isValid(normalized)) {
    const found = await Role.findById(normalized).select('_id');
    if (found) return found._id;
  }

  const primaryFaId = functionalAreaIds?.[0];
  if (!primaryFaId) return null;

  const regex = new RegExp(`^${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  const existing = await Role.findOne({ name: regex, functionalArea: primaryFaId }).select('_id');
  if (existing) return existing._id;

  const slug = await createUniqueSlug(Role, normalized);
  const created = await Role.create({
    name: normalized,
    slug,
    functionalArea: primaryFaId,
    isGlobal: false,
    isActive: true,
    isCustom: true,
    createdBy: actorId,
    defaultCollarCategory: collarCategory || null,
  });
  return created._id;
};

const resolveSkillIds = async (skillsInput = []) => {
  if (!Array.isArray(skillsInput) || skillsInput.length === 0) return [];
  const ids = [];

  for (const skill of skillsInput) {
    const value = toSafeString(skill);
    if (!value) continue;

    if (mongoose.Types.ObjectId.isValid(value)) {
      const found = await Skill.findById(value).select('_id');
      if (found) {
        ids.push(found._id);
        continue;
      }
    }

    const regex = new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    const existing = await Skill.findOne({ name: regex }).select('_id');
    if (existing) {
      ids.push(existing._id);
      continue;
    }

    const slug = await createUniqueSlug(Skill, value);
    const created = await Skill.create({ name: value, slug, isActive: true });
    ids.push(created._id);
  }

  return Array.from(new Set(ids.map((id) => String(id))));
};

const getAdminAlertUsers = async () => {
  const recipientEmails = new Set();

  if (SUPERADMIN_EMAIL) {
    recipientEmails.add(String(SUPERADMIN_EMAIL).trim().toLowerCase());
  }

  const adminUsers = await User.find({
    isActive: true,
    $or: [
      { role: 'hr-admin', status: 'approved' },
      { role: 'superadmin' },
      ...(SUPERADMIN_EMAIL ? [{ email: String(SUPERADMIN_EMAIL).trim().toLowerCase() }] : []),
    ],
  }).select('_id name email role');

  adminUsers.forEach((admin) => {
    if (admin?.email) {
      recipientEmails.add(String(admin.email).trim().toLowerCase());
    }
  });

  return {
    emails: Array.from(recipientEmails),
    users: adminUsers,
  };
};

/**
 * Creates a new job post for an authenticated employer
 * @param {Object} req - Request object containing job post data
 * @param {Object} res - Response object to send back the result
 * @param {Function} next - Next middleware function
 */
jobsController.createJobPost = async (req, res, next) => {
  try {

    // Extract employer ID from authenticated user
    const { id: loggedInUserId, role: userRole } = req.user;

    /**
     * Resolve employerId & companyProfile
     * -----------------------------------
     * employer     → own company only
     * hr-admin     → must pass employerId
     * superadmin   → must pass employerId
     */

    let employerId = loggedInUserId;

    // For hr-admin and superadmin, employerId must be provided in body
    if (['hr-admin', 'superadmin'].includes(userRole)) {
      if (!req.body.employerId) {
        throw new BadRequestError('employerId is required for HR-Admin or Superadmin');
      }
      employerId = req.body.employerId;
    }

    if (!mongoose.Types.ObjectId.isValid(employerId)) {
      throw new BadRequestError('Invalid employerId');
    }

    const canPostByPlan = await requireEmployerJobPostLimit(req, res, employerId);
    if (!canPostByPlan) return;

    /**
     * Validate company profile
     */
    const companyProfileDoc = await CompanyProfile.findOne({ employer: employerId });
    if (!companyProfileDoc) {
      throw new NotFoundError('Company profile not found for this employer, Please create a company profile first.');
    }

    if (companyProfileDoc.status !== 'approved') {
      throw new ForbiddenError('Company profile must be approved before posting jobs');
    }

    const {
      title,
      description,
      contactEmail,
      contactUsername,
      // specialisms,
      jobType,
      offeredSalary,
      salary, // optional structured salary { min, max, currency, unit }
      careerLevel,
      experience,
      gender,
      industry,
      qualification,
      applicationDeadline,
      location,
      remoteWork,
      positions,
      maxApplicants,
      companyProfile, // Added to allow explicit selection if needed
      role, // singular ID
      collarCategory,
      skills = [],
      functionalAreas = [], // required array of IDs
    } = req.body;

    // Validate required fields
    const requiredFields = [
      'title', 'description', 'contactEmail', 'jobType',
      'offeredSalary', 'careerLevel', 'experience', 'qualification',
      'applicationDeadline', 'positions', 'location', 'functionalAreas', 'collarCategory'
    ];
    const missingFields = requiredFields.filter(field => !req.body[field]);
    if (missingFields.length > 0) {
      throw new BadRequestError(`Missing required fields: ${missingFields.join(', ')}`);
    }

    // Respect the requested lifecycle status (the post-job forms offer Draft /
    // Published / Closed); omitting it keeps the historical default, Published.
    // Validated here, before taxonomy resolution, which can create master records.
    const allowedStatuses = JobPost.schema.path('status').enumValues;
    const requestedStatus =
      req.body.status === undefined || req.body.status === null || req.body.status === ''
        ? 'Published'
        : String(req.body.status);
    if (!allowedStatuses.includes(requestedStatus)) {
      throw new BadRequestError(`status must be one of: ${allowedStatuses.join(', ')}`);
    }

    const normalizedContactEmail = normalizeEmail(contactEmail);
    if (!isValidEmailAddress(normalizedContactEmail)) {
      throw new BadRequestError('Please enter a valid contact email address');
    }

    // console.log("Creating job post with data:", req.body);

    if (!Array.isArray(qualification) || qualification.length === 0) {
      throw new BadRequestError('At least one qualification is required (must be an array)');
    }

   // Validate location object (Ensuring city is an array and not empty)
    if ( !location || !location.country || !Array.isArray(location.city) || location.city.length === 0 || !location.completeAddress) {
      throw new BadRequestError(
        'Complete location details are required (country, at least one city, completeAddress)'
      );
    }

    // commented out old specialism  for now
    // Validate specialisms
    // if (!Array.isArray(specialisms) || specialisms.length === 0) {
    //   throw new BadRequestError('At least one specialism is required');
    // }

    const resolvedIndustryId = await resolveIndustryId(industry);
    const resolvedFunctionalAreaIds = await resolveFunctionalAreaIds(functionalAreas, resolvedIndustryId);
    const resolvedRoleId = await resolveRoleId(role, resolvedFunctionalAreaIds, req.user.id, collarCategory);
    const resolvedSkillIds = await resolveSkillIds(skills);

    if (!COLLAR_CATEGORIES.includes(collarCategory)) {
      throw new BadRequestError('Invalid collar category');
    }

   if (!positions || !positions.total || Number(positions.total) < 1) {
      throw new BadRequestError('Positions must be at least 1');
    }

    // Optional structured salary (validated; undefined when not usable)
    const normalizedSalary = normalizeSalaryInput(salary);


    // Validate companyProfile if provided explicitly
    if (companyProfile && !mongoose.Types.ObjectId.isValid(companyProfile)) {
      throw new BadRequestError('Invalid companyProfile ID');
    }


    // Validate skills
    // if (skills && Array.isArray(skills)) {
    //   for (const id of skills) {
    //     if (!mongoose.Types.ObjectId.isValid(id)) {
    //       throw new BadRequestError(`Invalid skill ID: ${id}`);
    //     }
    //     if (!(await Skill.findById(id))) {
    //       throw new NotFoundError(`Skill not found: ${id}`);
    //     }
    //   }
    // }

    // Validate location.city (prefer seeded, but allow custom)
    if (Array.isArray(location.city)) {
      for (const city of location.city) {
        const cityLocation = await Location.findOne({ name: city });
        if (!cityLocation) {
          console.warn(`Custom city added: ${city}`);
        }
      }
    }

    // Create new job post
    const newJobPost = new JobPost({
      jobId: await generateUniqueJobId(),
      employer: employerId,        // the actual company owner
      postedBy: req.user.id,           // who is posting (employer or hr-admin)
      companyProfile: companyProfile || companyProfileDoc._id, // Use provided ID or default to employer’s profile
      title,
      description,
      contactEmail: normalizedContactEmail,
      contactUsername,
      // specialisms,
      jobType,
      offeredSalary,
      ...(normalizedSalary ? { salary: normalizedSalary } : {}),
      careerLevel,
      experience,
      gender: gender || 'No Preference',
      functionalAreas: resolvedFunctionalAreaIds,
      industry: resolvedIndustryId,
      role: resolvedRoleId,
      collarCategory,
      skills: resolvedSkillIds,
      qualification,
      applicationDeadline,
      maxApplicants: maxApplicants ? Number(maxApplicants) : null,
      location: {
        country: location.country,
        city: location.city, // This is now an array
        completeAddress: location.completeAddress,
      },
      positions: {
        total: Number(positions.total),
        remaining: Number(positions.total),
      },
      remoteWork: remoteWork || 'On-site', // Default to On-site
      status: requestedStatus, // Validated above; defaults to Published
      ...(requestedStatus === 'Closed'
        ? {
            closedAt: new Date(),
            closedBy: req.user.id,
            closedByRole: ['employer', 'hr-admin', 'superadmin'].includes(userRole) ? userRole : 'system',
          }
        : {}),
    });

    await newJobPost.save();

    // Public job page for this post. Resolved AFTER save() so the canonical slug
    // written by the model's pre-save hook is available; admin notifications link
    // straight to the live job rather than to a dashboard listing.
    const publicJobPath = buildPublicJobPath(newJobPost);
    const publicJobUrl = buildPublicJobUrl(newJobPost, process.env.FRONTEND_URL);

    // Tell Google about the new JobPosting page. Fire-and-forget by design:
    // notifyJobPublished() never throws and never awaits the round trip, so a
    // slow or unavailable Indexing API cannot delay or fail job creation. It
    // self-skips when the job is not a live public page.
    notifyJobPublished(newJobPost, 'create');
    const populatedJobForEmail = await JobPost.findById(newJobPost._id)
      .populate('functionalAreas', 'name')
      .populate('industry', 'name')
      .populate('role', 'name')
      .lean();

    const adminRecipients = await getAdminAlertUsers();
    const recipients = adminRecipients.emails;
    const actor = await User.findById(req.user.id).select('name email role');
    const actorLabel =
      actor?.email ||
      (actor?.role === 'superadmin' ? 'Super Admin' : actor?.role === 'hr-admin' ? 'HR Admin' : 'Employer');

    if (recipients.length) {
      console.log(
        `[JOB_POST_ADMIN_ALERT] Triggered for job="${newJobPost.title}" (${newJobPost._id}) | postedByRole=${userRole || 'employer'} | recipients=${recipients.join(', ')}`
      );

      const emailResults = await Promise.allSettled(
        recipients.map((recipient) =>
          sendSuperadminAlertEmail({
            superadminEmail: recipient,
            eventType: 'job_posted',
            userEmail: newJobPost.contactEmail,
            userRole: userRole || 'employer',
            message: `Job "${newJobPost.title}" posted for ${companyProfileDoc.companyName} by ${actorLabel}`,
            actorEmail: actorLabel,
            dashboardLink: `${process.env.FRONTEND_URL}/super-admin-dashboard/manage-jobs`,
          })
        )
      );

      emailResults.forEach((result, index) => {
        const recipient = recipients[index];
        if (result.status === 'fulfilled') {
          console.log(`[JOB_POST_ADMIN_ALERT] Sent successfully -> ${recipient}`);
        } else {
          console.error(
            `[JOB_POST_ADMIN_ALERT] Failed -> ${recipient}:`,
            result.reason?.message || result.reason || 'Unknown error'
          );
        }
      });

      const adminNotificationPayload = {
        ...notificationPresets.emailUpdate(
          'New Job Posted',
          `A new job, "${newJobPost.title}", was posted for ${companyProfileDoc.companyName} by ${actorLabel}.`
        ),
        jobPost: newJobPost._id,
        actionUrl: publicJobPath,
      };

      await Promise.allSettled(
        adminRecipients.users.map((adminUser) =>
          createNotification(adminUser._id, 'email_update', adminNotificationPayload)
        )
      );

      await sendPushToUsers(
        adminRecipients.users.map((adminUser) => adminUser._id),
        {
          title: adminNotificationPayload.title,
          body: adminNotificationPayload.description,
          link: publicJobUrl,
          data: {
            type: 'job_posted',
            jobPostId: newJobPost._id,
            actionUrl: adminNotificationPayload.actionUrl,
          },
        }
      );
    } else {
      console.warn(
        `[JOB_POST_ADMIN_ALERT] Skipped for job="${newJobPost.title}" (${newJobPost._id}) because no recipients were found`
      );
    }

    if (userRole === 'employer' && actor?.email) {
      console.log(
        `[JOB_POST_EMPLOYER_CONFIRMATION] Triggered for job="${newJobPost.title}" (${newJobPost._id}) -> ${actor.email}`
      );
      await sendEmployerJobPostedEmail({
        recipient: actor.email,
        employerName: actor?.name || 'Employer',
        jobTitle: newJobPost.title,
        companyName: companyProfileDoc.companyName,
        dashboardLink: `${process.env.FRONTEND_URL}/employers-dashboard/manage-jobs`,
        jobDetailsLink: buildPublicJobLink(populatedJobForEmail || newJobPost),
        jobDetails: buildEmailJobDetails(populatedJobForEmail || newJobPost),
      });
      const employerNotificationPayload = {
        ...notificationPresets.emailUpdate(
          'Job Posted Successfully',
          `Your job "${newJobPost.title}" has been posted and is now live.`
        ),
        jobPost: newJobPost._id,
        actionUrl: '/employers-dashboard/manage-jobs',
      };
      await createNotification(actor._id, 'email_update', employerNotificationPayload);
      await sendPushToUsers([actor._id], {
        title: employerNotificationPayload.title,
        body: employerNotificationPayload.description,
        link: `${process.env.FRONTEND_URL}/employers-dashboard/manage-jobs`,
        data: {
          type: 'job_posted',
          jobPostId: newJobPost._id,
          actionUrl: employerNotificationPayload.actionUrl,
        },
      });
      console.log(
        `[JOB_POST_EMPLOYER_CONFIRMATION] Completed for job="${newJobPost.title}" (${newJobPost._id}) -> ${actor.email}`
      );
    } else if (userRole === 'employer') {
      console.warn(
        `[JOB_POST_EMPLOYER_CONFIRMATION] Skipped for job="${newJobPost.title}" (${newJobPost._id}) because employer email not found`
      );
    } else if (['hr-admin', 'superadmin'].includes(userRole)) {
      const selectedEmployer = await User.findById(employerId).select('name email contactEmail isSystemGeneratedEmail');
      const employerEmailRecipients = new Set();

      if (selectedEmployer?.isSystemGeneratedEmail) {
        addRealEmail(employerEmailRecipients, selectedEmployer.contactEmail);
      } else {
        addRealEmail(employerEmailRecipients, selectedEmployer?.email);
        addRealEmail(employerEmailRecipients, selectedEmployer?.contactEmail);
      }
      addRealEmail(employerEmailRecipients, companyProfileDoc.email);

      const employerRecipients = Array.from(employerEmailRecipients);
      if (employerRecipients.length) {
        console.log(
          `[JOB_POST_ADMIN_EMPLOYER_NOTICE] Triggered for job="${newJobPost.title}" (${newJobPost._id}) -> ${employerRecipients.join(', ')}`
        );

        const employerEmailResults = await Promise.allSettled(
          employerRecipients.map((recipient) =>
            sendEmployerJobPostedEmail({
              recipient,
              employerName: selectedEmployer?.name || companyProfileDoc.companyName || 'Employer',
              jobTitle: newJobPost.title,
              companyName: companyProfileDoc.companyName,
              dashboardLink: `${process.env.FRONTEND_URL}/employers-dashboard/manage-jobs`,
              jobDetailsLink: buildPublicJobLink(populatedJobForEmail || newJobPost),
              postedByAdmin: true,
              jobDetails: buildEmailJobDetails(populatedJobForEmail || newJobPost),
            })
          )
        );

        employerEmailResults.forEach((result, index) => {
          const recipient = employerRecipients[index];
          if (result.status === 'fulfilled') {
            console.log(`[JOB_POST_ADMIN_EMPLOYER_NOTICE] Sent successfully -> ${recipient}`);
          } else {
            console.error(
              `[JOB_POST_ADMIN_EMPLOYER_NOTICE] Failed -> ${recipient}:`,
              result.reason?.message || result.reason || 'Unknown error'
            );
          }
        });

        if (selectedEmployer?._id) {
          const employerNotificationPayload = {
            ...notificationPresets.emailUpdate(
              'New Job Posted by Coimbatore Jobs',
              `Coimbatore Jobs administration posted "${newJobPost.title}" on behalf of ${companyProfileDoc.companyName}.`
            ),
            jobPost: newJobPost._id,
            actionUrl: '/employers-dashboard/manage-jobs',
          };
          await createNotification(selectedEmployer._id, 'email_update', employerNotificationPayload);
          await sendPushToUsers([selectedEmployer._id], {
            title: employerNotificationPayload.title,
            body: employerNotificationPayload.description,
            link: `${process.env.FRONTEND_URL}/employers-dashboard/manage-jobs`,
            data: {
              type: 'job_posted_by_admin',
              jobPostId: newJobPost._id,
              actionUrl: employerNotificationPayload.actionUrl,
            },
          });
        }
      } else {
        console.warn(
          `[JOB_POST_ADMIN_EMPLOYER_NOTICE] Skipped for job="${newJobPost.title}" (${newJobPost._id}) because selected employer/company email was not found`
        );
      }
    }

    return res.status(201).json({
      success: true,
      message: 'Job post created successfully',
      jobPost: newJobPost,
    });
  } catch (error) {
    next(error);
  }
};



/**
 * Fetches a list of job posts, filtered by employer for non-superadmins
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 * @param {Function} next - Next middleware function
 */
jobsController.getJobPosts = async (req, res, next) => {
  try {
    const { role: userRole, id: userId } = req.user; 
    const {
      scope = 'all', // hr-admin: assigned | all
      status = 'All',
      search = '',
    } = req.query;

    // Build base query
    let query = {};
    const now = new Date();

    // Restrict to employer's own job posts unless superadmin, hr-admin
    if (userRole === 'employer') {
      // Employer → jobs of their company
      query.employer = userId;
    }

    if (userRole === 'hr-admin' || userRole === 'superadmin') {
      if (scope === 'assigned') {
        // Assigned scope:
        // hr-admin/superadmin -> employers assigned to any HR admin,
        // admin-created employers, and jobs posted directly by admins.
        let assignedEmployerIds = [];

        const hrAdmins = await User.find({ role: 'hr-admin', isActive: true }).select('employerIds');
        assignedEmployerIds = [
          ...new Set(
            hrAdmins.flatMap((hr) => (hr.employerIds || []).map((id) => id.toString()))
          ),
        ];

        const adminUsers = await User.find({
          role: { $in: ['hr-admin', 'superadmin'] },
          isActive: true,
        }).select('_id');
        const adminUserIds = adminUsers.map((admin) => admin._id);

        const createdEmployers = await User.find({
          role: 'employer',
          createdBy: { $in: adminUserIds },
          isDeleted: { $ne: true },
        }).select('_id');
        const createdEmployerIds = createdEmployers.map((u) => u._id.toString());

        const effectiveEmployerIds = [
          ...new Set([...assignedEmployerIds, ...createdEmployerIds]),
        ]
          .filter((id) => mongoose.Types.ObjectId.isValid(id))
          .map((id) => new mongoose.Types.ObjectId(id));

        query = {
          $or: [
            { employer: { $in: effectiveEmployerIds } },
            { postedBy: { $in: adminUserIds } },
          ],
        };
      } else {
        // `all` scope = platform-wide for HR Admin / Superadmin
        query = {};
      }
    }

    // Filter expired jobs based on user role
    // HR-Admin (all scope) and Superadmin: see ALL jobs including expired
    // Employers: see only their own jobs (including expired)
    // Candidates/Public: see only active, non-expired jobs
    if (userRole !== 'hr-admin' && userRole !== 'superadmin') {
      // For candidates/public: exclude expired jobs
      if (userRole !== 'employer') {
        query.applicationDeadline = { $gte: now };
      }
    }

    if (status && status !== 'All') {
      query.status = status;
    }

    // Query and populate related company profile (only name and logo)
    const jobPosts = await JobPost.find(query)
      .populate('companyProfile', 'companyName logo email publicPhone phone')
      .populate('functionalAreas', 'name slug')
      .populate('industry', 'name slug')
      .populate('role', 'name slug defaultCollarCategory')
      .populate('skills', 'name')
      .select('employer companyProfile title location applicantCount status closedAt closedBy closedByRole candidateSelectionSource candidateSelectionSourceUpdatedAt candidateSelectionSourceUpdatedBy createdAt applicationDeadline postedBy slug salary offeredSalary')
      .select('jobId employer companyProfile title location applicantCount status closedAt closedBy closedByRole candidateSelectionSource candidateSelectionSourceUpdatedAt candidateSelectionSourceUpdatedBy createdAt applicationDeadline postedBy')
      .sort({ createdAt: -1 });  // Most recent first
    await ensureJobIds(jobPosts);

    const normalizedSearch = String(search || '').trim().toLowerCase();
    const filteredJobPosts = normalizedSearch
      ? jobPosts.filter((job) => {
          const title = String(job.title || '').toLowerCase();
          const companyName = String(job.companyProfile?.companyName || '').toLowerCase();
          const companyEmail = String(job.companyProfile?.email || '').toLowerCase();
          return (
            title.includes(normalizedSearch) ||
            companyName.includes(normalizedSearch) ||
            companyEmail.includes(normalizedSearch)
          );
        })
      : jobPosts;

    const monthKey = getIstMonthKey();
    const filteredJobIds = filteredJobPosts.map((job) => job._id);
    const downloadUsageAgg = filteredJobIds.length
      ? await EmployerResumeDownloadLog.aggregate([
          {
            $match: {
              monthKey,
              jobPost: { $in: filteredJobIds },
            },
          },
          {
            $group: {
              _id: '$jobPost',
              downloadsUsed: { $sum: 1 },
            },
          },
        ])
      : [];

    const downloadUsageMap = new Map(
      downloadUsageAgg.map((item) => [String(item._id), Number(item.downloadsUsed || 0)])
    );

    let employerResumeUsage = null;
    let employerResumeFeature = {
      enabled: true,
      limit: MONTHLY_RESUME_LIMIT,
      cycle: 'Monthly',
    };

    if (userRole === 'employer') {
      const plan = await resolveEmployerPlan(userId);
      employerResumeFeature = getFeatureLimit(plan, 'resumeDownloads', 'resumeLimit');
      employerResumeUsage = await getEmployerResumeDownloadUsage(userId, employerResumeFeature.cycle);
    }

    const jobPostsWithDownloadUsage = filteredJobPosts.map((job) => {
      const jobDownloadsUsed = downloadUsageMap.get(String(job._id)) || 0;
      const downloadsUsed = employerResumeUsage?.total ?? jobDownloadsUsed;
      const limit = employerResumeFeature.limit;
      const jobWithCurrentCollar = applyCurrentRoleCollarCategory(job);

      return {
        ...jobWithCurrentCollar,
        resumeDownloadUsage: {
          used: downloadsUsed,
          limit,
          label: limit === -1 ? `${downloadsUsed}/Unlimited` : `${downloadsUsed}/${limit}`,
          isLimitReached: limit !== -1 && downloadsUsed >= limit,
          limitScope: userRole === 'employer' ? 'employer' : 'job',
          cycle: employerResumeFeature.cycle,
          jobDownloadsUsed,
          profileDownloads: employerResumeUsage?.profileDownloads || 0,
          applicantDownloads: employerResumeUsage?.applicantDownloads || jobDownloadsUsed,
        },
      };
    });

    return res.status(200).json({
      success: true,
      jobPosts: jobPostsWithDownloadUsage,
    });
  } catch (error) {
    next(error);
  }
};


/**
 * Fetches job posts created by employers themselves.
 *
 * Access Rules:
 * ----------------------------------------------------
 * employer      → can see ONLY their own job posts
 * hr-admin      → can see ALL employer-created job posts
 * superadmin    → can see ALL employer-created job posts
 *
 * Employer-created job condition:
 * ----------------------------------------------------
 * postedBy === employer
 *
 */
jobsController.getEmployerJobPosts = async (req, res, next) => {
  try {
    const { role: userRole, id: userId } = req.user;

    // Base MongoDB query
    let query = {};

    /**
     * EMPLOYER
     * ------------------------------------------------
     * Employers should see ONLY the jobs
     * created under their own employer account.
     */
    if (userRole === 'employer') {
      query.employer = userId;
      query.postedBy = userId; // employer created it themselves
    }

    /**
     * HR-ADMIN / SUPERADMIN
     * ------------------------------------------------
     * Admins can view ALL employer-created jobs.
     * We identify employer-created jobs by checking:
     * postedBy === employer
     */
    if (['hr-admin', 'superadmin'].includes(userRole)) {
      query.$expr = { $eq: ['$postedBy', '$employer'] };
    }

    // Fetch jobs with minimal required fields
    const jobPosts = await JobPost.find(query)
      .populate('companyProfile', 'companyName logo publicPhone phone')
      .populate('employer', 'name email')
      .select(
        'jobId title status closedAt closedBy closedByRole candidateSelectionSource candidateSelectionSourceUpdatedAt candidateSelectionSourceUpdatedBy employer companyProfile postedBy createdAt applicationDeadline'
      )
      .sort({ createdAt: -1 });
    await ensureJobIds(jobPosts);

    // Success response
    return res.status(200).json({
      success: true,
      count: jobPosts.length,
      jobPosts
    });
  } catch (error) {
    next(error);
  }
};


/**
 * Fetches job posts created by HR-Admins or Superadmins
 * on behalf of employers.
 *
 * Access Rules:
 * ----------------------------------------------------
 * hr-admin      → sees ONLY jobs posted by themselves
 * superadmin    → sees ALL admin-created job posts
 *
 * Admin-created job condition:
 * ----------------------------------------------------
 * postedBy !== employer
 */
jobsController.getAdminPostedJobs = async (req, res, next) => {
  try {
    const { role: userRole, id: userId } = req.user;

    // Base query for admin-created jobs
    let query = {
      $expr: { $ne: ['$postedBy', '$employer'] }
    };

    /**
     * HR-ADMIN
     * ------------------------------------------------
     * HR-Admin can only see jobs posted by themselves.
     */
    if (userRole === 'hr-admin') {
      query.postedBy = userId;
    }

    /**
     * SUPERADMIN
     * ------------------------------------------------
     * Superadmin can see ALL admin-created jobs.
     * No additional filters required.
     */

    const jobPosts = await JobPost.find(query)
      .populate('companyProfile', 'companyName logo publicPhone phone')
      .populate('employer', 'name email')
      .populate('postedBy', 'name role')
      .select(
        'jobId title status closedAt closedBy closedByRole candidateSelectionSource candidateSelectionSourceUpdatedAt candidateSelectionSourceUpdatedBy employer companyProfile postedBy createdAt applicationDeadline'
      )
      .sort({ createdAt: -1 });
    await ensureJobIds(jobPosts);

    return res.status(200).json({
      success: true,
      count: jobPosts.length,
      jobPosts
    });
  } catch (error) {
    next(error);
  }
};


/**
 * Fetches a single job post for editing
 * @param {Object} req - Request object containing job post ID
 * @param {Object} res - Response object
 * @param {Function} next - Next middleware function
 */
jobsController.getJobPost = async (req, res, next) => {
  try {
    const user = req.user;
    const jobPostId = req.params.id;

    // Accept either a Mongo ObjectId or a SEO slug in the same :id param
    const query = mongoose.Types.ObjectId.isValid(jobPostId)
      ? { _id: jobPostId }
      : { slug: jobPostId };

    // Public SEO-ready projection: explicit whitelist so no PII or internal
    // analytics fields are ever exposed on this public endpoint.
    const PUBLIC_JOB_FIELDS = [
      'title',
      'description',
      'slug',
      'seoKeywords',
      'jobType',
      'offeredSalary',
      'salary',
      'careerLevel',
      'experience',
      'gender',
      'qualification',
      'remoteWork',
      'collarCategory',
      'location',
      'positions',
      'applicationDeadline',
      'status',
      'companyProfile',
      'industry',
      'functionalAreas',
      'role',
      'skills',
      'createdAt',
      'updatedAt',
    ].join(' ');

    const jobPost = await JobPost.findOne(query)
      .populate({
        path: 'companyProfile',
        select: 'companyName logo publicPhone phone website industry',
        populate: { path: 'industry', select: 'name slug' },
      })
      .populate('functionalAreas', 'name slug')
      .populate('industry', 'name slug')
      .populate('role', 'name slug defaultCollarCategory')
      .populate('skills', 'name')
      .select(PUBLIC_JOB_FIELDS);

    if (!jobPost) {
      throw new NotFoundError('Job post not found');
    }
    await ensureJobId(jobPost);

    // Check permissions
    // if (user.role !== 'superadmin' && jobPost.employer.toString() !== user.id.toString()) {
    //   throw new ForbiddenError('You do not have permission to access this job post');
    // }

    const jobPostData = applyCurrentRoleCollarCategory(jobPost);

    return res.status(200).json({
      success: true,
      jobPost: {
        ...jobPostData,
        ...buildJobPostingSeoFields(jobPostData),
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Updates a job post
 * @param {Object} req - Request object containing updated job post data
 * @param {Object} res - Response object
 * @param {Function} next - Next middleware function
 */
jobsController.updateJobPost = async (req, res, next) => {
  try {
    const { role: userRole, id: userId } = req.user;
    const jobPostId = req.params.id;

    // commented out old destructuring for now
    // const {
    //   title,
    //   description,
    //   contactEmail,
    //   contactUsername,
    //   // specialisms,
    //   jobType,
    //   offeredSalary,
    //   careerLevel,
    //   experience,
    //   gender,
    //   functionalAreas,
    //   industry,
    //   role,
    //   skills,
    //   qualification,
    //   applicationDeadline,
    //   location,
    //   status,
    //   positions
    // } = req.body;

    const jobPost = await JobPost.findById(jobPostId);
    if (!jobPost) {
      throw new NotFoundError('Job post not found');
    }

    // Check permissions
    const isOwner = jobPost.employer.toString() === userId.toString();
    const isPoster = jobPost.postedBy.toString() === userId.toString();
    const isAdmin = ['hr-admin', 'superadmin'].includes(userRole);

    if (!isOwner && !isPoster && !isAdmin) {
      throw new ForbiddenError('You do not have permission to modify this job post');
    }

    // commented out old specialisms for now
    // Parse specialisms if string
    // let parsedSpecialisms = specialisms;
    // if (typeof specialisms === 'string') {
    //   try {
    //     parsedSpecialisms = JSON.parse(specialisms);
    //   } catch {
    //     throw new BadRequestError('Invalid specialisms format');
    //   }
    // }

    const updateData = {};

    // Added 'maxApplicants' so it updates properly.
    ['title', 'description', 'contactEmail', 'contactUsername', 'jobType',
     'offeredSalary', 'careerLevel', 'experience', 'gender', 'qualification',
     'applicationDeadline', 'remoteWork', 'status', 'maxApplicants', 'collarCategory'].forEach(field => {
      if (req.body[field] !== undefined) updateData[field] = req.body[field];
    });

    // Structured salary update (independent of offeredSalary). Setting salary to
    // null/empty clears it; a valid object replaces it; omitting leaves it as-is.
    if (Object.prototype.hasOwnProperty.call(req.body, 'salary')) {
      if (req.body.salary === null || req.body.salary === '') {
        updateData.salary = undefined;
      } else {
        const normalizedSalary = normalizeSalaryInput(req.body.salary);
        updateData.salary = normalizedSalary; // undefined when not usable
      }
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'collarCategory')) {
      if (!COLLAR_CATEGORIES.includes(req.body.collarCategory)) {
        throw new BadRequestError('Invalid collar category');
      }
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'candidateSelectionSource')) {
      const allowedSelectionSources = ['unknown', 'coimbatorejobs', 'external', 'not_selected'];
      if (!allowedSelectionSources.includes(req.body.candidateSelectionSource)) {
        throw new BadRequestError('Invalid candidate selection source');
      }

      updateData.candidateSelectionSource = req.body.candidateSelectionSource;
      updateData.candidateSelectionSourceUpdatedAt =
        req.body.candidateSelectionSource === 'unknown' ? null : new Date();
      updateData.candidateSelectionSourceUpdatedBy =
        req.body.candidateSelectionSource === 'unknown' ? null : userId;
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'status')) {
      if (req.body.status === 'Closed' && jobPost.status !== 'Closed') {
        updateData.closedAt = new Date();
        updateData.closedBy = userId;
        updateData.closedByRole = userRole || 'system';
      } else if (req.body.status !== 'Closed') {
        updateData.closedAt = null;
        updateData.closedBy = null;
        updateData.closedByRole = null;
      }
    }

    // Handle location using strict dot notation
    const parsedLocation = req.body.location;

      if (parsedLocation) {
        if (!parsedLocation.country || !parsedLocation.city || parsedLocation.city.length === 0 || !parsedLocation.completeAddress) {
          throw new BadRequestError('Location must include country, at least one city, and completeAddress');
        }

        updateData['location.country'] = parsedLocation.country;
        updateData['location.city'] = parsedLocation.city;
        updateData['location.completeAddress'] = parsedLocation.completeAddress;
    }

    // commented out old update for now
    // Update fields
    // const updateData = {
    //   title: title || jobPost.title,
    //   description: description || jobPost.description,
    //   contactEmail: contactEmail || jobPost.contactEmail,
    //   contactUsername: contactUsername || jobPost.contactUsername,
    //   specialisms: parsedSpecialisms ? (Array.isArray(parsedSpecialisms) ? parsedSpecialisms : [parsedSpecialisms]) : jobPost.specialisms,
    //   jobType: jobType || jobPost.jobType,
    //   offeredSalary: offeredSalary || jobPost.offeredSalary,
    //   careerLevel: careerLevel || jobPost.careerLevel,
    //   experience: experience || jobPost.experience,
    //   gender: gender || jobPost.gender,
    //   industry: industry || jobPost.industry,
    //   qualification: qualification || jobPost.qualification,
    //   applicationDeadline: applicationDeadline || jobPost.applicationDeadline,
    //   status: status || jobPost.status,
    // };

    // if (parsedLocation) {
    //   updateData.location = {
    //     country: parsedLocation.country || jobPost.location.country,
    //     city: parsedLocation.city || jobPost.location.city,
    //     completeAddress: parsedLocation.completeAddress || jobPost.location.completeAddress,
    //   };
    // }

    // Taxonomy fields
    // Handle arrays / refs if provided
    if (req.body.functionalAreas) {
      // Validate array of IDs
      for (const id of req.body.functionalAreas) {
        if (!mongoose.Types.ObjectId.isValid(id) || !(await FunctionalArea.findById(id))) {
          throw new BadRequestError(`Invalid functional area: ${id}`);
        }
      }
      updateData.functionalAreas = req.body.functionalAreas;
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'role')) {
      const nextRole = req.body.role;
      if (nextRole === '' || nextRole === null) {
        updateData.role = null;
      } else {
        if (!mongoose.Types.ObjectId.isValid(nextRole) || !(await Role.findById(nextRole))) {
          throw new BadRequestError('Invalid role');
        }
        updateData.role = nextRole;
      }
    }

    if (req.body.skills) {
      for (const id of req.body.skills) {
        if (!mongoose.Types.ObjectId.isValid(id) || !(await Skill.findById(id))) {
          throw new BadRequestError(`Invalid skill: ${id}`);
        }
      }
      updateData.skills = req.body.skills;
    }

    if (req.body.industry) {
      if (!mongoose.Types.ObjectId.isValid(req.body.industry) || !(await Industry.findById(req.body.industry))) {
        throw new BadRequestError('Invalid industry');
      }
      updateData.industry = req.body.industry;
    }

    // POSITIONS UPDATE
   if (req.body.positions !== undefined) {
      const positions = req.body.positions;
      let newTotal;

      // Handle both formats:
      // positions: 50
      // positions: { total: 50 }
      if (typeof positions === 'object') {
        newTotal = Number(positions.total);
      } else {
        newTotal = Number(positions);
      }

      if (isNaN(newTotal) || newTotal < 0) {
        throw new BadRequestError('Invalid positions value');
      }

      // cannot reduce below already applied count
      if (newTotal < jobPost.applicantCount) {
        throw new BadRequestError(
          `Positions cannot be less than applied count (${jobPost.applicantCount})`
        );
      }

      const newRemaining = newTotal - jobPost.applicantCount;

      updateData.positions = {
        total: newTotal,
        remaining: newRemaining,
      };

      // Do not auto-close based on openings.
      // Job closure is controlled by status, deadline, or maxApplicants.
    }
    

    // Whether this job was a live public JobPosting page BEFORE the edit. Read
    // from the pre-update document so a Published -> Closed transition can be
    // detected below and withdrawn from Google.
    const wasPubliclyIndexable = isPubliclyIndexable(jobPost);

    // Update job post
    const updatedJobPost = await JobPost.findByIdAndUpdate(
      jobPostId,
      { $set: updateData },
      { new: true, runValidators: true }
    ).populate('functionalAreas role industry skills companyProfile').select('-__v -applicantCount');
    await ensureJobId(updatedJobPost);

    // Keep Google in step with the page's public state. Still live -> refresh
    // it; no longer live (Closed, moved to Draft, or deadline pulled into the
    // past) -> withdraw it. Both calls are fire-and-forget and cannot fail the
    // update request.
    if (isPubliclyIndexable(updatedJobPost)) {
      notifyJobPublished(updatedJobPost, 'update');
    } else {
      // Judged from the PRE-update document. A job that was Published but
      // already past its deadline was not indexable a moment ago, yet Google
      // may still hold it if the expiry sweep has not withdrawn it yet.
      notifyJobWithdrawal(jobPost, 'update', { wasPubliclyIndexable });
    }

    return res.status(200).json({
      success: true,
      message: 'Job post updated successfully',
      jobPost: updatedJobPost,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Deletes a job post
 * @param {Object} req - Request object containing job post ID
 * @param {Object} res - Response object
 * @param {Function} next - Next middleware function
 */
jobsController.deleteJobPost = async (req, res, next) => {
  try {
    const { role: userRole, id: userId } = req.user;
    const jobPostId = req.params.id;

    const jobPost = await JobPost.findById(jobPostId);
    if (!jobPost) {
      throw new NotFoundError('Job post not found');
    }

    // Check permissions
    const isOwner = jobPost.employer.toString() === userId.toString();
    const isPoster = jobPost.postedBy.toString() === userId.toString();
    const isAdmin = ['hr-admin', 'superadmin'].includes(userRole);

    if (userRole === 'employer') {
      throw new ForbiddenError('Employers cannot delete job posts. Please close the job post instead.');
    }

    if (!isOwner && !isPoster && !isAdmin) {
      throw new ForbiddenError('You do not have permission to modify this job post');
    }

    // Capture the public state before the document disappears — after the
    // delete there is no slug left to build a canonical URL from.
    const wasPubliclyIndexable = isPubliclyIndexable(jobPost);

    // Delete job post
    await JobPost.findByIdAndDelete(jobPostId);

    // Withdraw the page from Google. Covers jobs that were live a moment ago
    // and Published jobs already past their deadline that the expiry sweep has
    // not withdrawn yet; a Draft that was never announced is left alone.
    notifyJobWithdrawal(jobPost, 'delete', { wasPubliclyIndexable });

    return res.status(200).json({
      success: true,
      message: 'Job post deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};

// common pagination function
const paginate = (req) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(50, Number(req.query.limit || 20));
  return { skip: (page - 1) * limit, limit };
};

// Public sitemap feed: minimal, SEO-safe fields for sitemap-eligible jobs only.
// Eligible = Published + non-expired deadline + a valid, non-empty slug.
// No auth, no populate, lean read. Returns all eligible jobs (pagination deferred).
jobsController.getSitemapJobs = async (req, res, next) => {
  try {
    const jobs = await JobPost.find({
      status: 'Published',
      applicationDeadline: { $gte: new Date() },
      slug: { $exists: true, $nin: [null, ''], $regex: /\S/ }, // reject null/empty/whitespace-only
    })
      .select('slug status createdAt updatedAt applicationDeadline -_id')
      .sort({ updatedAt: -1 })
      .lean();

    return res.status(200).json({ success: true, count: jobs.length, jobs });
  } catch (error) {
    next(error);
  }
};

// New SEO-focused APIs
jobsController.getJobsByLocation = async (req, res, next) => {
  try {
    const { city } = req.params;
    const { skip, limit } = paginate(req);

    const jobs = await JobPost.find({ status: 'Published', 'location.city': { $regex: new RegExp(`^${city}$`, 'i') } })
      .populate('companyProfile', 'companyName logo publicPhone phone')
      .populate('functionalAreas', 'name slug')
      .populate('industry', 'name slug')
      .populate('role', 'name slug')
      .populate('skills', 'name')
      .select('title role location status createdAt applicationDeadline slug seoKeywords salary offeredSalary')
      .select('jobId title role location status createdAt slug seoKeywords')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);
    await ensureJobIds(jobs);
    res.json({ success: true, jobs });
  } catch (error) {
    next(error);
  }
};

jobsController.getJobsByCategory = async (req, res, next) => {
  try {
    const { categorySlug } = req.params;
    const functionalArea = await FunctionalArea.findOne({ slug: categorySlug });
    if (!functionalArea) throw new NotFoundError('Category not found');
    const jobs = await JobPost.find({ status: 'Published', functionalAreas: functionalArea._id })
      .populate('companyProfile', 'companyName logo publicPhone phone')
      .populate('functionalAreas', 'name slug')
      .populate('industry', 'name slug')
      .populate('role', 'name slug')
      .populate('skills', 'name')
      .sort({ createdAt: -1 });
    await ensureJobIds(jobs);
    res.json({ success: true, jobs });
  } catch (error) {
    next(error);
  }
};

jobsController.getJobsByRole = async (req, res, next) => {
  try {
    const { roleSlug } = req.params;
    const role = await Role.findOne({ slug: roleSlug });
    if (!role) throw new NotFoundError('Role not found');
    const jobs = await JobPost.find({ status: 'Published', role: role._id })
      .populate('companyProfile', 'companyName logo publicPhone phone')
      .populate('functionalAreas', 'name slug')
      .populate('industry', 'name slug')
      .populate('role', 'name slug')
      .populate('skills', 'name')
      .sort({ createdAt: -1 });
    await ensureJobIds(jobs);
    res.json({ success: true, jobs });
  } catch (error) {
    next(error);
  }
};


jobsController.getJobsByRoleAndCity = async (req, res, next) => {
  try {
    const { roleSlug, city } = req.params;

    const role = await Role.findOne({ slug: roleSlug });
    if (!role) throw new NotFoundError('Role not found');

    const jobs = await JobPost.find({
      role: role._id,
      status: 'Published',
      'location.city': { $regex: new RegExp(`^${city}$`, 'i') }
    })
      .populate('companyProfile', 'companyName logo publicPhone phone')
      .populate('functionalAreas', 'name slug')
      .populate('industry', 'name slug')
      .populate('role', 'name slug')
      .sort({ createdAt: -1 });
    await ensureJobIds(jobs);

    res.json({ success: true, jobs });
  } catch (err) {
    next(err);
  }
};


export default jobsController;
