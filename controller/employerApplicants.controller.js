import mongoose from "mongoose";
import Application from '../models/jobApply.model.js';
import JobPost from '../models/jobs.model.js';
import CandidateProfile from '../models/candidateProfile.model.js';
import CompanyProfile from '../models/companyProfile.model.js';
import User from '../models/user.model.js';
import EmployerResumeDownloadLog from '../models/employerResumeDownloadLog.model.js';
import CandidateEmployerActivity from '../models/candidateEmployerActivity.model.js';
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { canManageJob, buildJobQueryForUser, getEffectiveEmployerId } from '../utils/roleHelper.js';
import { BadRequestError, NotFoundError, ForbiddenError } from '../utils/errors.js';
import { sendApplicationStatusUpdateEmail, sendEmployerApplicantsReleasedEmail } from '../utils/mailer.js';
import { createNotification, notificationPresets } from '../utils/notificationHelper.js';
import { sendPushToUsers } from '../utils/fcm.js';
import { getPrivateFileUrl } from '../utils/s3SignedUrl.js';
import { s3 } from "../config/aws-s3.js";
import {
  getEmployerResumeDownloadUsage,
  getFeatureLimit,
  requireEmployerResumeDownloadLimit,
  resolveEmployerPlan,
} from '../utils/employerPlanAccess.js';

const employerApplicantsController = {};

const isAdminUser = (user) => ['hr-admin', 'sub-admin', 'superadmin'].includes(user?.role);

const applyEmployerReleaseGate = (query, user) => {
  if (user?.role === 'employer') {
    query.releasedToEmployer = true;
  }
  return query;
};

const ensureEmployerCanAccessApplication = (application, user) => {
  if (user?.role === 'employer' && !application?.releasedToEmployer) {
    throw new ForbiddenError('This application is waiting for admin approval');
  }
};

const MONTHLY_RESUME_LIMIT = 5;

const getCandidateApplicationNotification = (status, jobTitle) => {
  if (status === 'Accepted') {
    return {
      type: 'application_selected',
      data: notificationPresets.applicationSelected(jobTitle),
    };
  }

  if (status === 'Rejected') {
    return {
      type: 'application_rejected',
      data: {
        title: 'Application Status Update',
        description: `Unfortunately, your application for ${jobTitle} was not selected this time. Keep applying for more opportunities.`,
        icon: 'la-times-circle',
        color: '#ef4444',
      },
    };
  }

  return {
    type: 'application_reviewed',
    data: notificationPresets.applicationReviewed(jobTitle),
  };
};

const getIstMonthKey = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
  }).format(new Date());

const getIstMonthLabel = () =>
  new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    month: "long",
    year: "numeric",
  }).format(new Date());

const buildResumeKeyCandidates = (resumeValue) => {
  if (!resumeValue || typeof resumeValue !== "string") return [];

  let key = resumeValue.trim();

  if (key.startsWith("https://") && key.includes(".amazonaws.com/")) {
    key = key.split(".amazonaws.com/")[1] || "";
  }

  if (!key) return [];

  const normalized = key.replace(/^\/+/, "");
  const candidates = new Set([key, normalized]);

  if (normalized.startsWith("uploads/candidate/")) {
    const fileName = normalized.split("uploads/candidate/")[1];
    if (fileName) {
      candidates.add(`uploads/candidate/${fileName}`);
      candidates.add(`resumes/${fileName}`);
      candidates.add(`candidate-cvs/${fileName}`);
    }
  }

  return [...candidates].filter(Boolean);
};

const resolveExistingResumeKey = async (resumeValue) => {
  const possibleKeys = buildResumeKeyCandidates(resumeValue);

  for (const key of possibleKeys) {
    try {
      await s3.send(
        new HeadObjectCommand({
          Bucket: process.env.AWS_S3_BUCKET,
          Key: key,
        })
      );
      return key;
    } catch (error) {
      // try next candidate key
    }
  }

  return null;
};

const resolveApplicationResumeValue = async (application) => {
  if (!application) return "";

  const candidateProfileResume = application.candidateProfile?.resume || "";
  const applicationResume = application.resume || "";

  if (candidateProfileResume) return candidateProfileResume;
  if (applicationResume) return applicationResume;

  const latestApplication = await Application.findOne({ candidate: application.candidate?._id || application.candidate })
    .select('resume createdAt')
    .sort({ createdAt: -1 });

  return latestApplication?.resume || "";
};

const buildResumeQuotaResponse = async ({ user, jobId = null }) => {
  const monthKey = getIstMonthKey();
  let resumeFeature = {
    enabled: true,
    limit: MONTHLY_RESUME_LIMIT,
    cycle: 'Monthly',
  };

  if (user.role === 'employer') {
    const plan = await resolveEmployerPlan(user.id);
    resumeFeature = getFeatureLimit(plan, 'resumeDownloads', 'resumeLimit');
  }

  const jobQuery = buildJobQueryForUser(user);
  const jobs = await JobPost.find(jobQuery)
    .select("_id title status applicantCount createdAt")
    .sort({ createdAt: -1 })
    .lean();

  const jobIds = jobs.map((job) => job._id);

  const usageAgg = jobIds.length
    ? await EmployerResumeDownloadLog.aggregate([
        {
          $match: {
            employer: user.id,
            monthKey,
            jobPost: { $in: jobIds },
          },
        },
        {
          $group: {
            _id: "$jobPost",
            downloadsUsed: { $sum: 1 },
            lastDownloadedAt: { $max: "$downloadedAt" },
          },
        },
      ])
    : [];

  const usageMap = new Map(
    usageAgg.map((item) => [
      String(item._id),
      {
        downloadsUsed: Number(item.downloadsUsed || 0),
        lastDownloadedAt: item.lastDownloadedAt || null,
      },
    ])
  );

  const employerUsage = await getEmployerResumeDownloadUsage(user.id, resumeFeature.cycle);
  const totalDownloadsUsed = employerUsage.total;
  const downloadsRemaining =
    resumeFeature.limit === -1
      ? -1
      : Math.max(Number(resumeFeature.limit || 0) - totalDownloadsUsed, 0);

  const jobsWithUsage = jobs.map((job) => {
    const usage = usageMap.get(String(job._id)) || { downloadsUsed: 0, lastDownloadedAt: null };

    return {
      jobId: job._id,
      title: job.title,
      status: job.status,
      applicantCount: job.applicantCount || 0,
      downloadsUsed: usage.downloadsUsed,
      downloadsRemaining,
      limit: resumeFeature.limit,
      limitScope: 'employer',
      cycle: resumeFeature.cycle,
      monthKey,
      monthLabel: getIstMonthLabel(),
      lastDownloadedAt: usage.lastDownloadedAt,
      isSelected: jobId ? String(job._id) === String(jobId) : false,
    };
  });

  const selectedJob = jobsWithUsage.find((job) => job.isSelected) || jobsWithUsage[0] || null;

  return {
    limitPerJob: resumeFeature.limit,
    limitPerEmployer: resumeFeature.limit,
    limitScope: 'employer',
    cycle: resumeFeature.cycle,
    monthKey,
    monthLabel: getIstMonthLabel(),
    selectedJob,
    jobs: jobsWithUsage,
    summary: {
      totalJobs: jobsWithUsage.length,
      totalDownloadsUsed,
      downloadsRemaining,
      profileDownloads: employerUsage.profileDownloads,
      applicantDownloads: employerUsage.applicantDownloads,
    },
  };
};

