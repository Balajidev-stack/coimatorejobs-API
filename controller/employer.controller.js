import mongoose from "mongoose";
import CompanyProfile from "../models/companyProfile.model.js";
import CandidateProfile from "../models/candidateProfile.model.js";
import SavedCandidate from "../models/savedCandidate.model.js";
import DemandCandidate from "../models/demandCandidate.model.js";
import CandidateEmployerActivity from "../models/candidateEmployerActivity.model.js";
import ResumeDownloadLog from "../models/resumeDownloadLog.model.js";
import EmployerResumeDownloadLog from "../models/employerResumeDownloadLog.model.js";
import JobPost from "../models/jobs.model.js";
import User from "../models/user.model.js";
import { ForbiddenError, BadRequestError, NotFoundError } from "../utils/errors.js";
import { sendCompanyProfileStatusEmail, sendSuperadminAlertEmail, sendProfileDeletionEmail } from '../utils/mailer.js';
import { createNotification, notificationPresets } from '../utils/notificationHelper.js';
import { SUPERADMIN_EMAIL, THROTTLING_RETRY_DELAY_BASE } from "../config/env.js";
import Industry from '../models/industry.model.js';
import FunctionalArea from '../models/functionalArea.model.js';
import { normalizeEmail } from "../utils/emailValidation.js";
import { getEffectiveEmployerId } from "../utils/roleHelper.js";
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const employerController = {};
const DEFAULT_COMPANY_EMAIL = "hello@coimbatorejobs.in";
const INTERNAL_EMAIL_SUFFIX = "@internal.coimbatorejobs.in";
const COMPANY_ID_PREFIX = "CMP";
const normalizePhoneValue = (value = "") => String(value || "").trim();
const normalizeOptionalPhoneValue = (value = "") => {
  const normalized = normalizePhoneValue(value);
  return normalized || undefined;
};

const buildCompanyId = () =>
  `${COMPANY_ID_PREFIX}-${crypto.randomInt(10000000, 100000000)}`;

const generateUniqueCompanyId = async (session = null) => {
  let candidate = buildCompanyId();

  while (await CompanyProfile.exists({ companyId: candidate }).session(session)) {
    candidate = buildCompanyId();
  }

  return candidate;
};

const ensureCompanyId = async (profile, session = null) => {
  if (!profile) return profile;

  const currentCompanyId = String(profile.companyId || "").trim().toUpperCase();
  if (currentCompanyId) return profile;

  profile.companyId = await generateUniqueCompanyId(session);
  if (typeof profile.save === "function") {
    await profile.save({ session, validateBeforeSave: false });
  } else if (profile._id) {
    await CompanyProfile.updateOne(
      { _id: profile._id, $or: [{ companyId: { $exists: false } }, { companyId: "" }, { companyId: null }] },
      { $set: { companyId: profile.companyId } },
      { session }
    );
  }

  return profile;
};

const ensureCompanyIdsForProfiles = async (profiles = []) => {
  for (const profile of profiles) {
    await ensureCompanyId(profile);
  }
  return profiles;
};

const attachDemandCandidateCounts = async (profiles = []) => {
  const profileList = profiles.map((profile) => (
    typeof profile.toObject === 'function' ? profile.toObject() : profile
  ));
  const profileIds = profileList.map((profile) => profile?._id).filter(Boolean);
  const employerIds = profileList.map((profile) => profile?.employer).filter(Boolean);

  if (!profileIds.length) return profileList;

  const [counts, activityCounts] = await Promise.all([
    DemandCandidate.aggregate([
      { $match: { companyProfile: { $in: profileIds } } },
      { $group: { _id: '$companyProfile', count: { $sum: 1 } } },
    ]),
    employerIds.length
      ? CandidateEmployerActivity.aggregate([
          { $match: { employer: { $in: employerIds } } },
          { $group: { _id: '$employer', count: { $sum: 1 } } },
        ])
      : [],
  ]);

  const countMap = new Map(counts.map((item) => [item._id.toString(), item.count]));
  const activityCountMap = new Map(activityCounts.map((item) => [item._id.toString(), item.count]));
  return profileList.map((profile) => ({
    ...profile,
    demandCandidateCount: countMap.get(profile._id.toString()) || 0,
    candidateActivityCount: activityCountMap.get(getObjectIdString(profile.employer)) || 0,
  }));
};

const normalizeCompanyProfilePhones = (profileData = {}) => {
  const landlineNumber = normalizeOptionalPhoneValue(profileData.landlineNumber);
  const phoneNumber = normalizePhoneValue(profileData.phoneNumber || profileData.publicPhone || profileData.phone);
  const hrPhoneNumber = normalizeOptionalPhoneValue(profileData.hrPhoneNumber || profileData.internalPhone);

  return {
    landlineNumber,
    phoneNumber,
    hrPhoneNumber,
    publicPhone: phoneNumber,
    internalPhone: hrPhoneNumber,
    phone: phoneNumber,
  };
};

const hideInternalCompanyPhone = (profile) => {
  const data = typeof profile?.toObject === 'function' ? profile.toObject() : { ...profile };
  data.phoneNumber = data.phoneNumber || data.publicPhone || data.phone || "";
  data.publicPhone = data.phoneNumber;
  data.phone = data.publicPhone;
  delete data.internalPhone;
  delete data.hrPhoneNumber;
  delete data.landlineNumber;
  return data;
};

const getObjectIdString = (value) => {
  if (!value) return "";
  if (value._id) return value._id.toString();
  return value.toString();
};

const pickLatestDate = (...values) => {
  const dates = values
    .filter(Boolean)
    .map((value) => new Date(value))
    .filter((date) => !Number.isNaN(date.getTime()));
  if (!dates.length) return null;
  return new Date(Math.max(...dates.map((date) => date.getTime())));
};

const parseField = (val) => {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  try {
    const parsed = JSON.parse(val);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    return [val];
  }
};

const isInternalEmail = (email = "") =>
  normalizeEmail(email).endsWith(INTERNAL_EMAIL_SUFFIX);

const resolveCompanyEmailForEmployer = ({ employerUser, requestedEmail }) => {
  const accountEmail = normalizeEmail(employerUser?.email || "");
  const contactEmail = normalizeEmail(employerUser?.contactEmail || "");
  const preferredEmail = normalizeEmail(requestedEmail || "");

  // Non-confidential employers: always use account email as company email.
  if (!employerUser?.isSystemGeneratedEmail) {
    return accountEmail || preferredEmail || DEFAULT_COMPANY_EMAIL;
  }

  // Confidential employers: use explicit non-internal email when available.
  if (preferredEmail && !isInternalEmail(preferredEmail)) return preferredEmail;
  if (contactEmail && !isInternalEmail(contactEmail)) return contactEmail;
  return DEFAULT_COMPANY_EMAIL;
};

