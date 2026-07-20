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
import { ForbiddenError, BadRequestError, NotFoundError } from "../utils/errors.js";
import { isValidEmailAddress, normalizeEmail } from "../utils/emailValidation.js";
import { COLLAR_CATEGORIES } from '../models/jobs.model.js';
import { requireEmployerJobPostLimit } from '../utils/employerPlanAccess.js';

const jobsController = {};
const MONTHLY_RESUME_LIMIT = 5;
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

const getAdminAlertRecipients = async () => {
  const recipients = new Set();

  if (SUPERADMIN_EMAIL) {
    recipients.add(String(SUPERADMIN_EMAIL).trim().toLowerCase());
  }

  const hrAdmins = await User.find({
    role: 'hr-admin',
    isActive: true,
    status: 'approved',
  }).select('email');

  hrAdmins.forEach((admin) => {
    if (admin?.email) {
      recipients.add(String(admin.email).trim().toLowerCase());
    }
  });

  return Array.from(recipients);
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
      status: 'Published', // Default to Published
    });

    await newJobPost.save();

    const recipients = await getAdminAlertRecipients();
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
      });
      await createNotification(actor._id, 'email_update', {
        ...notificationPresets.emailUpdate(
          'Job Posted Successfully',
          `Your job "${newJobPost.title}" is posted and live now.`
        ),
        jobPost: newJobPost._id,
        actionUrl: '/employers-dashboard/manage-jobs',
      });
      console.log(
        `[JOB_POST_EMPLOYER_CONFIRMATION] Completed for job="${newJobPost.title}" (${newJobPost._id}) -> ${actor.email}`
      );
    } else if (userRole === 'employer') {
      console.warn(
        `[JOB_POST_EMPLOYER_CONFIRMATION] Skipped for job="${newJobPost.title}" (${newJobPost._id}) because employer email not found`
      );
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
        // hr-admin    -> employers assigned to this hr-admin (plus admin-created employer fallback)
        // superadmin  -> employers assigned to any hr-admin (plus superadmin-created employer fallback)
        // both        -> include jobs posted directly by current admin
        let assignedEmployerIds = [];

        if (userRole === 'hr-admin') {
          const currentHrAdmin = await User.findById(userId).select('employerIds');
          assignedEmployerIds = (currentHrAdmin?.employerIds || []).map((id) => id.toString());
        } else if (userRole === 'superadmin') {
          const hrAdmins = await User.find({ role: 'hr-admin', isActive: true }).select('employerIds');
          assignedEmployerIds = [
            ...new Set(
              hrAdmins.flatMap((hr) => (hr.employerIds || []).map((id) => id.toString()))
            ),
          ];
        }

        const createdEmployers = await User.find({
          role: 'employer',
          createdBy: userId,
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
            { postedBy: userId },
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
      .populate('companyProfile', 'companyName logo email')
      .populate('functionalAreas', 'name slug')
      .populate('industry', 'name slug')
      .populate('role', 'name slug defaultCollarCategory')
      .populate('skills', 'name')
      .select('employer companyProfile title location applicantCount status createdAt applicationDeadline postedBy slug salary offeredSalary')
      .sort({ createdAt: -1 });  // Most recent first

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

    const jobPostsWithDownloadUsage = filteredJobPosts.map((job) => {
      const downloadsUsed = downloadUsageMap.get(String(job._id)) || 0;
      const jobWithCurrentCollar = applyCurrentRoleCollarCategory(job);

      return {
        ...jobWithCurrentCollar,
        resumeDownloadUsage: {
          used: downloadsUsed,
          limit: MONTHLY_RESUME_LIMIT,
          label: `${downloadsUsed}/${MONTHLY_RESUME_LIMIT}`,
          isLimitReached: downloadsUsed >= MONTHLY_RESUME_LIMIT,
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
      .populate('companyProfile', 'companyName logo')
      .populate('employer', 'name email')
      .select(
        'title status employer companyProfile postedBy createdAt applicationDeadline'
      )
      .sort({ createdAt: -1 });

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
      .populate('companyProfile', 'companyName logo')
      .populate('employer', 'name email')
      .populate('postedBy', 'name role')
      .select(
        'title status employer companyProfile postedBy createdAt applicationDeadline'
      )
      .sort({ createdAt: -1 });

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
        select: 'companyName logo website industry',
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
    

    // Update job post
    const updatedJobPost = await JobPost.findByIdAndUpdate(
      jobPostId,
      { $set: updateData },
      { new: true, runValidators: true }
    ).populate('functionalAreas role industry skills companyProfile').select('-__v -applicantCount');

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

    if (!isOwner && !isPoster && !isAdmin) {
      throw new ForbiddenError('You do not have permission to modify this job post');
    }

    // Delete job post
    await JobPost.findByIdAndDelete(jobPostId);

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
      .populate('companyProfile', 'companyName logo')
      .populate('functionalAreas', 'name slug')
      .populate('industry', 'name slug')
      .populate('role', 'name slug')
      .populate('skills', 'name')
      .select('title role location status createdAt applicationDeadline slug seoKeywords salary offeredSalary')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);
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
      .populate('companyProfile', 'companyName logo')
      .populate('functionalAreas', 'name slug')
      .populate('industry', 'name slug')
      .populate('role', 'name slug')
      .populate('skills', 'name')
      .sort({ createdAt: -1 });
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
      .populate('companyProfile', 'companyName logo')
      .populate('functionalAreas', 'name slug')
      .populate('industry', 'name slug')
      .populate('role', 'name slug')
      .populate('skills', 'name')
      .sort({ createdAt: -1 });
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
      .populate('companyProfile', 'companyName logo')
      .populate('functionalAreas', 'name slug')
      .populate('industry', 'name slug')
      .populate('role', 'name slug')
      .sort({ createdAt: -1 });

    res.json({ success: true, jobs });
  } catch (err) {
    next(err);
  }
};


export default jobsController;