const buildApplicantCompanyNameMaps = async (applicants = []) => {
  const companyProfileIds = [
    ...new Set(
      applicants
        .map((app) => app.jobPost?.companyProfile)
        .filter(Boolean)
        .map((id) => String(id))
    ),
  ];

  const employerIds = [
    ...new Set(
      applicants
        .map((app) => app.jobPost?.employer)
        .filter(Boolean)
        .map((id) => String(id))
    ),
  ];

  const [companyProfiles, employers] = await Promise.all([
    companyProfileIds.length
      ? CompanyProfile.find({ _id: { $in: companyProfileIds } })
          .select('_id employer companyName')
          .lean()
      : [],
    employerIds.length
      ? User.find({ _id: { $in: employerIds } })
          .select('_id name')
          .lean()
      : [],
  ]);

  return {
    companyProfileMap: new Map(
      companyProfiles.map((profile) => [String(profile._id), profile.companyName])
    ),
    employerCompanyMap: new Map(
      companyProfiles
        .filter((profile) => profile.employer)
        .map((profile) => [String(profile.employer), profile.companyName])
    ),
    employerNameMap: new Map(
      employers.map((employer) => [String(employer._id), employer.name])
    ),
  };
};

/**
 * Get all applicants for a specific job with filters.
 * @param {Object} req - Request object with query params
 * @param {Object} res - Response object
 * @param {Function} next - Next middleware function
 */