const normalizeEstablishedSince = (value) => {
  if (value === null || value === undefined) return value;

  const rawValue = String(value).trim();
  if (!rawValue) return rawValue;

  if (/^\d{1,3}$/.test(rawValue)) {
    const years = Number(rawValue);
    if (Number.isFinite(years) && years > 0 && years <= 200) {
      return `${new Date().getFullYear() - Math.floor(years)}-01-01`;
    }
  }

  if (/^\d{4}$/.test(rawValue)) {
    return `${rawValue}-01-01`;
  }

  return rawValue;
};

const toSafeString = (value) => String(value ?? '').trim();

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

const resolveIndustryId = async (industryValue) => {
  const normalized = toSafeString(industryValue);
  if (!normalized) return null;

  if (mongoose.Types.ObjectId.isValid(normalized)) {
    const found = await Industry.findById(normalized).select('_id');
    if (found) return found._id;
  }

  const regex = new RegExp(`^${escapeRegex(normalized)}$`, 'i');
  const existing = await Industry.findOne({ name: regex }).select('_id');
  if (existing) return existing._id;

  const slug = await createUniqueSlug(Industry, normalized);
  const created = await Industry.create({ name: normalized, slug, isActive: true });
  return created._id;
};

const resolveFunctionalAreaIds = async (functionalAreasInput, industryId = null) => {
  const values = parseField(functionalAreasInput).map((value) => toSafeString(value)).filter(Boolean);
  if (!values.length) return [];

  const ids = [];
  for (const value of values) {
    if (mongoose.Types.ObjectId.isValid(value)) {
      const found = await FunctionalArea.findById(value).select('_id');
      if (found) {
        ids.push(found._id);
        continue;
      }
    }

    const regex = new RegExp(`^${escapeRegex(value)}$`, 'i');
    let existing = null;

    if (industryId) {
      existing = await FunctionalArea.findOne({ name: regex, industry: industryId }).select('_id');
    }
    if (!existing) {
      existing = await FunctionalArea.findOne({ name: regex, isGlobal: true }).select('_id');
    }
    if (!existing) {
      existing = await FunctionalArea.findOne({ name: regex }).select('_id');
    }
    if (existing) {
      ids.push(existing._id);
      continue;
    }

    const slug = await createUniqueSlug(FunctionalArea, value);
    const created = await FunctionalArea.create({
      name: value,
      slug,
      industry: industryId || null,
      isGlobal: false,
      isActive: true,
    });
    ids.push(created._id);
  }

  return Array.from(new Set(ids.map((id) => String(id))));
};


/**
 * Retrieves all company profiles (accessible to admins and superadmins)
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 * @param {Function} next - Next middleware function
 */
// employerController.getAllCompanyProfiles = async (req, res, next) => {
//   try {
//     // Fetch all company profiles, excluding the version key
//      const profiles = await CompanyProfile.find().lean();

//     const formattedProfiles = await Promise.all(
//       profiles.map(async (profile) => {

//         let industryData = null;

//         // ✅ Only populate if valid ObjectId
//         if (mongoose.Types.ObjectId.isValid(profile.industry)) {
//           industryData = await Industry.findById(profile.industry).select("name slug");
//         }

//         return {
//           ...profile,
//           industryId: industryData?._id || null,
//           industryName: industryData?.name || profile.industry || null
//         };
//       })
//     );

//     return res.status(200).json({
//       success: true,
//       profiles: formattedProfiles
//     });
//   } catch (error) {
//     next(error);
//   }
// };
// old get all compnay profile without industry population
employerController.getAllCompanyProfiles = async (req, res, next) => {
  try {
    // Fetch all company profiles, excluding the version key, and POPULATE industry
    const profiles = await CompanyProfile.find()
      .populate('industry', 'name') // <-- ADD THIS LINE
      .select('-__v');

    await ensureCompanyIdsForProfiles(profiles);
    const profilesWithDemandCounts = await attachDemandCandidateCounts(profiles);
    const isAdminViewer = ['hr-admin', 'superadmin'].includes(req.user?.role);
    const publicProfiles = isAdminViewer
      ? profilesWithDemandCounts
      : profilesWithDemandCounts.map(hideInternalCompanyPhone);

    return res.status(200).json({
      success: true,
      profiles: publicProfiles
    });
  } catch (error) {
    next(error);
  }
};


/**
 * Creates a company profile for an authenticated employer, hr-admin, or superadmin
 * @param {Object} req - Request object containing employer data
 * @param {Object} res - Response object to send back the result
 * @param {Function} next - Next middleware function
 */
