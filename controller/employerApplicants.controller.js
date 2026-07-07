import mongoose from "mongoose";
import Application from '../models/jobApply.model.js';
import JobPost from '../models/jobs.model.js';
import CandidateProfile from '../models/candidateProfile.model.js';
import CompanyProfile from '../models/companyProfile.model.js';
import User from '../models/user.model.js';
import EmployerResumeDownloadLog from '../models/employerResumeDownloadLog.model.js';
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { canManageJob, buildJobQueryForUser } from '../utils/roleHelper.js';
import { BadRequestError, NotFoundError, ForbiddenError } from '../utils/errors.js';
import { sendApplicationStatusUpdateEmail } from '../utils/mailer.js';
import { createNotification, notificationPresets } from '../utils/notificationHelper.js';
import { getPrivateFileUrl } from '../utils/s3SignedUrl.js';
import { s3 } from "../config/aws-s3.js";
import { requireEmployerResumeDownloadLimit } from '../utils/employerPlanAccess.js';

const employerApplicantsController = {};

const MONTHLY_RESUME_LIMIT = 5;

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

  const jobsWithUsage = jobs.map((job) => {
    const usage = usageMap.get(String(job._id)) || { downloadsUsed: 0, lastDownloadedAt: null };
    const downloadsRemaining = Math.max(MONTHLY_RESUME_LIMIT - usage.downloadsUsed, 0);

    return {
      jobId: job._id,
      title: job.title,
      status: job.status,
      applicantCount: job.applicantCount || 0,
      downloadsUsed: usage.downloadsUsed,
      downloadsRemaining,
      limit: MONTHLY_RESUME_LIMIT,
      monthKey,
      monthLabel: getIstMonthLabel(),
      lastDownloadedAt: usage.lastDownloadedAt,
      isSelected: jobId ? String(job._id) === String(jobId) : false,
    };
  });

  const selectedJob = jobsWithUsage.find((job) => job.isSelected) || jobsWithUsage[0] || null;
  const totalDownloadsUsed = jobsWithUsage.reduce((sum, job) => sum + job.downloadsUsed, 0);

  return {
    limitPerJob: MONTHLY_RESUME_LIMIT,
    monthKey,
    monthLabel: getIstMonthLabel(),
    selectedJob,
    jobs: jobsWithUsage,
    summary: {
      totalJobs: jobsWithUsage.length,
      totalDownloadsUsed,
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
    const employerId = req.user.id;
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
    const matchQuery = { jobPost: new mongoose.Types.ObjectId(jobId) };
    
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

    const matchQuery = { jobPost: { $in: jobs.map(j => j._id) } };

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

    const matchQuery = {
      jobPost: { $in: jobs.map(j => j._id) },
    };

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
    const employerId = req.user.id;
    const applicationId = req.params.applicationId;
    const { status } = req.body; // 'Reviewed', 'Accepted', 'Rejected'

    if (!['Reviewed', 'Accepted', 'Rejected'].includes(status)) {
      throw new BadRequestError('Invalid status');
    }

    const application = await Application.findById(applicationId)
      .populate('jobPost')
      .populate('candidate', 'email name');
    
    // new ownership check using role helper
    if (!application || !canManageJob(application.jobPost, req.user)) {
      throw new ForbiddenError('You do not have permission to update this application');
    }

    application.status = status;
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
      let notificationType = 'application_reviewed';
      let notificationData = notificationPresets.applicationReviewed(application.jobPost.title);

      if (status === 'Accepted') {
        notificationType = 'application_selected';
        notificationData = notificationPresets.applicationSelected(application.jobPost.title);
      } else if (status === 'Rejected') {
        notificationType = 'application_rejected';
        notificationData = notificationPresets.applicationRejected(application.jobPost.title);
      }

      await createNotification(application.candidate._id, notificationType, {
        ...notificationData,
        jobPost: application.jobPost._id,
        application: applicationId,
        actionUrl: `${process.env.FRONTEND_URL}/candidates-dashboard/applied-jobs`,
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
    const employerId = req.user.id;
    const applicationId = req.params.applicationId;

    const application = await Application.findById(applicationId).populate('jobPost');
    // if (!application || application.jobPost.employer.toString() !== employerId.toString()) {
    //   throw new ForbiddenError('You do not have permission to delete this application');
    // }

    if (!canManageJob(application.jobPost, req.user)) {
      throw new ForbiddenError('Permission denied');
    }


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
    const employerId = req.user.id;
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

    const resumeValue = await resolveApplicationResumeValue(application);
    if (!resumeValue) {
      return res.status(404).json({
        success: false,
        message: 'Resume not found',
      });
    }

    const downloadAccess = await requireEmployerResumeDownloadLimit(req, res, {
      source: 'applicant',
    });
    if (!downloadAccess.allowed) return;

    const key = await resolveExistingResumeKey(resumeValue);
    if (!key) {
      return res.status(404).json({
        success: false,
        message: 'Resume file not found in storage',
      });
    }

    const signedUrl = await getPrivateFileUrl(key);

    await EmployerResumeDownloadLog.create({
      employer: user.id,
      jobPost: application.jobPost._id,
      candidate: application.candidate?._id || application.candidate,
      application: application._id,
      monthKey,
      downloadedAt: new Date(),
    });

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
    const employerId = req.user.id;
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
    }

    // Update statuses
    await Application.updateMany(
      { _id: { $in: applicationIds } },
      { $set: { status } }
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
    const employerId = req.user.id;
    const applicationId = req.params.applicationId;

    const application = await Application.findById(applicationId)
      .populate('jobPost')
      .populate('candidate', 'email');
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

    
    application.shortlisted = true;
    await application.save();

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
    const employerId = req.user.id;
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

    let query = { shortlisted: true };

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