employerApplicantsController.getApplicantsByJob = async (req, res, next) => {
  try {
    const employerId = getEffectiveEmployerId(req.user);
    const jobId = req.params.jobId;
    const {
      status,
      dateRange,
      page = 1,
      limit = 10,
      search,
      appliedDateSort = 'newest',
    } = req.query;
    const sortDirection = appliedDateSort === 'oldest' ? 1 : -1;

    //  Validate job ownership
    const jobPost = await JobPost.findById(jobId);

    // old ownership check
    // if (!jobPost || jobPost.employer.toString() !== employerId.toString()) {
    //   throw new ForbiddenError("You do not have permission to view applicants for this job");
    // }


    // console.log("tttttttttttttttttttttt", canManageJob());
    

    // new ownership check using role helper
    if (!canManageJob(jobPost, req.user)) {
      throw new ForbiddenError('You do not have permission to view applicants for this job');
    }

    //  Build initial match query
    const matchQuery = applyEmployerReleaseGate({ jobPost: new mongoose.Types.ObjectId(jobId) }, req.user);
    
    // Filter by status if provided
    if (status && status !== "All") {
      matchQuery.status = status;
    }

    // Filter by date range (e.g. "Last 12 Months", "Last 5 year")
    if (dateRange && dateRange !== "All") {
      const months = {
        "Last 12 Months": 12,
        "Last 16 Months": 16,
        "Last 24 Months": 24,
        "Last 5 year": 60,
      };
      const cutoffDate = new Date();
      cutoffDate.setMonth(cutoffDate.getMonth() - (months[dateRange] || 12));
      matchQuery.createdAt = { $gte: cutoffDate };
    }

    // Build aggregation pipeline
    const pipeline = [
      // Match applications for this job
      { $match: matchQuery },

      // Join candidate basic info (users collection)
      {
        $lookup: {
          from: "users",
          localField: "candidate",
          foreignField: "_id",
          as: "candidate",
        },
      },
      { $unwind: { path: "$candidate", preserveNullAndEmptyArrays: true } },

      // Join candidate profile details (candidateprofiles collection)
      {
        $lookup: {
          from: "candidateprofiles",
          localField: "candidateProfile",
          foreignField: "_id",
          as: "candidateProfile",
        },
      },
      { $unwind: { path: "$candidateProfile", preserveNullAndEmptyArrays: true } },

      // Join job post info (jobposts collection)
      {
        $lookup: {
          from: "jobposts",
          localField: "jobPost",
          foreignField: "_id",
          as: "jobPost",
        },
      },
      { $unwind: { path: "$jobPost", preserveNullAndEmptyArrays: true } },
    ];

    // Apply text search across joined fields
    if (search) {
      const regex = new RegExp(search, "i");
      pipeline.push({
        $match: {
          $or: [
            { "candidate.name": regex },
            { "candidate.email": regex },
            { "candidateProfile.fullName": regex },
            { "candidateProfile.email": regex },
            { "candidateProfile.jobTitle": regex },
          ],
        },
      });
    }

    //  Sorting + Pagination + Counting
    pipeline.push(
      { $sort: { createdAt: sortDirection } },
      {
        $facet: {
          // Paginated result set
          data: [
            { $skip: (parseInt(page) - 1) * parseInt(limit) },
            { $limit: parseInt(limit) },
          ],

          // Count total documents
          totalCount: [{ $count: "count" }],

          // Group by status for tab counts
          statusCounts: [
            { $group: { _id: "$status", count: { $sum: 1 } } },
          ],
        },
      }
    );

    // Execute aggregation
    const [result] = await Application.aggregate(pipeline);
    // console.log("testty", result);

    const applicants = result?.data || [];
    const total = result?.totalCount?.[0]?.count || 0;
    const statusCounts = result?.statusCounts || [];

    // Prepare counts for UI tabs
    const counts = {
      Total: total,
      Pending: statusCounts.find((s) => s._id === "Pending")?.count || 0,
      Reviewed: statusCounts.find((s) => s._id === "Reviewed")?.count || 0,
      Accepted: statusCounts.find((s) => s._id === "Accepted")?.count || 0,
      Rejected: statusCounts.find((s) => s._id === "Rejected")?.count || 0,
    };

    //  Format applicants for frontend
    const formattedApplicants = applicants.map((app) => ({
      id: app.candidate?._id,
      name: app.candidateProfile?.fullName || app.candidate?.name || "N/A",
      email: app.candidate?.email || "N/A",
      designation: app.candidateProfile?.jobTitle || "N/A",
      location: app.candidateProfile?.location?.city || "N/A",
      expectedSalary: app.candidateProfile?.expectedSalary || "N/A",
      tags: app.candidateProfile?.categories || [],
      avatar:
        app.candidateProfile?.profilePhoto ||
        app.candidate?.profilePhoto ||
        "/default-avatar.jpg",
      status: app.status,
      candidateJoinConfirmation: app.candidateJoinConfirmation || 'not_required',
      candidateJoinConfirmedAt: app.candidateJoinConfirmedAt || null,
      selectedAt: app.selectedAt || null,
      appliedAt: app.createdAt,
      resume: app.resume,
      applicationId: app._id,
    }));

    // Send response
    return res.status(200).json({
      success: true,
      applicants: formattedApplicants,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        total,
        limit: parseInt(limit),
      },
      statusCounts: counts,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get all applicants across all jobs user is allowed to see
 * @route GET /api/employer/applicants
 * @access Employer (own), HR-Admin (all), Superadmin (all)
 */
employerApplicantsController.getAllApplicants = async (req, res, next) => {
  try {
    const user = req.user;
    const {
      status,
      dateRange,
      page = 1,
      limit = 10,
      search,
      jobId,
      appliedDateSort = 'newest',
    } = req.query;
    const sortDirection = appliedDateSort === 'oldest' ? 1 : -1;
    console.log("loggedin", user);
    // --------------------------------------------------
    // Determine which jobs the user can see
    // --------------------------------------------------
    let jobQuery = {};

    if (user.role === 'employer') {
      // Regular employer: only their own jobs
      jobQuery = { employer: user.id };
    } else if (user.role === 'hr-admin' || user.role === 'superadmin') {
      // HR-Admin & Superadmin: see ALL jobs
      jobQuery = {};
    } else {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    

    const jobs = await JobPost.find(jobQuery).select('_id');

    // console.log("testtttttttttttttttting", jobs);


    if (!jobs.length) {
      return res.status(200).json({
        success: true,
        applicants: [],
        pagination: { currentPage: Number(page), totalPages: 0, total: 0, limit: Number(limit) },
        statusCounts: { Total: 0, Pending: 0, Reviewed: 0, Accepted: 0, Rejected: 0 },
      });
    }

    const allowedJobIds = jobs.map((j) => j._id.toString());

    const matchQuery = applyEmployerReleaseGate({ jobPost: { $in: jobs.map(j => j._id) } }, req.user);

    // Optional single job filter
    if (jobId) {
      if (!mongoose.Types.ObjectId.isValid(jobId)) {
        return res.status(400).json({ success: false, message: 'Invalid jobId' });
      }
      if (!allowedJobIds.includes(jobId.toString())) {
        return res.status(403).json({ success: false, message: 'Forbidden job access' });
      }
      matchQuery.jobPost = new mongoose.Types.ObjectId(jobId);
    }

    if (status && status !== 'All') matchQuery.status = status;

    if (dateRange && dateRange !== 'All') {
      const months = { 'Last 12 Months': 12, 'Last 16 Months': 16, 'Last 24 Months': 24, 'Last 5 year': 60 };
      const cutoffDate = new Date();
      cutoffDate.setMonth(cutoffDate.getMonth() - (months[dateRange] || 12));
      matchQuery.createdAt = { $gte: cutoffDate };
    }

    // --------------------------------------------------
    // Rest of your aggregation pipeline remains EXACTLY the same
    // --------------------------------------------------
    const pipeline = [
      { $match: matchQuery },
      { $lookup: { from: 'users', localField: 'candidate', foreignField: '_id', as: 'candidate' } },
      { $unwind: { path: '$candidate', preserveNullAndEmptyArrays: true } },
      { $lookup: { from: 'candidateprofiles', localField: 'candidateProfile', foreignField: '_id', as: 'candidateProfile' } },
      { $unwind: { path: '$candidateProfile', preserveNullAndEmptyArrays: true } },
      { $lookup: { from: 'jobposts', localField: 'jobPost', foreignField: '_id', as: 'jobPost' } },
      { $unwind: { path: '$jobPost', preserveNullAndEmptyArrays: true } },
      { $lookup: { from: 'companyprofiles', localField: 'jobPost.companyProfile', foreignField: '_id', as: 'companyProfile' } },
      { $unwind: { path: '$companyProfile', preserveNullAndEmptyArrays: true } },
      { $lookup: { from: 'users', localField: 'jobPost.employer', foreignField: '_id', as: 'employerUser' } },
      { $unwind: { path: '$employerUser', preserveNullAndEmptyArrays: true } },
    ];

    if (search) {
      const regex = new RegExp(search, 'i');
      pipeline.push({
        $match: {
          $or: [
            { 'candidate.name': regex },
            { 'candidate.email': regex },
            { 'candidateProfile.fullName': regex },
            { 'candidateProfile.email': regex },
            { 'candidateProfile.jobTitle': regex },
          ],
        },
      });
    }

    pipeline.push(
      { $sort: { createdAt: sortDirection } },
      {
        $facet: {
          data: [
            { $skip: (page - 1) * limit },
            { $limit: Number(limit) },
          ],
          totalCount: [{ $count: 'count' }],
          statusCounts: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
        },
      }
    );

    const [result] = await Application.aggregate(pipeline);

    const applicants = result.data || [];
    const total = result.totalCount?.[0]?.count || 0;

    const statusCounts = {
      Total: total,
      Pending: result.statusCounts.find(s => s._id === 'Pending')?.count || 0,
      Reviewed: result.statusCounts.find(s => s._id === 'Reviewed')?.count || 0,
      Accepted: result.statusCounts.find(s => s._id === 'Accepted')?.count || 0,
      Rejected: result.statusCounts.find(s => s._id === 'Rejected')?.count || 0,
    };

    const { companyProfileMap, employerCompanyMap, employerNameMap } =
      await buildApplicantCompanyNameMaps(applicants);

    const formattedApplicants = applicants.map(app => ({
      id: app.candidate?._id,
      name: app.candidateProfile?.fullName || app.candidate?.name || 'N/A',
      email: app.candidate?.email || 'N/A',
      jobPostId: app.jobPost?._id || null,
      candidateProfileId: app.candidateProfile?._id || '',
      designation: app.candidateProfile?.jobTitle || 'N/A',
      location: app.candidateProfile?.location || {},
      expectedSalary: app.candidateProfile?.expectedSalary || 'N/A',
      tags: app.candidateProfile?.categories || [],
      avatar: app.candidateProfile?.profilePhoto || app.candidate?.profilePhoto || '/default-avatar.jpg',
      status: app.status,
      candidateJoinConfirmation: app.candidateJoinConfirmation || 'not_required',
      candidateJoinConfirmedAt: app.candidateJoinConfirmedAt || null,
      selectedAt: app.selectedAt || null,
      shortlisted: app.shortlisted || false,
      appliedAt: app.createdAt,
      resume: app.resume,
      applicationId: app._id,
      jobTitle: app.jobPost?.title || 'N/A',
      employerId: app.jobPost?.employer,
      companyName:
        companyProfileMap.get(String(app.jobPost?.companyProfile || '')) ||
        employerCompanyMap.get(String(app.jobPost?.employer || '')) ||
        employerNameMap.get(String(app.jobPost?.employer || '')) ||
        'N/A',
    }));

    return res.status(200).json({
      success: true,
      applicants: formattedApplicants,
      pagination: {
        currentPage: Number(page),
        totalPages: Math.ceil(total / limit),
        total,
        limit: Number(limit),
      },
      statusCounts,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get applicants for jobs belonging to HR-Admin assigned employers
 *
 * @route   GET /api/hr-admin/applicants
 * @access  Private (HR-Admin, Superadmin)
 */
employerApplicantsController.getHrAdminEmployersApplicants = async (req, res, next) => {
  try {
    const {
      status,
      dateRange,
      page = 1,
      limit = 10,
      search,
      jobId,
      appliedDateSort = 'newest',
    } = req.query;
    const sortDirection = appliedDateSort === 'oldest' ? 1 : -1;

    // Assigned scope:
    // hr-admin    -> jobs posted by employers assigned to this hr-admin
    // superadmin  -> jobs posted by employers assigned to any hr-admin
    let assignedEmployerIds = [];

    if (req.user.role === 'hr-admin') {
      const currentHrAdmin = await User.findById(req.user.id).select('employerIds');
      assignedEmployerIds = (currentHrAdmin?.employerIds || []).map((id) => id.toString());
    } else if (req.user.role === 'superadmin') {
      const hrAdmins = await User.find({ role: 'hr-admin', isActive: true }).select('employerIds');
      assignedEmployerIds = [
        ...new Set(
          hrAdmins.flatMap((hr) => (hr.employerIds || []).map((id) => id.toString()))
        ),
      ];
    }

    if (!assignedEmployerIds.length) {
      return res.status(200).json({
        success: true,
        applicants: [],
        pagination: {
          currentPage: Number(page),
          totalPages: 0,
          total: 0,
          limit: Number(limit),
        },
        statusCounts: {
          Total: 0,
          Pending: 0,
          Reviewed: 0,
          Accepted: 0,
          Rejected: 0,
        },
      });
    }

    const jobs = await JobPost.find({
      employer: { $in: assignedEmployerIds.map((id) => new mongoose.Types.ObjectId(id)) }
    }).select('_id');

    if (!jobs.length) {
      return res.status(200).json({
        success: true,
        applicants: [],
        pagination: {
          currentPage: Number(page),
          totalPages: 0,
          total: 0,
          limit: Number(limit),
        },
        statusCounts: {
          Total: 0,
          Pending: 0,
          Reviewed: 0,
          Accepted: 0,
          Rejected: 0,
        },
      });
    }

    // Build application match query
    const allowedJobIds = jobs.map((j) => j._id.toString());

    const matchQuery = applyEmployerReleaseGate({
      jobPost: { $in: jobs.map(j => j._id) },
    }, req.user);

    if (jobId) {
      if (!mongoose.Types.ObjectId.isValid(jobId)) {
        return res.status(400).json({ success: false, message: 'Invalid jobId' });
      }
      if (!allowedJobIds.includes(jobId.toString())) {
        return res.status(403).json({ success: false, message: 'Forbidden job access' });
      }
      matchQuery.jobPost = new mongoose.Types.ObjectId(jobId);
    }

    if (status && status !== 'All') {
      matchQuery.status = status;
    }

    if (dateRange && dateRange !== 'All') {
      const months = {
        'Last 12 Months': 12,
        'Last 16 Months': 16,
        'Last 24 Months': 24,
        'Last 5 year': 60,
      };
      const cutoffDate = new Date();
      cutoffDate.setMonth(cutoffDate.getMonth() - (months[dateRange] || 12));
      matchQuery.createdAt = { $gte: cutoffDate };
    }

    // Aggregation pipeline
    const pipeline = [
      { $match: matchQuery },

      { $lookup: { from: 'users', localField: 'candidate', foreignField: '_id', as: 'candidate' } },
      { $unwind: { path: '$candidate', preserveNullAndEmptyArrays: true } },

      { $lookup: { from: 'candidateprofiles', localField: 'candidateProfile', foreignField: '_id', as: 'candidateProfile' } },
      { $unwind: { path: '$candidateProfile', preserveNullAndEmptyArrays: true } },

      { $lookup: { from: 'jobposts', localField: 'jobPost', foreignField: '_id', as: 'jobPost' } },
      { $unwind: { path: '$jobPost', preserveNullAndEmptyArrays: true } },
      { $lookup: { from: 'companyprofiles', localField: 'jobPost.companyProfile', foreignField: '_id', as: 'companyProfile' } },
      { $unwind: { path: '$companyProfile', preserveNullAndEmptyArrays: true } },
      { $lookup: { from: 'users', localField: 'jobPost.employer', foreignField: '_id', as: 'employerUser' } },
      { $unwind: { path: '$employerUser', preserveNullAndEmptyArrays: true } },
    ];

    // Search
    if (search) {
      const regex = new RegExp(search, 'i');
      pipeline.push({
        $match: {
          $or: [
            { 'candidate.name': regex },
            { 'candidate.email': regex },
            { 'candidateProfile.fullName': regex },
            { 'candidateProfile.email': regex },
            { 'candidateProfile.jobTitle': regex },
          ],
        },
      });
    }

    // Pagination + counts
    pipeline.push(
      { $sort: { createdAt: sortDirection } },
      {
        $facet: {
          data: [
            { $skip: (page - 1) * limit },
            { $limit: Number(limit) },
          ],
          totalCount: [{ $count: 'count' }],
          statusCounts: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
        },
      }
    );

    const [result] = await Application.aggregate(pipeline);

    const applicants = result.data || [];
    const total = result.totalCount?.[0]?.count || 0;

    // Status tab counts
    const statusCounts = {
      Total: total,
      Pending: result.statusCounts.find(s => s._id === 'Pending')?.count || 0,
      Reviewed: result.statusCounts.find(s => s._id === 'Reviewed')?.count || 0,
      Accepted: result.statusCounts.find(s => s._id === 'Accepted')?.count || 0,
      Rejected: result.statusCounts.find(s => s._id === 'Rejected')?.count || 0,
    };

    const { companyProfileMap, employerCompanyMap, employerNameMap } =
      await buildApplicantCompanyNameMaps(applicants);

    //  Format response
    const formattedApplicants = applicants.map(app => ({
      id: app.candidate?._id,
      name: app.candidateProfile?.fullName || app.candidate?.name || 'N/A',
      email: app.candidate?.email || 'N/A',
      jobPostId: app.jobPost?._id || null,
      designation: app.candidateProfile?.jobTitle || 'N/A',
      location: app.candidateProfile?.location?.city || 'N/A',
      expectedSalary: app.candidateProfile?.expectedSalary || 'N/A',
      tags: app.candidateProfile?.categories || [],
      avatar: app.candidateProfile?.profilePhoto || app.candidate?.profilePhoto || '/default-avatar.jpg',
      status: app.status,
      candidateJoinConfirmation: app.candidateJoinConfirmation || 'not_required',
      candidateJoinConfirmedAt: app.candidateJoinConfirmedAt || null,
      selectedAt: app.selectedAt || null,
      shortlisted: app.shortlisted,
      appliedAt: app.createdAt,
      resume: app.resume,
      applicationId: app._id,
      jobTitle: app.jobPost?.title || 'N/A',
      candidateProfileId: app.candidateProfile?._id || null,
      employerId: app.jobPost?.employer,
      companyName:
        companyProfileMap.get(String(app.jobPost?.companyProfile || '')) ||
        employerCompanyMap.get(String(app.jobPost?.employer || '')) ||
        employerNameMap.get(String(app.jobPost?.employer || '')) ||
        'N/A',
    }));

    return res.status(200).json({
      success: true,
      applicants: formattedApplicants,
      pagination: {
        currentPage: Number(page),
        totalPages: Math.ceil(total / limit),
        total,
        limit: Number(limit),
      },
      statusCounts,
    });
  } catch (error) {
    next(error);
  }
};



/**
 * Update applicant status (approve/reject).
 * @param {Object} req - Request object with status
 * @param {Object} res - Response object
 * @param {Function} next - Next middleware function
 */
employerApplicantsController.updateApplicantStatus = async (req, res, next) => {
  try {
    const employerId = getEffectiveEmployerId(req.user);
    const applicationId = req.params.applicationId;
    const { status } = req.body; // 'Reviewed', 'Accepted', 'Rejected'

    if (!['Reviewed', 'Accepted', 'Rejected'].includes(status)) {
      throw new BadRequestError('Invalid status');
    }

    const application = await Application.findById(applicationId)
      .populate({
        path: 'jobPost',
        populate: { path: 'companyProfile', select: 'companyName' },
      })
      .populate('candidate', 'email name');
    
    // new ownership check using role helper
    if (!application || !canManageJob(application.jobPost, req.user)) {
      throw new ForbiddenError('You do not have permission to update this application');
    }
    ensureEmployerCanAccessApplication(application, req.user);

    application.status = status;
    if (status === 'Accepted') {
      application.candidateJoinConfirmation = 'pending';
      application.candidateJoinConfirmedAt = null;
      application.selectedAt = new Date();
    } else {
      application.candidateJoinConfirmation = 'not_required';
      application.candidateJoinConfirmedAt = null;
      application.selectedAt = null;
    }
    await application.save();

    // Send status update email to candidate
    try {
      if (application.candidate && application.candidate.email) {
        // Map displayed status to email status format
        const emailStatus = status === 'Accepted' ? 'selected' : (status === 'Reviewed' ? 'reviewed' : 'rejected').toLowerCase();
        
        await sendApplicationStatusUpdateEmail({
          candidateEmail: application.candidate.email,
          candidateName: application.candidate.name || 'Candidate',
          jobTitle: application.jobPost.title,
          companyName: application.jobPost.companyProfile?.companyName || 'Company',
          status: emailStatus,
        });
      }
    } catch (emailError) {
      console.error('Failed to send status update email:', emailError);
      // Don't throw - let the status update succeed even if email fails
    }

    // Create notification for candidate
    try {
      const { type: notificationType, data: notificationData } =
        getCandidateApplicationNotification(status, application.jobPost.title);

      await createNotification(application.candidate._id, notificationType, {
        ...notificationData,
        jobPost: application.jobPost._id,
        application: applicationId,
        actionUrl: '/candidates-dashboard/applied-jobs',
      });

      await sendPushToUsers([application.candidate._id], {
        title: notificationData.title,
        body: notificationData.description,
        link: `${process.env.FRONTEND_URL}/candidates-dashboard/applied-jobs`,
        data: {
          type: notificationType,
          jobPostId: application.jobPost._id,
          applicationId,
          actionUrl: '/candidates-dashboard/applied-jobs',
        },
      });
    } catch (notificationError) {
      console.error('Failed to create notification:', notificationError);
      // Don't throw - let the status update succeed even if notification fails
    }

    return res.status(200).json({
      success: true,
      message: `Applicant status updated to ${status}`,
      application,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Delete an application.
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 * @param {Function} next - Next middleware function
 */
employerApplicantsController.deleteApplicant = async (req, res, next) => {
  try {
    const employerId = getEffectiveEmployerId(req.user);
    const applicationId = req.params.applicationId;

    const application = await Application.findById(applicationId).populate('jobPost');
    // if (!application || application.jobPost.employer.toString() !== employerId.toString()) {
    //   throw new ForbiddenError('You do not have permission to delete this application');
    // }

    if (!canManageJob(application.jobPost, req.user)) {
      throw new ForbiddenError('Permission denied');
    }
    ensureEmployerCanAccessApplication(application, req.user);


    await application.deleteOne();

    return res.status(200).json({
      success: true,
      message: 'Application deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get applicant details for viewing.
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 * @param {Function} next - Next middleware function
 */
employerApplicantsController.viewApplicant = async (req, res, next) => {
  try {
    const employerId = getEffectiveEmployerId(req.user);
    const applicationId = req.params.applicationId;

    const application = await Application.findById(applicationId)
      .populate('candidate', 'name email phone profilePhoto')
      .populate('candidateProfile', 'fullName jobTitle phone location profilePhoto resume expectedSalary categories')
       .populate({
          path: 'jobPost',
          select: 'title employer'
        })
      .select('-__v');

    // old ownership check
    // if (!application || application.jobPost.employer.toString() !== employerId.toString()) {
    //   throw new ForbiddenError('You do not have permission to view this application');
    // }
    // new ownership check using role helper
    // if (!canManageJob(application.jobPost, req.user)) {
    //   throw new ForbiddenError('Permission denied');
    // }

     //  Application not found
    if (!application) {
      return res.status(404).json({
        success: false,
        message: 'Application not found'
      });
    }

    //  Job post missing (data integrity check)
    if (!application.jobPost) {
      return res.status(400).json({
        success: false,
        message: 'Job post not associated with this application'
      });
    }

    // Permission check
    if (!canManageJob(application.jobPost, req.user)) {
      return res.status(403).json({
        success: false,
        message: 'Permission denied'
      });
    }
    ensureEmployerCanAccessApplication(application, req.user);


    return res.status(200).json({
      success: true,
      application,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get monthly resume download usage for all jobs accessible to the employer.
 */
employerApplicantsController.getResumeDownloadUsage = async (req, res, next) => {
  try {
    const { jobId } = req.query;
    const quota = await buildResumeQuotaResponse({
      user: req.user,
      jobId: jobId || null,
    });

    return res.status(200).json({
      success: true,
      ...quota,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Download an applicant resume with monthly per-job quota enforcement.
 */
employerApplicantsController.downloadApplicantResume = async (req, res, next) => {
  try {
    const { applicationId } = req.params;
    const user = req.user;
    const monthKey = getIstMonthKey();

    const application = await Application.findById(applicationId)
      .populate('candidate', 'name email phone profilePhoto')
      .populate('candidateProfile', 'fullName jobTitle phone location profilePhoto resume expectedSalary categories')
      .populate({
        path: 'jobPost',
        select: 'title employer status applicantCount',
      })
      .select('-__v');

    if (!application) {
      return res.status(404).json({
        success: false,
        message: 'Application not found',
      });
    }

    if (!application.jobPost) {
      return res.status(400).json({
        success: false,
        message: 'Job post not associated with this application',
      });
    }

    if (!canManageJob(application.jobPost, user)) {
      return res.status(403).json({
        success: false,
        message: 'Permission denied',
      });
    }
    ensureEmployerCanAccessApplication(application, user);

    const resumeValue = await resolveApplicationResumeValue(application);
    if (!resumeValue) {
      return res.status(404).json({
        success: false,
        message: 'Resume not found',
      });
    }

    const downloadAccess = await requireEmployerResumeDownloadLimit(req, res);
    if (!downloadAccess.allowed) return;

    const key = await resolveExistingResumeKey(resumeValue);
    if (!key) {
      return res.status(404).json({
        success: false,
        message: 'Resume file not found in storage',
      });
    }

    const signedUrl = await getPrivateFileUrl(key);

    const downloadedAt = new Date();
    const candidateId = application.candidate?._id || application.candidate;

    await EmployerResumeDownloadLog.create({
      employer: user.id,
      jobPost: application.jobPost._id,
      candidate: candidateId,
      application: application._id,
      monthKey,
      downloadedAt,
    });

    await CandidateEmployerActivity.updateOne(
      { employer: user.id, candidate: candidateId },
      {
        $inc: { resumeDownloadCount: 1 },
        $set: {
          candidateProfile: application.candidateProfile?._id || null,
          lastResumeDownloadedAt: downloadedAt,
          lastActivityAt: downloadedAt,
        },
        $setOnInsert: {
          employer: user.id,
          candidate: candidateId,
        },
      },
      { upsert: true }
    );

    const nextQuota = await buildResumeQuotaResponse({
      user,
      jobId: String(application.jobPost._id),
    });

    return res.status(200).json({
      success: true,
      message: 'Resume download started',
      url: signedUrl,
      downloadQuota: nextQuota,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Bulk update applicant statuses.
 * @param {Object} req - Request object with application IDs and status
 * @param {Object} res - Response object
 * @param {Function} next - Next middleware function
 */
employerApplicantsController.bulkUpdateStatus = async (req, res, next) => {
  try {
    const employerId = getEffectiveEmployerId(req.user);
    const { applicationIds, status } = req.body;

    if (!Array.isArray(applicationIds) || applicationIds.length === 0) {
      throw new BadRequestError('Application IDs array is required');
    }

    if (!['Reviewed', 'Accepted', 'Rejected'].includes(status)) {
      throw new BadRequestError('Invalid status');
    }

    // Find applications belonging to the employer
    const applications = await Application.find({
      _id: { $in: applicationIds },
      // 'jobPost.employer': employerId,
    }).populate('jobPost');

    // if (applications.length !== applicationIds.length) {
    //   throw new ForbiddenError('Some applications do not belong to you');
    // }

     // Permission check per application
    for (const app of applications) {
      if (!canManageJob(app.jobPost, req.user)) {
        throw new ForbiddenError('Permission denied for one or more applications');
      }
      ensureEmployerCanAccessApplication(app, req.user);
    }

    const statusUpdate = { status };
    if (status === 'Accepted') {
      statusUpdate.candidateJoinConfirmation = 'pending';
      statusUpdate.candidateJoinConfirmedAt = null;
      statusUpdate.selectedAt = new Date();
    } else {
      statusUpdate.candidateJoinConfirmation = 'not_required';
      statusUpdate.candidateJoinConfirmedAt = null;
      statusUpdate.selectedAt = null;
    }

    // Update statuses
    await Application.updateMany(
      { _id: { $in: applicationIds } },
      { $set: statusUpdate }
    );

    return res.status(200).json({
      success: true,
      message: `${applications.length} applications updated to ${status}`,
      updatedCount: applications.length,
    });
  } catch (error) {
    next(error);
  }
};


/**
 * Shortlist an applicant for a job.
 * @route PUT /api/employer/applications/:applicationId/shortlist
 * @access Private (Employer, Admin, Superadmin)
 */
employerApplicantsController.shortlistApplicant = async (req, res, next) => {
  try {
    const employerId = getEffectiveEmployerId(req.user);
    const applicationId = req.params.applicationId;

    const application = await Application.findById(applicationId)
      .populate({
        path: 'jobPost',
        populate: { path: 'companyProfile', select: 'companyName' },
      })
      .populate('candidate', 'email name');
    if (!application) {
      throw new NotFoundError('Application not found');
    }

    //check if the job belongs to the employer
    // if (application.jobPost.employer.toString() !== employerId.toString()) {
    //   throw new ForbiddenError('You do not have permission to shortlist this applicant');
    // }
    // console.log("Shortlisting application:", application);

    // new ownership check using role helper
    if (!canManageJob(application.jobPost, req.user)) {
      throw new ForbiddenError('Permission denied');
    }
    ensureEmployerCanAccessApplication(application, req.user);

    
    application.shortlisted = true;
    await application.save();

    try {
      const notificationData = {
        title: 'Application Shortlisted',
        description: `Your application for ${application.jobPost.title} has been shortlisted.`,
        icon: 'la-star',
        color: '#f59e0b',
      };

      await createNotification(application.candidate._id, 'application_reviewed', {
        ...notificationData,
        jobPost: application.jobPost._id,
        application: applicationId,
        actionUrl: '/candidates-dashboard/applied-jobs',
      });

      await sendPushToUsers([application.candidate._id], {
        title: notificationData.title,
        body: notificationData.description,
        link: `${process.env.FRONTEND_URL}/candidates-dashboard/applied-jobs`,
        data: {
          type: 'application_shortlisted',
          jobPostId: application.jobPost._id,
          applicationId,
          actionUrl: '/candidates-dashboard/applied-jobs',
        },
      });
    } catch (notificationError) {
      console.error('Failed to notify shortlisted candidate:', notificationError);
    }

    // Notify candidate (assuming sendEmail is defined)
    // const job = await JobPost.findById(application.jobPost).populate('companyProfile', 'companyName');
    // await sendEmail({
    //   to: application.candidate.email,
    //   subject: 'Your Application Has Been Shortlisted!',
    //   text: `Your application for ${job.title} at ${job.companyProfile.companyName} has been shortlisted.`,
    // });

    return res.status(200).json({
      success: true,
      message: 'Applicant shortlisted successfully',
      application,
    });
  } catch (error) {
    next(error);
  }
};


/**
 * Remove an applicant from shortlist.
 * @route PUT /api/employer/applications/:applicationId/unshortlist
 * @access Private (Employer, Admin, Superadmin)
 */
employerApplicantsController.unshortlistApplicant = async (req, res, next) => {
  try {
    const employerId = getEffectiveEmployerId(req.user);
    const applicationId = req.params.applicationId;

    const application = await Application.findById(applicationId).populate('jobPost');
    if (!application) {
      throw new NotFoundError('Application not found');
    }

    // if (application.jobPost.employer.toString() !== employerId.toString()) {
    //   throw new ForbiddenError('You do not have permission to unshortlist this applicant');
    // }

    // new ownership check using role helper
    if (!canManageJob(application.jobPost, req.user)) {
      throw new ForbiddenError('Permission denied');
    }
    ensureEmployerCanAccessApplication(application, req.user);


    application.shortlisted = false;
    await application.save();

    return res.status(200).json({
      success: true,
      message: 'Applicant removed from shortlist',
      application,
    });
  } catch (error) {
    next(error);
  }
};

employerApplicantsController.releaseJobApplicantsToEmployer = async (req, res, next) => {
  try {
    if (!isAdminUser(req.user)) {
      throw new ForbiddenError('Only admins can release applicants to employers');
    }

    const { jobId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(jobId)) {
      throw new BadRequestError('Invalid job id');
    }

    const jobPost = await JobPost.findById(jobId)
      .populate('companyProfile', 'companyName email')
      .populate('employer', 'name email contactEmail isSystemGeneratedEmail');

    if (!jobPost) {
      throw new NotFoundError('Job post not found');
    }

    if (!canManageJob(jobPost, req.user)) {
      throw new ForbiddenError('You do not have permission to release applicants for this job');
    }

    const unreleasedQuery = { jobPost: jobPost._id, releasedToEmployer: { $ne: true } };
    const pendingReleaseCount = await Application.countDocuments(unreleasedQuery);

    if (pendingReleaseCount === 0) {
      const totalReleasedCount = await Application.countDocuments({
        jobPost: jobPost._id,
        releasedToEmployer: true,
      });

      return res.status(200).json({
        success: true,
        message: 'No pending applicants to release',
        releasedCount: 0,
        totalReleasedCount,
      });
    }

    await Application.updateMany(unreleasedQuery, {
      $set: {
        releasedToEmployer: true,
        releasedAt: new Date(),
        releasedBy: req.user.id,
      },
    });

    const totalReleasedCount = await Application.countDocuments({
      jobPost: jobPost._id,
      releasedToEmployer: true,
    });

    const employer = jobPost.employer;
    const employerEmail = employer?.isSystemGeneratedEmail
      ? (employer.contactEmail || jobPost.companyProfile?.email)
      : (employer?.email || employer?.contactEmail || jobPost.companyProfile?.email);

    const dashboardLink = `${process.env.FRONTEND_URL}/employers-dashboard/all-applicants?jobId=${jobPost._id}`;

    if (employerEmail) {
      await sendEmployerApplicantsReleasedEmail({
        employerEmail,
        employerName: employer?.name || jobPost.companyProfile?.companyName || 'Employer',
        jobTitle: jobPost.title,
        companyName: jobPost.companyProfile?.companyName || 'Company',
        releasedCount: pendingReleaseCount,
        totalReleasedCount,
        dashboardLink,
      });
    }

    if (employer?._id) {
      const notificationPayload = {
        ...notificationPresets.emailUpdate(
          'Applicants Ready to Review',
          `${totalReleasedCount} candidates are now available for ${jobPost.title}.`
        ),
        jobPost: jobPost._id,
        actionUrl: '/employers-dashboard/all-applicants',
      };

      await createNotification(employer._id, 'email_update', notificationPayload);
      await sendPushToUsers([employer._id], {
        title: notificationPayload.title,
        body: notificationPayload.description,
        link: `${process.env.FRONTEND_URL}${notificationPayload.actionUrl}`,
        data: {
          type: 'job_applicants_released',
          jobPostId: String(jobPost._id),
          actionUrl: notificationPayload.actionUrl,
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: `${pendingReleaseCount} applicants released to employer`,
      releasedCount: pendingReleaseCount,
      totalReleasedCount,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get shortlisted resumes for a job or all jobs by employer.
 * @route GET /api/employer/shortlisted-resumes?jobId=ID&status=Pending&search=John&page=1&limit=10
 * @access Private (Employer, Admin, Superadmin)
 */
employerApplicantsController.getShortlistedResumes = async (req, res, next) => {
  try {
    const user = req.user;
    const {
      jobId,
      status,
      dateRange,
      page = 1,
      limit = 10,
      search,
      appliedDateSort = 'newest',
      scope = 'all',
    } = req.query;
    const sortDirection = appliedDateSort === 'oldest' ? 1 : -1;

    let query = applyEmployerReleaseGate({ shortlisted: true }, user);

    // --------------------------------------------------
    // Job ownership handling (Employer / HR-Admin / Superadmin)
    // --------------------------------------------------
    if (scope === 'assigned' && ['superadmin', 'hr-admin'].includes(user.role)) {
      let assignedEmployerIds = [];

      if (user.role === 'hr-admin') {
        const currentHrAdmin = await User.findById(user.id).select('employerIds');
        assignedEmployerIds = (currentHrAdmin?.employerIds || []).map((id) => id.toString());
      } else if (user.role === 'superadmin') {
        const hrAdmins = await User.find({ role: 'hr-admin', isActive: true }).select('employerIds');
        assignedEmployerIds = [
          ...new Set(
            hrAdmins.flatMap((hr) => (hr.employerIds || []).map((id) => id.toString()))
          ),
        ];
      }

      if (!assignedEmployerIds.length) {
        return res.status(200).json({
          success: true,
          applicants: [],
          pagination: {
            currentPage: Number(page),
            totalPages: 0,
            total: 0,
            limit: Number(limit),
          },
          statusCounts: {
            Total: 0,
            Pending: 0,
            Reviewed: 0,
            Accepted: 0,
            Rejected: 0,
          },
        });
      }

      const assignedJobs = await JobPost.find({
        employer: { $in: assignedEmployerIds.map((id) => new mongoose.Types.ObjectId(id)) },
      }).select('_id');

      query.jobPost = { $in: assignedJobs.map((job) => job._id) };
    } else if (jobId) {
      const jobPost = await JobPost.findById(jobId);

      if (!jobPost) {
        throw new NotFoundError('Job post not found');
      }

      const isAllowed =
        user.role === 'superadmin' ||
        (user.role === 'employer' && jobPost.employer?.toString() === user.id) ||
        (user.role === 'hr-admin' && jobPost.postedBy?.toString() === user.id);

      if (!isAllowed) {
        throw new ForbiddenError('You do not have permission to view shortlisted resumes for this job');
      }

      query.jobPost = jobId;
    } else {
      const jobQuery = await buildJobQueryForUser(user);
      const jobs = await JobPost.find(jobQuery).select('_id');

      query.jobPost = { $in: jobs.map(j => j._id) };
    }

    if (jobId && scope === 'assigned' && ['superadmin', 'hr-admin'].includes(user.role)) {
      if (!mongoose.Types.ObjectId.isValid(jobId)) {
        return res.status(400).json({ success: false, message: 'Invalid jobId' });
      }

      const assignedJobIds = Array.isArray(query.jobPost?.$in)
        ? query.jobPost.$in.map((id) => id.toString())
        : [];

      if (!assignedJobIds.includes(jobId.toString())) {
        return res.status(403).json({ success: false, message: 'Forbidden job access' });
      }

      query.jobPost = new mongoose.Types.ObjectId(jobId);
    }

    // --------------------------------------------------
    // Filters
    // --------------------------------------------------
    if (status && status !== 'All') query.status = status;

    if (dateRange && dateRange !== 'All') {
      const months = {
        'Last 12 Months': 12,
        'Last 16 Months': 16,
        'Last 24 Months': 24,
        'Last 5 year': 60,
      };
      const cutoffDate = new Date();
      cutoffDate.setMonth(cutoffDate.getMonth() - (months[dateRange] || 12));
      query.createdAt = { $gte: cutoffDate };
    }

    if (search && String(search).trim()) {
      const regex = new RegExp(String(search).trim(), 'i');
      const [matchedUsers, matchedProfiles, matchedJobs] = await Promise.all([
        User.find({ $or: [{ name: regex }, { email: regex }] }).select('_id').lean(),
        CandidateProfile.find({ $or: [{ fullName: regex }, { jobTitle: regex }] }).select('_id').lean(),
        JobPost.find({ title: regex }).select('_id').lean(),
      ]);

      const candidateIds = matchedUsers.map((item) => item._id);
      const candidateProfileIds = matchedProfiles.map((item) => item._id);
      const jobIds = matchedJobs.map((item) => item._id);

      query.$or = [
        { candidate: { $in: candidateIds } },
        { candidateProfile: { $in: candidateProfileIds } },
        { jobPost: { $in: jobIds } },
      ];
    }

    // --------------------------------------------------
    // Pagination count
    // --------------------------------------------------
    const total = await Application.countDocuments(query);

    // --------------------------------------------------
    // Fetch shortlisted applications
    // --------------------------------------------------
    const applicants = await Application.find(query)
      .populate('candidate', 'name email phone profilePhoto')
      .populate('candidateProfile', '_id fullName jobTitle phone location profilePhoto resume expectedSalary categories')
      .populate('jobPost', 'title')
      .sort({ createdAt: sortDirection })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    // --------------------------------------------------
    // Status counts
    // --------------------------------------------------
    const statusCountsAgg = await Application.aggregate([
      { $match: query },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    const counts = {
      Total: total,
      Pending: statusCountsAgg.find(s => s._id === 'Pending')?.count || 0,
      Reviewed: statusCountsAgg.find(s => s._id === 'Reviewed')?.count || 0,
      Accepted: statusCountsAgg.find(s => s._id === 'Accepted')?.count || 0,
      Rejected: statusCountsAgg.find(s => s._id === 'Rejected')?.count || 0,
    };

    // --------------------------------------------------
    // Format response
    // --------------------------------------------------
    const formattedApplicants = applicants.map(app => ({
      id: app.candidate?._id,
      name: app.candidateProfile?.fullName || app.candidate?.name || 'N/A',
      email: app.candidate?.email || 'N/A',
      jobPostId: app.jobPost?._id || null,
      candidateProfileId: app.candidateProfile?._id || null,
      designation: app.candidateProfile?.jobTitle || 'N/A',
      location: app.candidateProfile?.location?.city || {},
      expectedSalary: app.candidateProfile?.expectedSalary || 'N/A',
      tags: app.candidateProfile?.categories || [],
      avatar: app.candidateProfile?.profilePhoto || app.candidate?.profilePhoto || '/default-avatar.jpg',
      status: app.status,
      candidateJoinConfirmation: app.candidateJoinConfirmation || 'not_required',
      candidateJoinConfirmedAt: app.candidateJoinConfirmedAt || null,
      selectedAt: app.selectedAt || null,
      shortlisted: app.shortlisted,
      appliedAt: app.createdAt,
      resume: app.resume,
      applicationId: app._id,
      jobTitle: app.jobPost?.title || 'N/A',
    }));

    return res.status(200).json({
      success: true,
      applicants: formattedApplicants,
      pagination: {
        currentPage: Number(page),
        totalPages: Math.ceil(total / limit),
        total,
        limit: Number(limit),
      },
      statusCounts: counts,
    });
  } catch (error) {
    next(error);
  }
};



/**
 * Get employer-wise applicant summary for HR-Admin / Superadmin
 *
 * What this API does:
 * ----------------------------------------------------
 * - Groups applicants by employer
 * - Counts total jobs per employer
 * - Counts total applicants
 * - Gives status-wise applicant breakdown
 *
 * @route   GET /api/hr-admin/employers/applicants-summary
 * @access  Private (HR-Admin, Superadmin)
 */
employerApplicantsController.getEmployerApplicantsSummary = async (req, res, next) => {
  try {
    const user = req.user;

    // Build employer filter based on role
    let employerMatch = {};

    if (user.role === 'hr-admin') {
      if (!user.employerIds || !user.employerIds.length) {
        return res.status(200).json({
          success: true,
          data: [],
        });
      }

      employerMatch._id = { $in: user.employerIds };
    }

    // Fetch employers
    const employers = await User.find({
      role: 'employer',
      ...employerMatch,
    }).select('_id name companyName email');

    if (!employers.length) {
      return res.status(200).json({
        success: true,
        data: [],
      });
    }

    const employerIds = employers.map(e => e._id);

    // Aggregate applicants grouped by employer
    const summary = await Application.aggregate([
      // Join job posts
      {
        $lookup: {
          from: 'jobposts',
          localField: 'jobPost',
          foreignField: '_id',
          as: 'jobPost',
        },
      },
      { $unwind: '$jobPost' },

      // Match only employers we care about
      {
        $match: {
          'jobPost.employer': { $in: employerIds },
        },
      },

      // Group by employer + status
      {
        $group: {
          _id: {
            employer: '$jobPost.employer',
            status: '$status',
          },
          count: { $sum: 1 },
        },
      },

      // Group again by employer
      {
        $group: {
          _id: '$_id.employer',
          totalApplicants: { $sum: '$count' },
          statusCounts: {
            $push: {
              status: '$_id.status',
              count: '$count',
            },
          },
        },
      },
    ]);

    // Get job counts per employer
    const jobCounts = await JobPost.aggregate([
      { $match: { employer: { $in: employerIds } } },
      {
        $group: {
          _id: '$employer',
          totalJobs: { $sum: 1 },
        },
      },
    ]);

    const jobCountMap = {};
    jobCounts.forEach(j => {
      jobCountMap[j._id.toString()] = j.totalJobs;
    });

    // Format response
    const employerMap = {};
    employers.forEach(e => {
      employerMap[e._id.toString()] = e;
    });

    const formatted = summary.map(item => {
      const statusObj = {
        Pending: 0,
        Reviewed: 0,
        Accepted: 0,
        Rejected: 0,
      };

      item.statusCounts.forEach(s => {
        statusObj[s.status] = s.count;
      });

      return {
        employerId: item._id,
        employerName: employerMap[item._id.toString()]?.companyName ||
                      employerMap[item._id.toString()]?.name ||
                      'N/A',
        totalJobs: jobCountMap[item._id.toString()] || 0,
        totalApplicants: item.totalApplicants,
        statusCounts: statusObj,
      };
    });

    return res.status(200).json({
      success: true,
      data: formatted,
    });
  } catch (error) {
    next(error);
  }
};



export default employerApplicantsController;