employerController.createCompanyProfile = async (req, res, next) => {
  try {
    const { role, id: loggedInUserId } = req.user;

    // Parse the nested data from req.body.data
    let profileData = {};
    if (req.body.data) {
      try {
        profileData = JSON.parse(req.body.data);
      } catch (err) {
        throw new BadRequestError("Invalid JSON in 'data' field");
      }
    } else {
      profileData = req.body; // Fallback in case data isn’t nested
    }

    /**
     * 2: Resolved employerId
     * -----------------------------------
     * employer   → can create ONLY own company
     * hr-admin   → can create company ONLY for employers (ACTIVE)
     * superadmin → same as hr-admin
     */

     // Resolve employerId correctly
    let employerId = role === 'employer' ? getEffectiveEmployerId(req.user) : loggedInUserId;
    
    if (['hr-admin', 'superadmin'].includes(role)) {
      if (!profileData.employerId.toString()) {
        throw new BadRequestError('employerId is required for HR-Admin or Superadmin');
      }
      employerId = profileData.employerId;
    }

    const { industry, functionalAreas } = profileData;

    /**
     *  FUTURE FEATURE (COMMENTED)
     * Allow HR-Admin to create OWN company
     */
    /*
    if (role === 'hr-admin' && !profileData.employerId) {
      employerId = loggedInUserId;
    }
    */

    /**
     * 3️: Validate employer user
     * -----------------------------------
     * - Must exist
     * - Must have role = employer
     * - Must be approved
     */
    const employerUser = await User.findById(employerId);
    if (!employerUser) {
      throw new BadRequestError('Employer not found');
    }

    if (employerUser.role !== 'employer') {
      throw new BadRequestError('Provided user is not an employer');
    }

    const industryId = await resolveIndustryId(industry);
    if (!industryId) throw new BadRequestError('Invalid Industry');

    const faIds = await resolveFunctionalAreaIds(functionalAreas, industryId);
    
    // Prevent duplicate company for same employer (business rule)
    const existingProfile = await CompanyProfile.findOne({ employer: employerId });
    if (existingProfile) {
      throw new BadRequestError('Company profile already exists for this employer');
    }

    // console.log("rgrdddddddd", existingProfile, employerUser);
    

    const { 
      companyName, email, website, establishedSince, 
      teamSize, categories, allowInSearch, description, 
      socialMedia, location, companyType, companyGSTIN, panNo, culture, 
      revenue, founders, branches, isHiring
    } = profileData;
    const phoneValues = normalizeCompanyProfilePhones(profileData);
    const normalizedEstablishedSince = normalizeEstablishedSince(establishedSince);
    const requestedCompanyEmail = normalizeEmail(email || "");
    const resolvedCompanyEmail = resolveCompanyEmailForEmployer({
      employerUser,
      requestedEmail: requestedCompanyEmail,
    });

    const normalizedCompanyGSTIN = typeof companyGSTIN === 'string' ? companyGSTIN.trim().toUpperCase() : '';
    const normalizedPanNo = typeof panNo === 'string' ? panNo.trim().toUpperCase() : '';

    // Validate required fields
    // const requiredFields = ['companyName', 'email', 'phone', 'establishedSince', 
    //                        'teamSize', 'categories', 'description', 'industry', 'companyType'];

    const requiredFields = ['companyName', 'phoneNumber', 'establishedSince',
    'teamSize', 'description'];
    
    const missingFields = requiredFields.filter(field => {
      if (field === 'phoneNumber') return !phoneValues[field];
      return !profileData[field];
    });
    if (missingFields.length > 0) {
      throw new BadRequestError(`Missing required fields: ${missingFields.join(', ')}`);
    }

    // Determine initial status
    const isAdminCreator = ['hr-admin', 'superadmin'].includes(role);

    // Handle file uploads
    const files = req.files || {};
    // const logo = files.logo ? `/uploads/company/${files.logo[0].filename}` : null;
    // const coverImage = files.coverImage ? `/uploads/company/${files.coverImage[0].filename}` : null;

    // Handle file uploads with S3 URLs
    const logo = files.logo ? files.logo[0].location : null; // S3 URL
    const coverImage = files.coverImage ? files.coverImage[0].location : null; // S3 URL

    // Create new profile
    const newProfile = new CompanyProfile({
      companyId: await generateUniqueCompanyId(),
      employer: employerId,
      createdBy: loggedInUserId, // HR/Admin or Employer

      status: isAdminCreator ? 'approved' : 'pending',
      approvedBy: isAdminCreator ? loggedInUserId : null,
      approvedAt: isAdminCreator ? new Date() : null,

      industry: industryId,
      functionalAreas: faIds,

      companyName,
      email: resolvedCompanyEmail,
      phone: phoneValues.phone,
      publicPhone: phoneValues.publicPhone,
      internalPhone: phoneValues.internalPhone,
      landlineNumber: phoneValues.landlineNumber,
      phoneNumber: phoneValues.phoneNumber,
      hrPhoneNumber: phoneValues.hrPhoneNumber,
      companyGSTIN: normalizedCompanyGSTIN,
      panNo: normalizedPanNo,
      website,
      establishedSince: normalizedEstablishedSince,
      teamSize,
      categories: Array.isArray(categories) ? categories : [categories],
      allowInSearch: allowInSearch !== undefined ? allowInSearch : true,
      description,
      socialMedia: typeof socialMedia === 'string' ? JSON.parse(socialMedia) : (socialMedia || {}),
      location: typeof location === 'string' ? JSON.parse(location) : (location || {}),
      companyType,
      culture: typeof culture === 'string' ? JSON.parse(culture) : (culture || []),
      revenue,
      founders: typeof founders === 'string' ? JSON.parse(founders) : (founders || []),
      branches: typeof branches === 'string' ? JSON.parse(branches) : (branches || []),
      isHiring: isHiring !== undefined ? isHiring : false,
      logo,
      coverImage
    });

    await newProfile.save();

    /**
     * 🔐 Sync contact email for confidential employer
     * ------------------------------------------------
     * Only if:
     * - Employer has system generated login email
     * - Company profile has real email
     */
    if (employerUser.isSystemGeneratedEmail && newProfile.email) {
      if (requestedCompanyEmail && !isInternalEmail(requestedCompanyEmail)) {
        employerUser.contactEmail = requestedCompanyEmail;
        await employerUser.save();
      }
    }

    // Send notification email to employer about profile status
    const recipientEmail = employerUser.isSystemGeneratedEmail
      ? (employerUser.contactEmail || DEFAULT_COMPANY_EMAIL)
      : employerUser.email;

      await sendCompanyProfileStatusEmail({
      recipient: recipientEmail,
      name: employerUser.name,
      companyName: newProfile.companyName,
      status: newProfile.status,
      dashboardUrl: `${process.env.FRONTEND_URL}employer-dashboard/dashboard`
    });
    const createdCompanyStatusLabel =
      newProfile.status.charAt(0).toUpperCase() + newProfile.status.slice(1);
    await createNotification(employerUser._id, 'profile_update', {
      ...notificationPresets.profileUpdate(
        `Your company profile "${newProfile.companyName}" is currently ${newProfile.status}.`
      ),
      title: `Company Profile Status: ${createdCompanyStatusLabel}`,
      actionUrl: '/employers-dashboard/company-profile',
      icon: newProfile.status === 'approved' ? 'la-check-circle' : 'la-clock-o',
      color: newProfile.status === 'approved' ? '#22c55e' : '#f59e0b',
    });

      // WAIT 6 SECONDS (Mailtrap throttle workaround)
    await new Promise(resolve => setTimeout(resolve, 8000)); //remove when in production

    // Alert superadmin
    await sendSuperadminAlertEmail({
      superadminEmail: SUPERADMIN_EMAIL,
      eventType: 'create_profile',
      userEmail: recipientEmail,
      userRole: 'employer',
      message: `New company profile created for ${recipientEmail} by ${loggedInUserId}`
    });

    return res.status(201).json({
      success: true,
      message: 'Company profile created successfully',
      profile: newProfile
    });
  } catch (error) {

    // Cleanup uploaded files if an error occurs after upload
    // if (req.files) {
    //   const files = req.files;
    //   if (files.logo && files.logo[0]) {
    //     const logoPath = path.join(process.cwd(), 'public', `/uploads/company/${files.logo[0].filename}`);
    //     if (fs.existsSync(logoPath)) fs.unlinkSync(logoPath);
    //   }
    //   if (files.coverImage && files.coverImage[0]) {
    //     const coverPath = path.join(process.cwd(), 'public', `/uploads/company/${files.coverImage[0].filename}`);
    //     if (fs.existsSync(coverPath)) fs.unlinkSync(coverPath);
    //   }
    // }
    console.error("Create Company Profile Error:", error);
    next(error);
  }
};

/**
 * Get all pending company profiles
 * Accessible by HR-Admin and Superadmin
 *
 * HR-Admin:
 *  - Sees only company profiles created by employers assigned to them
 *
 * Superadmin:
 *  - Sees all pending company profiles
 */
employerController.getPendingCompanyProfiles = async (req, res, next) => {
  try {
    const { page = 1, limit = 10 } = req.query;

    // Base filter: only pending profiles
    const filter = {
      status: 'pending',
    };

    // Optional future: restrict HR-Admin to assigned employers
    // const user = req.user;
    // if (user.role === 'hr-admin') {
    //   if (!user.employerIds || user.employerIds.length === 0) {
    //     return res.status(200).json({ success: true, profiles: [], pagination: { ... } });
    //   }
    //   filter.employer = { $in: user.employerIds };
    // }

    // Fetch pending company profiles
    const profiles = await CompanyProfile.find(filter)
      .populate('employer', 'name email')     // ref: 'User'
      .populate('createdBy', 'name email')    // ref: 'User'
      .sort({ createdAt: -1 })
      .skip((page - 1) * Number(limit))
      .limit(Number(limit))
      .select('-__v');

    // Total count for pagination
    const total = await CompanyProfile.countDocuments(filter);

    return res.status(200).json({
      success: true,
      profiles,
      pagination: {
        currentPage: Number(page),
        totalPages: Math.ceil(total / limit),
        total,
        limit: Number(limit),
      },
    });
  } catch (error) {
    next(error);
  }
};


/**
 * Get all company profiles (Admin / Superadmin)
 */
// employerController.getAllCompanyProfiles = async (req, res, next) => {
//   try {
//     const profiles = await CompanyProfile.find()
//       .populate('employer', 'name email')
//       .populate('approvedBy', 'name role')
//       .select('-__v');

//     return res.status(200).json({
//       success: true,
//       profiles
//     });
//   } catch (error) {
//     next(error);
//   }
// };


//new update company profile after next js check
// Update company profile
employerController.updateCompanyProfile = async (req, res, next) => {
  try {
    const user = req.user;
    const profileId = req.params.id;
    // const updateData = req.body;
    // const updateData = req.body.data ? JSON.parse(req.body.data) : {};
    const files = req.files || {};

// Parse updateData from req.body.data if it exists
    let updateData = {};
    if (req.body.data) {
      try {
        updateData = JSON.parse(req.body.data);
      } catch (err) {
        throw new BadRequestError("Invalid JSON in 'data' field");
      }
    } else {
      updateData = req.body; // Fallback, though unlikely with FormData
    }

    const effectiveEmployerId = getEffectiveEmployerId(user);
    const loggedInUserId = typeof effectiveEmployerId === 'object' && effectiveEmployerId.toHexString ? effectiveEmployerId.toHexString() : effectiveEmployerId?.toString();

    // Find the profile by ID
    const profile = await CompanyProfile.findById(profileId);
    if (!profile) {
      throw new NotFoundError('Company profile not found');
    }


    /**
     * Permission rules
     * ---------------------------------
     * employer   → can update ONLY own profile
     * hr-admin   → can update any profile
     * superadmin → can update any profile
     */
    const profileOwnerId = profile.employer?.toString();
    const isSuperAdmin = user.role === 'superadmin' || user.role === 'hr-admin'; // hr-admin and superadmin can edit any profile
    const isOwner = loggedInUserId === profileOwnerId;

    if (!isSuperAdmin && !isOwner) {
      throw new ForbiddenError('You do not have permission to update this profile');
    }

    // Employer restriction
    // Additional check: Employers can only edit APPROVED profiles
    if (user.role === 'employer' && profile.status !== 'approved' ) {
      throw new ForbiddenError('Company profile must be approved before editing' );
    }

     /**
     * Prevent sensitive fields from being updated
     * -----------------------------------------------
     * Approval & ownership fields must be immutable here
     */
    delete updateData.status;
    delete updateData.approvedBy;
    delete updateData.approvedAt;
    delete updateData.rejectionReason;
    delete updateData.createdBy;
    delete updateData.employer;

    const hasPhoneUpdate =
      Object.prototype.hasOwnProperty.call(updateData, 'landlineNumber') ||
      Object.prototype.hasOwnProperty.call(updateData, 'phoneNumber') ||
      Object.prototype.hasOwnProperty.call(updateData, 'hrPhoneNumber') ||
      Object.prototype.hasOwnProperty.call(updateData, 'publicPhone') ||
      Object.prototype.hasOwnProperty.call(updateData, 'phone') ||
      Object.prototype.hasOwnProperty.call(updateData, 'internalPhone');
    if (hasPhoneUpdate) {
      const phoneValues = normalizeCompanyProfilePhones({
        phone: Object.prototype.hasOwnProperty.call(updateData, 'phone') ? updateData.phone : profile.phone,
        publicPhone: Object.prototype.hasOwnProperty.call(updateData, 'publicPhone') ? updateData.publicPhone : (profile.publicPhone || profile.phone),
        internalPhone: Object.prototype.hasOwnProperty.call(updateData, 'internalPhone') ? updateData.internalPhone : profile.internalPhone,
        landlineNumber: Object.prototype.hasOwnProperty.call(updateData, 'landlineNumber') ? updateData.landlineNumber : profile.landlineNumber,
        phoneNumber: Object.prototype.hasOwnProperty.call(updateData, 'phoneNumber') ? updateData.phoneNumber : (profile.phoneNumber || profile.publicPhone || profile.phone),
        hrPhoneNumber: Object.prototype.hasOwnProperty.call(updateData, 'hrPhoneNumber') ? updateData.hrPhoneNumber : (profile.hrPhoneNumber || profile.internalPhone),
      });
      if (!phoneValues.phoneNumber) {
        throw new BadRequestError('Phone Number is required');
      }
      updateData.phone = phoneValues.phone;
      updateData.publicPhone = phoneValues.publicPhone;
      updateData.internalPhone = phoneValues.internalPhone;
      updateData.landlineNumber = phoneValues.landlineNumber;
      updateData.phoneNumber = phoneValues.phoneNumber;
      updateData.hrPhoneNumber = phoneValues.hrPhoneNumber;
    }

    const shouldRemoveLogo = updateData.removeLogo === true || updateData.removeLogo === 'true';
    delete updateData.removeLogo;

    // Handle file uploads only if provided
    // if (files.logo) {
    //   if (profile.logo) {
    //     const oldLogoPath = path.join(process.cwd(), 'public', profile.logo);
    //     if (fs.existsSync(oldLogoPath)) fs.unlinkSync(oldLogoPath);
    //   }
    //   updateData.logo = `/uploads/company/${files.logo[0].filename}`;
    // }

    // if (files.coverImage) {
    //   if (profile.coverImage) {
    //     const oldCoverPath = path.join(process.cwd(), 'public', profile.coverImage);
    //     if (fs.existsSync(oldCoverPath)) fs.unlinkSync(oldCoverPath);
    //   }
    //   updateData.coverImage = `/uploads/company/${files.coverImage[0].filename}`;
    // }

    // AWS S3 FILE UPDATE
    if (files.logo) {
      updateData.logo = files.logo[0].location; // S3 URL
    } else if (shouldRemoveLogo) {
      updateData.logo = null;
    }

    if (files.coverImage) {
      updateData.coverImage = files.coverImage[0].location; // S3 URL
    }


    //  Parse JSON fields
    // const jsonFields = ['socialMedia', 'location', 'culture', 'founders', 'branches'];
    // jsonFields.forEach(field => {
    //   if (updateData[field] && typeof updateData[field] === 'string') {
    //     try {
    //       updateData[field] = JSON.parse(updateData[field]);
    //     } catch (e) {
    //       throw new BadRequestError(`Invalid format for ${field}`);
    //     }
    //   }
    // });

    const resolvedIndustryId = updateData.industry
      ? await resolveIndustryId(updateData.industry)
      : (profile.industry?._id || profile.industry || null);

    if (updateData.industry) {
      if (!resolvedIndustryId) throw new BadRequestError('Invalid Industry');
      updateData.industry = resolvedIndustryId;
    }

    if (updateData.functionalAreas) {
      const faIds = await resolveFunctionalAreaIds(updateData.functionalAreas, resolvedIndustryId);
      updateData.functionalAreas = faIds;
    }

    if (typeof updateData.companyGSTIN === 'string') {
      updateData.companyGSTIN = updateData.companyGSTIN.trim().toUpperCase();
    }
    if (typeof updateData.panNo === 'string') {
      updateData.panNo = updateData.panNo.trim().toUpperCase();
    }

    const employerUser = await User.findById(profile.employer).select(
      "email contactEmail isSystemGeneratedEmail"
    );
    const requestedUpdateEmail = Object.prototype.hasOwnProperty.call(updateData, "email")
      ? normalizeEmail(updateData.email || "")
      : normalizeEmail(profile.email || "");
    const resolvedCompanyEmail = resolveCompanyEmailForEmployer({
      employerUser,
      requestedEmail: requestedUpdateEmail,
    });
    updateData.email = resolvedCompanyEmail;
    if (Object.prototype.hasOwnProperty.call(updateData, 'establishedSince')) {
      updateData.establishedSince = normalizeEstablishedSince(updateData.establishedSince);
    }

    //  Handle categories array
    // if (updateData.categories) {
    //   updateData.categories = Array.isArray(updateData.categories)
    //     ? updateData.categories
    //     : [updateData.categories];
    // }

    // Update the profile
    const updatedProfile = await CompanyProfile.findByIdAndUpdate(
      profileId,
      { $set: updateData },
      { new: true, runValidators: true }
    );

    /**
     * 🔐 Sync contactEmail for confidential employers
     */
    if (employerUser?.isSystemGeneratedEmail) {
      if (requestedUpdateEmail && !isInternalEmail(requestedUpdateEmail)) {
        employerUser.contactEmail = requestedUpdateEmail;
        await employerUser.save();
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Company profile updated successfully',
      profile: updatedProfile
    });
  } catch (error) {
    //  Cleanup uploaded files if an error occurs
    // if (req.files) {
    //   const files = req.files;
    //   if (files.logo && files.logo[0]) {
    //     const logoPath = path.join(process.cwd(), 'public', `/uploads/company/${files.logo[0].filename}`);
    //     if (fs.existsSync(logoPath)) fs.unlinkSync(logoPath);
    //   }
    //   if (files.coverImage && files.coverImage[0]) {
    //     const coverPath = path.join(process.cwd(), 'public', `/uploads/company/${files.coverImage[0].filename}`);
    //     if (fs.existsSync(coverPath)) fs.unlinkSync(coverPath);
    //   }
    // }
    console.error("Update Company Profile Error:", error);
    next(error);
  }
};


// Get company profile
employerController.getCompanyProfile = async (req, res, next) => {
  try {
    const profileId = req.params.id;
    const { role, id: loggedInUserId } = req.user;

    const profile = await CompanyProfile.findById(profileId)
    .populate('industry', 'name')
    .populate('functionalAreas', 'name');
    if (!profile) {
      throw new NotFoundError('Company profile not found');
    }
    await ensureCompanyId(profile);

    const profileOwnerId = profile.employer.toString();
    const isOwner = loggedInUserId.toString() === profileOwnerId;
    const isAdmin = ['hr-admin', 'superadmin'].includes(role);

    /**
     * Visibility rules
     * -----------------------------
     * candidate           → approved only
     * employer (owner)    → always allowed
     * employer (others)  → approved only
     * hr-admin/superadmin→ always allowed
     */
    // if ( profile.status !== 'approved' && !isOwner && !isAdmin ) {
    //   throw new ForbiddenError('Company profile is not approved yet');
    // }

    // Visibility Rules:
    // candidate           → approved only
    // employer (owner)    → always allowed
    // employer (others)  → ❌ not allowed
    // hr-admin/superadmin→ always allowed

    if (role === 'employer' && !isOwner) {
      throw new ForbiddenError('Access denied');
    }

    if (role === 'candidate' && profile.status !== 'approved') {
      throw new ForbiddenError('Company profile is not approved yet');
    }

    // 🔐 Get employer user to check confidentiality
    const employerUser = await User.findById(profile.employer).select('isSystemGeneratedEmail');

    let profileData = profile.toObject();
    profileData.phoneNumber = profileData.phoneNumber || profileData.publicPhone || profileData.phone || "";
    profileData.hrPhoneNumber = profileData.hrPhoneNumber || profileData.internalPhone || "";
    profileData.landlineNumber = profileData.landlineNumber || "";
    profileData.publicPhone = profileData.phoneNumber;
    profileData.internalPhone = profileData.hrPhoneNumber;
    profileData.phone = profileData.publicPhone;

     /**
     * 🔒 Confidential Masking Logic
     * ---------------------------------
     * If employer is confidential AND
     * viewer is not owner/admin
     */
    if (employerUser?.isSystemGeneratedEmail) {

        const isPrivilegedViewer = isAdmin || isOwner;

        if (!isPrivilegedViewer) {
          // Mask for candidate + hr-admin
          profileData.email = "info@cisproservices.com";
          profileData.phoneNumber = "9361755131";
          profileData.publicPhone = profileData.phoneNumber;
          profileData.phone = profileData.publicPhone;
        } else {
          // Show real HR contact email to owner or superadmin
          profileData.email = employerUser.contactEmail || profileData.email;
        }

    }

    if (!isAdmin && !isOwner) {
      delete profileData.internalPhone;
      delete profileData.hrPhoneNumber;
      delete profileData.landlineNumber;
    }

    // Count active jobs for this company
    const activeJobsCount = await JobPost.countDocuments({
      companyProfile: profileId,
      status: 'Published',
      applicationDeadline: { $gte: new Date() }
    });

    return res.status(200).json({
      success: true,
      profile: profileData,
      activeJobsCount
    });

  } catch (error) {
    next(error);
  }
};


/**
 * Retrieves company profiles for the logged-in employer
 * @param {Object} req - Request object, with authenticated user info in req.user
 * @param {Object} res - Response object to send the result
 * @param {Function} next - Next middleware function for error handling
 */
/**
 * Retrieves company profiles for the logged-in employer
 * @param {Object} req - Request object, with authenticated user info in req.user
 * @param {Object} res - Response object to send the result
 * @param {Function} next - Next middleware function for error handling
 */
employerController.getCompanyProfilesForEmployer = async (req, res, next) => {
  try {
    const employerId = getEffectiveEmployerId(req.user); // safe fallback

    // Fetch only company profiles that belong to this employer and POPULATE references
    const profiles = await CompanyProfile
      .find({ employer: employerId })
      .populate('industry', 'name')           //  POPULATE INDUSTRY NAME
      .populate('functionalAreas', 'name')    //  POPULATE FUNCTIONAL AREAS
      .select('-__v');

    await ensureCompanyIdsForProfiles(profiles);

    // No profiles found
    if (!profiles || profiles.length === 0) {
      return res.status(200).json({
        success: true,
        profiles: [],
        message: "No company profile found for this employer",
      });
    }

    return res.status(200).json({
      success: true,
      profiles,
    });
  } catch (error) {
    next(error);
  }
};




/**
 * Deletes a company profile and associated files
 * @param {Object} req - Request object containing profile ID and user info
 * @param {Object} res - Response object to send back the result
 * @param {Function} next - Next middleware function
 */
employerController.deleteCompanyProfile = async (req, res, next) => {
  try {
    const user = req.user;
    const profileId = req.params.id;

    // Find the profile by ID
    const profile = await CompanyProfile.findById(profileId);
    if (!profile) {
      throw new NotFoundError('Company profile not found');
    }

    // Fetch employer user from users collection
    const employerUser = await User.findById(profile.employer).select('name email');

    // Check permissions: allow if user is superadmin or the original creator (employer)
    const isAdmin = ['superadmin', 'hr-admin'].includes(req.user.role);
    const isOwner = profile.employer._id.toString() === getEffectiveEmployerId(user)?.toString();

    if (!isAdmin && !isOwner) {
      throw new ForbiddenError('You do not have permission to delete this profile');
    }


     // Determine name & email from user table
    const employerName = employerUser?.name || profile.companyName;
    const employerEmail = employerUser?.email || profile.email;

     // Fetch deleting user
    const deletingUser = await User.findById(user.id).select('email role');

     let deletedByLabel = '';
    let superadminMessage = '';

    if (isOwner) {
      deletedByLabel = employerEmail; // candidate/employer email
      superadminMessage = `Employer ${employerEmail} deleted their own company profile`;
    } else {
      deletedByLabel =
        deletingUser?.email ||
        (deletingUser?.role === 'superadmin' ? 'Super Admin' : 'HR Admin');

      superadminMessage = `Company profile deleted for ${employerEmail} by ${deletedByLabel}`;
    }

    // Delete associated files if they exist
    if (profile.logo) {
      const logoPath = path.join(process.cwd(), 'public', profile.logo);
      try {
        await fs.unlink(logoPath);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          console.error(`Failed to delete logo: ${err.message}`);
        }
      }
    }

    // if (profile.coverImage) {
    //   const coverPath = path.join(process.cwd(), 'public', profile.coverImage);
    //   try {
    //     await fs.unlink(coverPath);
    //   } catch (err) {
    //     if (err.code !== 'ENOENT') {
    //       console.error(`Failed to delete cover image: ${err.message}`);
    //     }
    //   }
    // }

    // Delete the profile from the database
    await CompanyProfile.findByIdAndDelete(profileId);

    await createNotification(employerUser?._id || profile.employer, 'profile_update', {
      ...notificationPresets.profileUpdate(
        `Your company profile "${profile.companyName}" has been deleted by ${deletedByLabel}.`
      ),
      title: 'Profile Deleted',
      actionUrl: '/employers-dashboard/company-profile',
      icon: 'la-trash',
      color: '#ef4444',
    });

    // Email employer
    await sendProfileDeletionEmail({
      recipient: employerEmail,
      name: employerName,
      role: 'employer',
      deletedBy: deletedByLabel
    });

    // Mailtrap throttle workaround
    await new Promise(resolve => setTimeout(resolve, 8000)); //remove when in production

    // Notify superadmin
    await sendSuperadminAlertEmail({
      superadminEmail: SUPERADMIN_EMAIL,
      eventType: 'deleted',
      userEmail: employerEmail,
      userRole: 'employer',
      message: superadminMessage,
      actorEmail: deletedByLabel
    });

    return res.status(200).json({
      success: true,
      message: 'Company profile deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Approve or reject company profile
 * HR-Admin / Superadmin only
 */
employerController.approveCompanyProfile = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, rejectionReason } = req.body;
    const adminId = req.user.id;

    if (!['approved', 'rejected'].includes(status)) {
      throw new BadRequestError('Invalid status value');
    }

    const profile = await CompanyProfile.findById(id);
    if (!profile) {
      throw new NotFoundError('Company profile not found');
    }

     // Fetch employer user from users table
    const employerUser = await User.findById(profile.employer).select("name email");

    profile.status = status;
    profile.approvedBy = adminId;
    profile.approvedAt = new Date();
    profile.rejectionReason =
      status === 'rejected' ? rejectionReason : null;

    await profile.save();

    // Who approved
    const adminUser = await User.findById(req.user.id).select('email role');
    const actionBy = adminUser?.email || (adminUser?.role === 'superadmin' ? 'Super Admin' : 'HR Admin');

    const employerName = employerUser?.name || profile.companyName;
    const employerEmail = employerUser?.email || profile.email;

    // Send email to employer
    await sendCompanyProfileStatusEmail({
      recipient: employerEmail,
      name: employerName,
      companyName: profile.companyName,
      status,
      rejectionReason,
      dashboardUrl: `${process.env.FRONTEND_URL}employer-dashboard/dashboard`,
      actionBy
    });
    const companyStatusLabel = status.charAt(0).toUpperCase() + status.slice(1);
    await createNotification(employerUser._id, 'profile_update', {
      ...notificationPresets.profileUpdate(
        `Your company profile "${profile.companyName}" has been ${status}.`
      ),
      title: `Company Profile Status: ${companyStatusLabel}`,
      actionUrl: '/employers-dashboard/company-profile',
      icon: status === 'approved' ? 'la-check-circle' : 'la-times-circle',
      color: status === 'approved' ? '#22c55e' : '#ef4444',
    });

    // Mailtrap throttle workaround
    await new Promise(resolve => setTimeout(resolve, 8000));

    // Notify superadmin
    await sendSuperadminAlertEmail({
      superadminEmail: SUPERADMIN_EMAIL,
      eventType: status === 'approved' ? 'approved' : 'rejected',
      newUserEmail: employerEmail,
      newUserRole: 'employer',
      message: `Company profile ${status} for ${employerEmail} by ${actionBy}`,
      actorEmail: actionBy
    });

    return res.status(200).json({
      success: true,
      message: `Company profile ${status} successfully`,
      profile
    });
  } catch (error) {
    next(error);
  }
};


// employer.controller.js (add these)

/**
 * Save a candidate profile to employer's talent pool
 * @route POST /api/employer/saved-candidates/:candidateId
 */
employerController.saveCandidate = async (req, res, next) => {
  try {
    const employerId = getEffectiveEmployerId(req.user);
    const candidateId = req.params.candidateId;
    const candidateProfileId = req.params.candidateId;

    // const candidateProfile = await CandidateProfile.findOne({ candidate: candidateId });
    // if (!candidateProfile) throw new NotFoundError('Candidate not found');
    const candidateProfile = await CandidateProfile.findById(candidateProfileId);
    if (!candidateProfile) throw new NotFoundError("Candidate not found");

    const candidateUserId = candidateProfile.candidate.toString();

    const existingSave = await SavedCandidate.findOne({ employer: employerId, candidate: candidateUserId });
    if (existingSave) throw new BadRequestError('Candidate already saved');

    const newSave = new SavedCandidate({
      employer: employerId,
      candidate: candidateUserId,
      candidateProfile: candidateProfile._id,
      notes: req.body.notes || '',
      folder: req.body.folder || 'General',
    });

    await newSave.save();

    // Increment savedCount on profile
    await CandidateProfile.updateOne({ _id: candidateProfile._id }, { $inc: { savedCount: 1 } });

    res.status(201).json({
      success: true,
      message: 'Candidate saved to talent pool',
      savedCandidate: newSave
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Unsave a candidate from talent pool
 * @route DELETE /api/employer/saved-candidates/:savedId
 */
employerController.unsaveCandidate = async (req, res, next) => {
  try {
    const employerId = getEffectiveEmployerId(req.user);
    const savedId = req.params.savedId;

    // console.log("testtttt", savedId);
    

    const saved = await SavedCandidate.findById(savedId);
    if (!saved || saved.employer.toString() !== employerId.toString()) throw new NotFoundError('Saved candidate not found');

    const candidateProfileId = saved.candidateProfile;

    await saved.deleteOne();

    // Decrement savedCount
    await CandidateProfile.updateOne({ _id: candidateProfileId }, { $inc: { savedCount: -1 } });

    res.status(200).json({
      success: true,
      message: 'Candidate removed from talent pool'
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get employer's saved candidates with filters
 * @route GET /api/employer/saved-candidates?folder=General&search=John&page=1&limit=10
 */
employerController.getSavedCandidates = async (req, res, next) => {
  try {
    const employerId = getEffectiveEmployerId(req.user);
    const { folder, search, page = 1, limit = 10 } = req.query;

    let query = { employer: employerId };
    if (folder) query.folder = folder;

    const total = await SavedCandidate.countDocuments(query);

    const saved = await SavedCandidate.find(query)
      .populate({
        path: 'candidateProfile',
        select: 'fullName jobTitle location profilePhoto expectedSalary categories'
      })
      .populate('candidate', 'name email')
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      savedCandidates: saved,
      pagination: { page: parseInt(page), totalPages: Math.ceil(total / limit), total, limit: parseInt(limit) }
    });
  } catch (error) {
    next(error);
  }
};


/**
 * Get all active (Published) jobs posted by a specific employer/company
 * @route GET /api/employer-dashboard/company/:id/jobs?limit=10&page=1
 * @access Public
 */
employerController.getActiveJobsByEmployer = async (req, res, next) => {
  try {
    const companyId = req.params.id;

    // Validate company exists
    const company = await CompanyProfile.findById(companyId);
    if (!company) {
      throw new NotFoundError('Company not found');
    }

    const { limit = 10, page = 1 } = req.query;

    const jobs = await JobPost.find({
      companyProfile: companyId,
      status: 'Published',
      applicationDeadline: { $gte: new Date() }
    })
      .select('title location jobType offeredSalary positions remoteWork createdAt')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await JobPost.countDocuments({
      companyProfile: companyId,
      status: 'Published',
      applicationDeadline: { $gte: new Date() }
    });

    res.status(200).json({
      success: true,
      companyName: company.companyName,
      totalJobs: total,
      jobs,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        total,
        limit: parseInt(limit)
      }
    });
  } catch (error) {
    next(error);
  }
};


/**
 * Fetch company profiles created by hr-admin or all for superadmin
 */
employerController.getAssignedCompanyProfiles = async (req, res, next) => {
  try {
    const loggedInUser = await User.findById(req.user.id)
      .select('role employerIds');

    if (!loggedInUser) {
      return res.status(401).json({ message: 'User not found' });
    }

    let query = {};

    /**
     * HR-ADMIN rules
     * -------------------------
     * 1. Profiles created by hr-admin
     * 2. Profiles belonging to assigned employers
     */
    if (loggedInUser.role === 'hr-admin') {
      query = {
        $or: [
          { createdBy: loggedInUser._id },
          { employer: { $in: loggedInUser.employerIds || [] } }
        ]
      };
    }

    // SUPERADMIN → sees all
    // POPULATE industry here as well
    if (loggedInUser.role === 'superadmin') {
      query = {};
    }

    const profiles = await CompanyProfile.find(query)
      .populate('industry', 'name') // <-- ADD THIS LINE
      .select('-__v')
      .sort({ createdAt: -1 });

    await ensureCompanyIdsForProfiles(profiles);
    const profilesWithDemandCounts = await attachDemandCandidateCounts(profiles);

    res.status(200).json({
      success: true,
      count: profilesWithDemandCounts.length,
      data: profilesWithDemandCounts
    });

  } catch (error) {
    next(error);
  }
};

employerController.getCompanyCandidateActivity = async (req, res, next) => {
  try {
    const { companyProfileId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(companyProfileId)) {
      throw new BadRequestError("Invalid company profile id");
    }

    const companyProfile = await CompanyProfile.findById(companyProfileId)
      .select("companyName employer")
      .lean();

    if (!companyProfile) {
      throw new NotFoundError("Company profile not found");
    }

    const employerId = companyProfile.employer;
    const activityMap = new Map();

    const upsertActivity = ({ candidateId, candidate, candidateProfile, viewDate, downloadDate, viewCount = 0, downloadCount = 0 }) => {
      const key = getObjectIdString(candidateId || candidate?._id || candidateProfile?.candidate);
      if (!key) return;

      const existing = activityMap.get(key) || {
        candidateId: key,
        candidateName: candidateProfile?.fullName || candidate?.name || "N/A",
        candidateEmail: candidateProfile?.email || candidate?.email || "N/A",
        candidatePhone: candidateProfile?.phone || candidate?.phone || "N/A",
        candidateProfileId: candidateProfile?._id || null,
        candidateRole: candidateProfile?.role?.name || candidateProfile?.jobTitle || "N/A",
        candidateLocation: candidateProfile?.location?.city || "N/A",
        profileViewCount: 0,
        resumeDownloadCount: 0,
        lastProfileViewedAt: null,
        lastResumeDownloadedAt: null,
        lastActivityAt: null,
      };

      existing.candidateName = existing.candidateName !== "N/A" ? existing.candidateName : (candidateProfile?.fullName || candidate?.name || "N/A");
      existing.candidateEmail = existing.candidateEmail !== "N/A" ? existing.candidateEmail : (candidateProfile?.email || candidate?.email || "N/A");
      existing.candidatePhone = existing.candidatePhone !== "N/A" ? existing.candidatePhone : (candidateProfile?.phone || candidate?.phone || "N/A");
      existing.candidateProfileId = existing.candidateProfileId || candidateProfile?._id || null;
      existing.candidateRole = existing.candidateRole !== "N/A" ? existing.candidateRole : (candidateProfile?.role?.name || candidateProfile?.jobTitle || "N/A");
      existing.candidateLocation = existing.candidateLocation !== "N/A" ? existing.candidateLocation : (candidateProfile?.location?.city || "N/A");
      existing.profileViewCount += Number(viewCount || 0);
      existing.resumeDownloadCount += Number(downloadCount || 0);
      existing.lastProfileViewedAt = pickLatestDate(existing.lastProfileViewedAt, viewDate);
      existing.lastResumeDownloadedAt = pickLatestDate(existing.lastResumeDownloadedAt, downloadDate);
      existing.lastActivityAt = pickLatestDate(existing.lastProfileViewedAt, existing.lastResumeDownloadedAt);

      activityMap.set(key, existing);
    };

    const activities = await CandidateEmployerActivity.find({ employer: employerId })
      .populate("candidate", "name email phone profilePhoto")
      .populate({
        path: "candidateProfile",
        select: "fullName jobTitle email phone location profilePhoto role candidate",
        populate: { path: "role", select: "name" },
      })
      .sort({ lastActivityAt: -1 })
      .lean();

    activities.forEach((activity) => {
      upsertActivity({
        candidateId: activity.candidate?._id || activity.candidate,
        candidate: activity.candidate,
        candidateProfile: activity.candidateProfile,
        viewDate: activity.lastProfileViewedAt,
        downloadDate: activity.lastResumeDownloadedAt,
        viewCount: activity.profileViewCount,
        downloadCount: activity.resumeDownloadCount,
      });
    });

    const viewedProfiles = await CandidateProfile.find({
      "uniqueViewers.viewer": employerId,
    })
      .select("candidate fullName jobTitle email phone location role uniqueViewers")
      .populate("role", "name")
      .lean();

    viewedProfiles.forEach((profile) => {
      const key = getObjectIdString(profile.candidate);
      const existing = activityMap.get(key);
      if (existing?.profileViewCount > 0) return;

      const matchingViews = (profile.uniqueViewers || []).filter((viewer) => (
        getObjectIdString(viewer.viewer) === getObjectIdString(employerId)
      ));
      const lastViewed = pickLatestDate(...matchingViews.map((viewer) => viewer.lastViewed));

      upsertActivity({
        candidateId: profile.candidate,
        candidateProfile: profile,
        viewDate: lastViewed,
        viewCount: matchingViews.length || 1,
      });
    });

    const [profileDownloadLogs, applicantDownloadLogs] = await Promise.all([
      ResumeDownloadLog.aggregate([
        { $match: { employer: employerId } },
        {
          $group: {
            _id: "$candidate",
            count: { $sum: "$downloadCount" },
            lastDownloadedAt: { $max: "$downloadedAt" },
          },
        },
      ]),
      EmployerResumeDownloadLog.aggregate([
        { $match: { employer: employerId } },
        {
          $group: {
            _id: "$candidate",
            count: { $sum: 1 },
            lastDownloadedAt: { $max: "$downloadedAt" },
          },
        },
      ]),
    ]);

    const downloadedCandidateIds = [
      ...new Set(
        [...profileDownloadLogs, ...applicantDownloadLogs]
          .map((item) => item?._id)
          .filter(Boolean)
          .map((id) => id.toString())
      ),
    ];

    const downloadedProfiles = downloadedCandidateIds.length
      ? await CandidateProfile.find({ candidate: { $in: downloadedCandidateIds } })
          .select("candidate fullName jobTitle email phone location role")
          .populate("role", "name")
          .lean()
      : [];
    const downloadedProfileMap = new Map(downloadedProfiles.map((profile) => [getObjectIdString(profile.candidate), profile]));

    [...profileDownloadLogs, ...applicantDownloadLogs].forEach((log) => {
      const key = getObjectIdString(log._id);
      const existing = activityMap.get(key);
      if (existing?.resumeDownloadCount > 0) return;

      upsertActivity({
        candidateId: log._id,
        candidateProfile: downloadedProfileMap.get(getObjectIdString(log._id)),
        downloadDate: log.lastDownloadedAt,
        downloadCount: Number(log.count || 0),
      });
    });

    const candidateActivity = Array.from(activityMap.values())
      .map((activity) => ({
        ...activity,
        profileViewed: activity.profileViewCount > 0,
        resumeDownloaded: activity.resumeDownloadCount > 0,
      }))
      .sort((a, b) => {
        const aTime = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0;
        const bTime = b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : 0;
        return bTime - aTime;
      });

    return res.status(200).json({
      success: true,
      companyProfile: {
        _id: companyProfile._id,
        companyName: companyProfile.companyName,
      },
      count: candidateActivity.length,
      activity: candidateActivity,
    });
  } catch (error) {
    next(error);
  }
};



// employerDashboardController.getSummary = async (req, res, next) => {
//   try {
//     const employerId = req.user.id;

//     const jobs = await JobPost.find({ employer: employerId });
//     const jobIds = jobs.map(j => j._id);

//     const totalJobs = jobs.length;

//     const applicationsAgg = await Application.aggregate([
//       { $match: { jobPost: { $in: jobIds } } },
//       {
//         $group: {
//           _id: "$status",
//           count: { $sum: 1 }
//         }
//       }
//     ]);

//     const totalApplications = applicationsAgg.reduce((a, b) => a + b.count, 0);
//     const shortlisted = await Application.countDocuments({
//       jobPost: { $in: jobIds },
//       shortlisted: true
//     });

//     const recentApplicants = await Application.find({
//       jobPost: { $in: jobIds }
//     })
//       .populate("candidate", "name profilePhoto")
//       .populate("candidateProfile", "jobTitle")
//       .populate("jobPost", "title")
//       .sort({ createdAt: -1 })
//       .limit(5);

//     res.json({
//       success: true,
//       metrics: {
//         totalJobs,
//         totalApplications,
//         shortlisted,
//       },
//       recentApplicants
//     });
//   } catch (err) {
//     next(err);
//   }
// };


export default employerController;
