import mongoose from 'mongoose';
import JobPost from '../models/jobs.model.js';
import Application from '../models/jobApply.model.js';
import CompanyProfile from '../models/companyProfile.model.js';
import User from '../models/user.model.js';
import CandidateProfile from '../models/candidateProfile.model.js';
import CandidateResume from '../models/candidateResume.model.js';
import ExcelJS from 'exceljs';

const hrAdminDashboardController = {};

/**
 * Get overall platform statistics for HR-Admin/Superadmin
 * @route GET /api/v1/hr-admin-dashboard/platform-stats
 * @access Private (HR-Admin, Superadmin)
 */
hrAdminDashboardController.getPlatformStats = async (req, res, next) => {
  try {
    const user = req.user;
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    if (!['hr-admin', 'superadmin'].includes(user.role)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    // Platform-wide counts for both HR Admin and Super Admin.
    const companyFilter = {};
    const jobFilter = {};
    const applicationJobMatch = {};
    const candidateFilter = { role: 'candidate', isActive: true };

   const [
      totalEmployers,
      activeCompanies,
      totalJobs,
      activeJobs,
      totalApplications,
      recentApplications,
      shortlistedApplications,
      totalCandidates,
      recentCandidates,
      lastMonthStats,
    ] = await Promise.all([
      User.countDocuments({ role: "employer", isActive: true }),

      CompanyProfile.countDocuments({
        status: 'approved',
        ...companyFilter
      }),

      JobPost.countDocuments(jobFilter),

      JobPost.countDocuments({
        ...jobFilter,
        status: 'Published',
        applicationDeadline: { $gte: new Date() }
      }),

      // FIXED: Total applications
      Application.aggregate([
        { $lookup: { from: 'jobposts', localField: 'jobPost', foreignField: '_id', as: 'job' } },
        { $unwind: '$job' },
        { $match: applicationJobMatch },
        { $count: 'total' }
      ]).then(r => r[0]?.total || 0),

      // FIXED: Recent applications
      Application.aggregate([
        { $lookup: { from: 'jobposts', localField: 'jobPost', foreignField: '_id', as: 'job' } },
        { $unwind: '$job' },
        {
          $match: {
            ...applicationJobMatch,
            createdAt: { $gte: thirtyDaysAgo }
          }
        },
        { $count: 'total' }
      ]).then(r => r[0]?.total || 0),

      // FIXED: Shortlisted applications
      Application.aggregate([
        { $lookup: { from: 'jobposts', localField: 'jobPost', foreignField: '_id', as: 'job' } },
        { $unwind: '$job' },
        {
          $match: {
            ...applicationJobMatch,
            shortlisted: true
          }
        },
        { $count: 'total' }
      ]).then(r => r[0]?.total || 0),

      User.countDocuments(candidateFilter),

      User.countDocuments({
        ...candidateFilter,
        createdAt: { $gte: thirtyDaysAgo }
      }),

      getLastMonthStats(jobFilter, applicationJobMatch, candidateFilter),
    ]);
    
    // Growth percentages (Month-over-Month)
    const employerGrowth = lastMonthStats.totalEmployers > 0
      ? Math.round(((totalEmployers - lastMonthStats.totalEmployers) / lastMonthStats.totalEmployers) * 100)
      : totalEmployers > 0 ? 100 : 0;

    const jobGrowth = lastMonthStats.totalJobs > 0
      ? Math.round(((totalJobs - lastMonthStats.totalJobs) / lastMonthStats.totalJobs) * 100)
      : totalJobs > 0 ? 100 : 0;

    const applicationGrowth = lastMonthStats.totalApplications > 0
      ? Math.round(((totalApplications - lastMonthStats.totalApplications) / lastMonthStats.totalApplications) * 100)
      : totalApplications > 0 ? 100 : 0;

    const candidateGrowth = lastMonthStats.totalCandidates > 0
      ? Math.round(((totalCandidates - lastMonthStats.totalCandidates) / lastMonthStats.totalCandidates) * 100)
      : totalCandidates > 0 ? 100 : 0;

    // Industry-standard derived metrics

    // 1. Average Applications per Job
    // Real-world name: "Applications per Job Posting"
    // Typical range: 20–80 for most roles (higher for entry-level)
    const avgApplicationsPerJob = totalJobs > 0 
      ? Number((totalApplications / totalJobs).toFixed(1))   // e.g. 37.4
      : 0;

    // 2. Open Jobs Rate (most honest & widely used)
    // % of jobs still accepting applications (Published & not expired)
    // Typical good range: 40–80%
    const openJobsRate = totalJobs > 0 
      ? Math.round((activeJobs / totalJobs) * 100) 
      : 0;

    // 3. Shortlist Conversion Rate
    // Industry standard: % of applications that get shortlisted
    // Typical range: 5–20% (higher for high-volume, lower for selective roles)
    const shortlistConversionRate = totalApplications > 0 
      ? Math.round((shortlistedApplications / totalApplications) * 100) 
      : 0;

    const stats = {
      // Core counts
      totalEmployers,
      totalCandidates,
      newCandidates: recentCandidates,

      activeCompanies,
      totalJobs,
      activeJobs,

      totalApplications,
      recentApplications,
      shortlistedApplications,

      // Growth rates (MoM)
      employerGrowth,
      jobGrowth,
      applicationGrowth,
      candidateGrowth,

      // Industry-standard derived metrics
      avgApplicationsPerJob,
      openJobsRate,
      shortlistConversionRate,

      // Scope info
      scope: 'platform-wide',
      assignedEmployerCount: null,
      lastUpdated: new Date().toISOString(),
    };

    return res.status(200).json({ success: true, stats });
  } catch (error) {
    next(error);
  }
};

/**
 * Get assigned employers overview for HR-Admin
 * @route GET /api/v1/hr-admin-dashboard/assigned-employers
 * @access Private (HR-Admin, Superadmin)
 */
hrAdminDashboardController.getAssignedEmployers = async (req, res, next) => {
  try {
    const { limit = 10, page = 1 } = req.query;
    const parsedLimit = parseInt(limit);
    const parsedPage = parseInt(page);
    const skip = (parsedPage - 1) * parsedLimit;

    const employerUserMatch = {
      role: 'employer',
      isActive: true,
    };

    // Get employer details with their stats
    const employers = await User.aggregate([
      {
        $match: employerUserMatch,
      },
      {
        $lookup: {
          from: 'companyprofiles',
          localField: '_id',
          foreignField: 'employer',
          as: 'companyProfile',
        },
      },
      {
        $unwind: {
          path: '$companyProfile',
          preserveNullAndEmptyArrays: false,
        },
      },
      {
        $match: {
          'companyProfile._id': { $exists: true, $ne: null },
          'companyProfile.companyName': { $exists: true, $ne: '' },
        },
      },
      {
        $lookup: {
          from: 'jobposts',
          localField: '_id',
          foreignField: 'employer',
          as: 'jobs',
        },
      },
      {
        $lookup: {
          from: 'applications',
          localField: 'jobs._id',
          foreignField: 'jobPost',
          as: 'applications',
        },
      },
      {
        $project: {
          name: 1,
          email: 1,
          createdAt: 1,
          lastLoginAt: 1,
          companyProfileId: '$companyProfile._id',
          companyName: '$companyProfile.companyName',
          companyEmail: '$companyProfile.email',
          companyLogo: '$companyProfile.logo',
          companyStatus: '$companyProfile.status',

        // Job post IDs (NEW)
        jobPostIds: {
        $map: {
            input: '$jobs',
            as: 'job',
            in: '$$job._id',
        },
        },

          totalJobs: { $size: '$jobs' },
          activeJobs: {
            $size: {
              $filter: {
                input: '$jobs',
                as: 'job',
                cond: {
                  $and: [
                    { $gte: ['$$job.applicationDeadline', new Date()] },
                    { $eq: ['$$job.status', 'Published'] },
                  ],
                },
              },
            },
          },

           //  Applications (NEW)
            applications: {
            $map: {
                input: '$applications',
                as: 'app',
                in: {
                applicationId: '$$app._id',
                jobPostId: '$$app.jobPost',
                candidateId: '$$app.candidate',
                candidateProfileId: '$$app.candidateProfile',
                status: '$$app.status',
                createdAt: '$$app.createdAt',
                },
            },
            },

          totalApplications: { $size: '$applications' },
          pendingApplications: {
            $size: {
              $filter: {
                input: '$applications',
                as: 'app',
                cond: { $eq: ['$$app.status', 'Pending'] },
              },
            },
          },
          profileViews: '$companyProfile.profileViews',
          isCompanyVerified: '$companyProfile.isVerified',
          companyCreatedAt: '$companyProfile.createdAt',
        },
      },
      { $sort: { totalApplications: -1 } },
      { $skip: skip },
      { $limit: parsedLimit },
    ]);

    // Get total count for pagination
    const totalResult = await User.aggregate([
      { $match: employerUserMatch },
      {
        $lookup: {
          from: 'companyprofiles',
          localField: '_id',
          foreignField: 'employer',
          as: 'companyProfile',
        },
      },
      {
        $unwind: {
          path: '$companyProfile',
          preserveNullAndEmptyArrays: false,
        },
      },
      {
        $match: {
          'companyProfile._id': { $exists: true, $ne: null },
          'companyProfile.companyName': { $exists: true, $ne: '' },
        },
      },
      { $count: 'total' },
    ]);
    const total = totalResult[0]?.total || 0;

    return res.status(200).json({
      success: true,
      employers,
      pagination: {
        currentPage: parsedPage,
        totalPages: Math.ceil(total / parsedLimit),
        total,
        limit: parsedLimit,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get job performance metrics across assigned employers
 * @route GET /api/v1/hr-admin-dashboard/job-performance
 * @access Private (HR-Admin, Superadmin)
 */
hrAdminDashboardController.getJobPerformance = async (req, res, next) => {
    try {
        const { period = 'monthly', months = 6 } = req.query;
        const topLimit = 8;

        // Calculate start date based on months parameter
        const startDate = new Date();
        startDate.setMonth(startDate.getMonth() - parseInt(months));

        // Keep job performance metrics platform-wide for both HR Admin and Super Admin
        // so both dashboards show the same values.
        const jobMatch = {};

        // First, get all job IDs from assigned employers
        const assignedJobIds = await JobPost.find(jobMatch).distinct('_id');
        
        // Get applications for these jobs separately
        const applications = await Application.find({
            jobPost: { $in: assignedJobIds },
            createdAt: { $gte: startDate }
        }).lean();

        // Create a map of jobId -> applications
        const applicationsByJobId = {};
        applications.forEach(app => {
            const jobId = app.jobPost.toString();
            if (!applicationsByJobId[jobId]) {
                applicationsByJobId[jobId] = [];
            }
            applicationsByJobId[jobId].push(app);
        });

        // Get top performing jobs by applications
        const topJobs = await JobPost.aggregate([
            { $match: { ...jobMatch, createdAt: { $gte: startDate } } },
            {
                $lookup: {
                    from: 'users',
                    localField: 'employer',
                    foreignField: '_id',
                    as: 'employer',
                },
            },
            { $unwind: '$employer' },
            {
                $lookup: {
                    from: 'companyprofiles',
                    localField: 'companyProfile',
                    foreignField: '_id',
                    as: 'company',
                },
            },
            { $unwind: { path: '$company', preserveNullAndEmptyArrays: true } },
            {
                $project: {
                    title: 1,
                    status: 1,
                    location: 1,
                    jobType: 1,
                    offeredSalary: 1,
                    applicationDeadline: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    profileViews: 1,
                    applicantCount: 1,
                    positions: 1,
                    employerName: '$employer.name',
                    companyName: { $ifNull: ['$company.companyName', 'N/A'] },
                }
            },
            { $sort: { applicantCount: -1 } },
        ]);

        // Now enrich jobs with application data
        const enrichedTopJobs = topJobs.map(job => {
            const jobId = job._id.toString();
            const jobApplications = applicationsByJobId[jobId] || [];
            
            // Calculate application metrics
            const totalApplications = jobApplications.length;
            const recentApplications = jobApplications.filter(app => 
                app.createdAt >= startDate
            ).length;
            const shortlistedCount = jobApplications.filter(app => 
                app.shortlisted === true
            ).length;
            const acceptedCount = jobApplications.filter(app => 
                app.status === 'Accepted'
            ).length;
            
            // Calculate acceptance rate
            const acceptanceRate = totalApplications > 0 
                ? Math.round((acceptedCount / totalApplications) * 100) 
                : 0;
            
            // Calculate fill percentage
            const positionsTotal = job.positions?.total || 0;
            const positionsRemaining = job.positions?.remaining || 0;
            const fillPercentage = positionsTotal > 0 
                ? Math.round(((positionsTotal - positionsRemaining) / positionsTotal) * 100)
                : 0;
            
            // Calculate views per application
            const viewsPerApplication = (job.profileViews || 0) > 0 && totalApplications > 0
                ? Math.round((job.profileViews || 0) / totalApplications)
                : 0;
            
            // Calculate time to first application
            let timeToFirstApplication = null;
            if (totalApplications > 0) {
                const firstApp = jobApplications.reduce((earliest, app) => 
                    earliest < app.createdAt ? earliest : app.createdAt, 
                    new Date()
                );
                timeToFirstApplication = Math.round(
                    (firstApp - job.createdAt) / (1000 * 60 * 60 * 24)
                );
            }
            
            // Calculate time to fill
            let timeToFill = null;
            if (job.status === 'Closed' && job.updatedAt && job.createdAt && positionsRemaining === 0) {
                timeToFill = Math.round(
                    (job.updatedAt - job.createdAt) / (1000 * 60 * 60 * 24)
                );
            }

            return {
                ...job,
                totalApplications,
                recentApplications,
                shortlistedCount,
                acceptedCount,
                acceptanceRate,
                positionsRemaining,
                positionsTotal,
                fillPercentage,
                viewsPerApplication,
                timeToFirstApplication,
                timeToFill
            };
        });

        const rankedTopJobs = enrichedTopJobs
            .sort((a, b) => {
                if (b.totalApplications !== a.totalApplications) return b.totalApplications - a.totalApplications;
                if (b.recentApplications !== a.recentApplications) return b.recentApplications - a.recentApplications;
                return new Date(b.createdAt) - new Date(a.createdAt);
            })
            .slice(0, topLimit);

        // Get job status distribution
        const allJobs = await JobPost.find({ ...jobMatch, createdAt: { $gte: startDate } }).lean();
        
        const jobStatusDistribution = {};
        allJobs.forEach(job => {
            const status = job.status || 'Unknown';
            if (!jobStatusDistribution[status]) {
                jobStatusDistribution[status] = {
                    count: 0,
                    totalApplications: 0,
                    totalPositions: 0,
                    filledPositions: 0
                };
            }
            
            const jobId = job._id.toString();
            const jobApps = applicationsByJobId[jobId] || [];
            
            jobStatusDistribution[status].count++;
            jobStatusDistribution[status].totalApplications += jobApps.length;
            jobStatusDistribution[status].totalPositions += (job.positions?.total || 0);
            jobStatusDistribution[status].filledPositions += (job.positions?.total || 0) - (job.positions?.remaining || 0);
        });

        const formattedStatusDistribution = Object.entries(jobStatusDistribution).map(([status, data]) => ({
            _id: status,
            count: data.count,
            totalApplications: data.totalApplications,
            // Keep one decimal so low-volume ratios (e.g., 17/108) don't collapse to 0
            avgApplications: data.count > 0 ? Number((data.totalApplications / data.count).toFixed(1)) : 0,
            avgFillRate: data.count > 0 ? Number((data.filledPositions / data.count).toFixed(1)) : 0,
        })).sort((a, b) => b.count - a.count);

        // Get job type distribution
        const jobTypeDistribution = {};
        allJobs.forEach(job => {
            const jobType = job.jobType || 'Unknown';
            if (!jobTypeDistribution[jobType]) {
                jobTypeDistribution[jobType] = {
                    count: 0,
                    totalApplications: 0,
                    totalSalary: 0,
                    salaryCount: 0
                };
            }
            
            const jobId = job._id.toString();
            const jobApps = applicationsByJobId[jobId] || [];
            
            jobTypeDistribution[jobType].count++;
            jobTypeDistribution[jobType].totalApplications += jobApps.length;
            
            // Extract salary from offeredSalary if possible
            if (job.offeredSalary && job.offeredSalary !== 'Negotiable') {
                const salaryMatch = job.offeredSalary.match(/[0-9]+(\.[0-9]+)?/g);
                if (salaryMatch && salaryMatch.length > 0) {
                    const avgSalary = salaryMatch.reduce((sum, num) => sum + parseFloat(num), 0) / salaryMatch.length;
                    jobTypeDistribution[jobType].totalSalary += avgSalary;
                    jobTypeDistribution[jobType].salaryCount++;
                }
            }
        });

        const formattedTypeDistribution = Object.entries(jobTypeDistribution).map(([jobType, data]) => ({
            _id: jobType,
            count: data.count,
            avgSalary: data.salaryCount > 0 ? Math.round(data.totalSalary / data.salaryCount) : 0,
            totalApplications: data.totalApplications,
            avgApplications: data.count > 0 ? Number((data.totalApplications / data.count).toFixed(1)) : 0,
        })).sort((a, b) => b.count - a.count);

        // Calculate overall metrics
        const totalJobs = allJobs.length;
        const totalApplications = applications.length;
        const avgApplicationsPerJob = totalJobs > 0 ? Math.round(totalApplications / totalJobs) : 0;

        // Calculate time to fill stats
        const filledJobs = allJobs.filter(job => 
            job.status === 'Closed' && 
            job.updatedAt && 
            job.createdAt && 
            (job.positions?.remaining || 0) === 0
        );
        
        const timeToFillStats = filledJobs.map(job => 
            Math.round((job.updatedAt - job.createdAt) / (1000 * 60 * 60 * 24))
        );
        
        const avgTimeToFill = timeToFillStats.length > 0 
            ? Math.round(timeToFillStats.reduce((a, b) => a + b, 0) / timeToFillStats.length)
            : 0;
        
        const medianTimeToFill = timeToFillStats.length > 0
            ? timeToFillStats.sort((a, b) => a - b)[Math.floor(timeToFillStats.length / 2)]
            : 0;

        // Calculate average acceptance rate from enriched jobs
        const validAcceptanceRates = rankedTopJobs
            .filter(job => job.totalApplications > 0)
            .map(job => job.acceptanceRate);
        
        const avgAcceptanceRate = validAcceptanceRates.length > 0
            ? Math.round(validAcceptanceRates.reduce((a, b) => a + b, 0) / validAcceptanceRates.length)
            : 0;

        return res.status(200).json({
            success: true,
            period,
            months: parseInt(months),
            topJobs: rankedTopJobs,
            jobStatusDistribution: formattedStatusDistribution,
            jobTypeDistribution: formattedTypeDistribution,
            metrics: {
                totalJobs,
                totalApplications,
                avgApplicationsPerJob,
                avgTimeToFill,
                medianTimeToFill,
                avgAcceptanceRate,
            },
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Get application trends across platform or assigned employers
 * @route GET /api/v1/hr-admin-dashboard/application-trends
 * @access Private (HR-Admin, Superadmin)
 */
hrAdminDashboardController.getApplicationTrends = async (req, res, next) => {
  try {
    const { period = 'monthly', months = 6 } = req.query;

    // console.log("testtt", user);


    // Keep application trends platform-wide for both HR Admin and Super Admin
    // so both dashboards show the same values.
    const applicationMatch = {};

    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - parseInt(months));

    // Get application trends by period
    const trends = await Application.aggregate([
      {
        $match: {
          createdAt: { $gte: startDate },
          ...applicationMatch,
        },
      },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
          },
          total: { $sum: 1 },
          pending: {
            $sum: { $cond: [{ $eq: ['$status', 'Pending'] }, 1, 0] },
          },
          reviewed: {
            $sum: { $cond: [{ $eq: ['$status', 'Reviewed'] }, 1, 0] },
          },
          accepted: {
            $sum: { $cond: [{ $eq: ['$status', 'Accepted'] }, 1, 0] },
          },
          rejected: {
            $sum: { $cond: [{ $eq: ['$status', 'Rejected'] }, 1, 0] },
          },
          shortlisted: {
            $sum: { $cond: [{ $eq: ['$shortlisted', true] }, 1, 0] },
          },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]);

    // Format trends data
    const formattedTrends = trends.map(item => ({
      period: `${item._id.year}-${String(item._id.month).padStart(2, '0')}`,
      label: `${new Date(item._id.year, item._id.month - 1).toLocaleString('default', { month: 'short' })} ${item._id.year}`,
      total: item.total,
      pending: item.pending,
      reviewed: item.reviewed,
      accepted: item.accepted,
      rejected: item.rejected,
      shortlisted: item.shortlisted,
      conversionRate: item.total > 0 ? Math.round((item.accepted / item.total) * 100) : 0,
    }));

    // Get top employers by applications
   // Top employers – improved
    const topEmployersPipeline = [
      { $match: { ...applicationMatch, createdAt: { $gte: startDate } } },
      {
        $lookup: { from: 'jobposts', localField: 'jobPost', foreignField: '_id', as: 'job' },
      },
      { $unwind: '$job' },
      {
        $group: {
          _id: '$job.employer',
          totalApplications: { $sum: 1 },
          shortlisted: { $sum: { $cond: [{ $eq: ['$shortlisted', true] }, 1, 0] } },
          accepted: { $sum: { $cond: [{ $eq: ['$status', 'Accepted'] }, 1, 0] } },
          lastActivity: { $max: '$createdAt' },
        },
      },
      {
        $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'employer' },
      },
      { $unwind: '$employer' },
      {
        $lookup: { from: 'companyprofiles', localField: '_id', foreignField: 'employer', as: 'company' },
      },
      { $unwind: { path: '$company', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          employerId: '$_id',
          employerName: '$employer.name',
          companyName: { $ifNull: ['$company.companyName', 'N/A'] },
          totalApplications: 1,
          acceptedApplications: '$accepted',
          shortlistRate: { $cond: [{ $gt: ['$totalApplications', 0] }, { $round: [{ $multiply: [{ $divide: ['$shortlisted', '$totalApplications'] }, 100] }, 1] }, 0] },
          acceptanceRate: { $cond: [{ $gt: ['$totalApplications', 0] }, { $round: [{ $multiply: [{ $divide: ['$accepted', '$totalApplications'] }, 100] }, 1] }, 0] },
          daysSinceLastActivity: {
            $round: [{ $divide: [{ $subtract: [new Date(), '$lastActivity'] }, 1000 * 60 * 60 * 24] }, 0],
          },
        },
      },
      { $sort: { totalApplications: -1, acceptedApplications: -1, employerName: 1 } },
      { $limit: 5 },
    ];

    const topEmployers = await Application.aggregate(topEmployersPipeline);

    // Format top employers data
    const formattedTopEmployers = topEmployers.map(item => ({
      employerId: item.employerId,
      employerName: item.employerName,
      companyName: item.companyName,
      totalApplications: item.totalApplications,
      acceptedApplications: item.acceptedApplications || 0,
      shortlistRate: item.shortlistRate,
      acceptanceRate: item.acceptanceRate,
      avgResponseTime: item.daysSinceLastActivity,
      daysSinceLastActivity: item.daysSinceLastActivity,
    }));

    return res.status(200).json({
      success: true,
      period,
      months: parseInt(months),
      trends: formattedTrends,
      topEmployers: formattedTopEmployers,
      totalApplications: formattedTrends.reduce((sum, item) => sum + item.total, 0),
      avgMonthlyApplications: Math.round(
        formattedTrends.reduce((sum, item) => sum + item.total, 0) / formattedTrends.length
      ),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get candidate analytics for HR-Admin dashboard
 * @route GET /api/v1/hr-admin-dashboard/candidate-analytics
 * @access Private (HR-Admin, Superadmin)
 */
hrAdminDashboardController.getCandidateAnalytics = async (req, res, next) => {
  try {
    const { days = 30 } = req.query;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));
    // Keep candidate analytics platform-wide for both HR Admin and Super Admin
    // so both dashboards show the same values.
    const candidateUserMatch = {};
    const candidateProfileMatch = {};
    const applicationMatch = {};

    // 1. Registration trends (daily)
    const registrationTrends = await User.aggregate([
      {
        $match: {
          role: 'candidate',
          isActive: true,
          createdAt: { $gte: startDate },
          ...candidateUserMatch,
        },
      },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
            day: { $dayOfMonth: '$createdAt' },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } },
    ]);

    // 2. Profile completion stats (improved – no profileCompletion field needed)
    const profileStats = await CandidateProfile.aggregate([
      { $match: candidateProfileMatch },
      {
        $group: {
          _id: null,
          totalProfiles: { $sum: 1 },
          withResume: {
            $sum: { $cond: [{ $ne: ['$resume', null] }, 1, 0] },
          },
          withPhoto: {
            $sum: { $cond: [{ $ne: ['$profilePhoto', null] }, 1, 0] },
          },
          withSkills: {
            $sum: {
              $cond: [
                { $and: [{ $isArray: '$skills' }, { $gt: [{ $size: '$skills' }, 0] }] },
                1,
                0,
              ],
            },
          },
          withExperience: {
            $sum: {
              $cond: [{ $and: [{ $ne: ['$experience', null] }, { $ne: ['$experience', ''] }] }, 1, 0],
            },
          },
          withLocation: {
            $sum: { $cond: [{ $ne: ['$location.city', null] }, 1, 0] },
          },
          // ────────────────────────────────────────────────
          // Calculate average profile completion percentage
          // Each field contributes 20% → total 100%
          // ────────────────────────────────────────────────
          avgCompletionPercentage: {
            $avg: {
              $add: [
                { $cond: [{ $ne: ['$resume', null] }, 20, 0] },           // 20% for resume
                { $cond: [{ $ne: ['$profilePhoto', null] }, 20, 0] },     // 20% for photo
                { $cond: [{ $and: [{ $isArray: '$skills' }, { $gt: [{ $size: '$skills' }, 0] }] }, 20, 0] },  // 20% for skills
                { $cond: [{ $and: [{ $ne: ['$experience', null] }, { $ne: ['$experience', ''] }] }, 20, 0] }, // 20% for experience
                { $cond: [{ $ne: ['$location.city', null] }, 20, 0] }     // 20% for location
              ]
            }
          },
        },
      },
    ]);

    // 3. Top 10 skills
    const topSkills = await CandidateProfile.aggregate([
      { $match: { ...candidateProfileMatch, skills: { $exists: true, $type: 'array', $ne: [] } } },
      { $unwind: '$skills' },
      { $group: { _id: '$skills', count: { $sum: 1 } } },
      {
        $lookup: {
          from: 'skills',
          localField: '_id',
          foreignField: '_id',
          as: 'skillDoc',
        },
      },
      {
        $unwind: {
          path: '$skillDoc',
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $project: {
          _id: 0,
          skill: {
            $ifNull: [
              '$skillDoc.name',
              {
                $cond: [
                  { $eq: [{ $type: '$_id' }, 'string'] },
                  '$_id',
                  'Unknown Skill',
                ],
              },
            ],
          },
          count: 1,
        },
      },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]);


    // 4. Application behavior
    const applicationBehavior = await Application.aggregate([
      { $match: { createdAt: { $gte: startDate }, ...applicationMatch } },
      {
        $group: {
          _id: '$candidate',
          totalApplications: { $sum: 1 },
          firstApplication: { $min: '$createdAt' },
          lastApplication: { $max: '$createdAt' },
        },
      },
      {
        $group: {
          _id: null,
          totalActiveCandidates: { $sum: 1 },
          avgApplicationsPerCandidate: { $avg: '$totalApplications' },
          candidatesWithMultipleApps: {
            $sum: { $cond: [{ $gt: ['$totalApplications', 1] }, 1, 0] },
          },
          avgDaysBetweenApps: {
            $avg: {
              $cond: [
                { $gt: ['$totalApplications', 1] },
                { $divide: [{ $subtract: ['$lastApplication', '$firstApplication'] }, 1000 * 60 * 60 * 24] },
                0,
              ],
            },
          },
        },
      },
    ]);

    const stats = profileStats[0] || {
      totalProfiles: 0,
      withResume: 0,
      withPhoto: 0,
      withSkills: 0,
      withExperience: 0,
      withLocation: 0,
    };

    const behavior = applicationBehavior[0] || {
      totalActiveCandidates: 0,
      avgApplicationsPerCandidate: 0,
      candidatesWithMultipleApps: 0,
      avgDaysBetweenApps: 0,
    };

    return res.status(200).json({
      success: true,
      periodDays: parseInt(days),
      registrationTrends: registrationTrends.map(t => ({
        date: `${t._id.year}-${String(t._id.month).padStart(2, '0')}-${String(t._id.day).padStart(2, '0')}`,
        registrations: t.count,
      })),
      profileCompletion: {
        totalProfiles: stats.totalProfiles,
        resumeUploadRate: stats.totalProfiles ? Math.round((stats.withResume / stats.totalProfiles) * 100) : 0,
        photoUploadRate: stats.totalProfiles ? Math.round((stats.withPhoto / stats.totalProfiles) * 100) : 0,
        skillsAddedRate: stats.totalProfiles ? Math.round((stats.withSkills / stats.totalProfiles) * 100) : 0,
        experienceAddedRate: stats.totalProfiles ? Math.round((stats.withExperience / stats.totalProfiles) * 100) : 0,
        locationAddedRate: stats.totalProfiles ? Math.round((stats.withLocation / stats.totalProfiles) * 100) : 0,
        avgCompletionPercentage: Math.round(stats.avgCompletionPercentage) || 0,    
      },
      topSkills: topSkills,
      applicationBehavior: {
        totalActiveCandidates: behavior.totalActiveCandidates,
        avgApplicationsPerCandidate: Number(behavior.avgApplicationsPerCandidate.toFixed(1)),
        multipleApplicationRate: behavior.totalActiveCandidates
          ? Math.round((behavior.candidatesWithMultipleApps / behavior.totalActiveCandidates) * 100)
          : 0,
        avgDaysBetweenApplications: Number(behavior.avgDaysBetweenApps.toFixed(1)),
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get pending approvals and actions needed
 * @route GET /api/v1/hr-admin-dashboard/pending-actions
 * @access Private (HR-Admin, Superadmin)
 */
// hrAdminDashboardController.getPendingActions = async (req, res, next) => {
//   try {
//     const user = req.user;

//     let companyMatch = {};
//     let userMatch = {};

//     // For HR-Admin, filter by assigned employers
//     if (user.role === 'hr-admin' && user.employerIds && user.employerIds.length > 0) {
//       companyMatch.employer = { $in: user.employerIds };
//       userMatch._id = { $in: user.employerIds };
//     }

//     // Get pending company approvals
//     const pendingCompanies = await CompanyProfile.find({
//       ...companyMatch,
//       status: 'pending',
//     })
//       .populate('employer', 'name email')
//       .select('companyName email phone status createdAt')
//       .sort({ createdAt: -1 })
//       .limit(10);

//     // Get pending job approvals
//     const pendingJobs = await JobPost.find({
//       status: 'Pending',
//       ...(user.role === 'hr-admin' && user.employerIds ? { employer: { $in: user.employerIds } } : {}),
//     })
//       .populate('employer', 'name email')
//       .populate('companyProfile', 'companyName')
//       .select('title employer companyProfile status createdAt')
//       .sort({ createdAt: -1 })
//       .limit(10);

//     // Get pending employer registrations
//     const pendingEmployers = await User.find({
//       role: 'employer',
//       status: 'pending',
//       ...userMatch,
//     })
//       .select('name email createdAt')
//       .sort({ createdAt: -1 })
//       .limit(10);

//     // Get pending candidate registrations
//     const pendingCandidates = await User.find({
//       role: 'candidate',
//       status: 'pending',
//       ...(user.role === 'hr-admin' && user.candidateIds && user.candidateIds.length > 0
//           ? { _id: { $in: user.candidateIds } }
//           : {}),
//     })
//       .select('name email createdAt')
//       .sort({ createdAt: -1 })
//       .limit(10);

//     // Get recent activities by HR-Admin
//     const recentActivities = await JobPost.find({
//       postedBy: user.id,
//       createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }, // Last 7 days
//     })
//       .select('title status createdAt')
//       .sort({ createdAt: -1 })
//       .limit(10);

//     return res.status(200).json({
//       success: true,
//       pendingActions: {
//         companies: {
//           count: pendingCompanies.length,
//           items: pendingCompanies,
//         },
//         jobs: {
//           count: pendingJobs.length,
//           items: pendingJobs,
//         },
//         employers: {
//           count: pendingEmployers.length,
//           items: pendingEmployers,
//         },
//         candidates: {   
//           count: pendingCandidates.length,
//           items: pendingCandidates,
//         },
//       },
//       recentActivities,
//       totalPendingActions: pendingCompanies.length + pendingJobs.length + pendingEmployers.length + pendingCandidates.length,
//     });
//   } catch (error) {
//     next(error);
//   }
// };


/**
 * Get pending approvals and actions needed
 * @route GET /api/v1/hr-admin-dashboard/pending-actions
 * @access Private (HR-Admin, Superadmin)
 */
hrAdminDashboardController.getPendingActions = async (req, res, next) => {
  try {
    // Keep pending actions platform-wide for both HR Admin and Super Admin
    // so both dashboards show the same values.
    const companyMatch = {};
    const userMatch = {};

    // 1. Get pending company profile approvals (CompanyProfile model)
    const pendingCompanies = await CompanyProfile.find({
      ...companyMatch,
      status: 'pending',
    })
      .populate('employer', 'name email')
      .select('companyName email phone status createdAt')
      .sort({ createdAt: -1 })
      .limit(10);

    // 2. Get pending job approvals (JobPost model)
    const pendingJobs = await JobPost.find({
      status: 'Pending',
    })
      .populate('employer', 'name email')
      .populate('companyProfile', 'companyName')
      .select('title employer companyProfile status createdAt')
      .sort({ createdAt: -1 })
      .limit(10);

    // 3. Get pending employer account registrations (User model)
    const pendingEmployers = await User.find({
      role: 'employer',
      status: 'pending',
      ...userMatch,
    })
      .select('name email createdAt')
      .sort({ createdAt: -1 })
      .limit(10);

    // 4. Get pending candidate account registrations (User model)
    const pendingCandidates = await User.find({
      role: 'candidate',
      status: 'pending',
      isActive: true,
      $or: [{ isDeleted: false }, { isDeleted: { $exists: false } }],
    })
      .select('name email status createdAt')
      .sort({ createdAt: -1 })
      .limit(10);

    // 5. Get recent activities by HR-Admin
    const recentActivities = await JobPost.find({
      createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }, // Last 7 days
    })
      .select('title status createdAt')
      .sort({ createdAt: -1 })
      .limit(10);

    return res.status(200).json({
      success: true,
      pendingActions: {
        companies: {
          count: pendingCompanies.length,
          items: pendingCompanies,
        },
        jobs: {
          count: pendingJobs.length,
          items: pendingJobs,
        },
        employers: {
          count: pendingEmployers.length,
          items: pendingEmployers,
        },
        candidates: {   
          count: pendingCandidates.length,
          items: pendingCandidates,
        },
      },
      recentActivities,
      totalPendingActions: pendingCompanies.length + pendingJobs.length + pendingEmployers.length + pendingCandidates.length,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get revenue/reporting metrics (if applicable)
 * @route GET /api/v1/hr-admin-dashboard/revenue-metrics
 * @access Private (HR-Admin, Superadmin)
 */
hrAdminDashboardController.getRevenueMetrics = async (req, res, next) => {
  try {
    const { months = 6 } = req.query;

    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - parseInt(months));

    // Keep revenue metrics platform-wide for both HR Admin and Super Admin
    // so both dashboards show the same values.
    const jobMatch = {};

    // Get job postings over time (assuming each job posting generates revenue)
    const jobPostingTrends = await JobPost.aggregate([
      {
        $match: {
          ...jobMatch,
          createdAt: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
          },
          count: { $sum: 1 },
          // Assuming revenue calculation based on job type/level
          estimatedRevenue: {
            $sum: {
                $switch: {
                branches: [
                    { case: { $eq: ['$jobType', 'Full-time'] },   then: 3500 },
                    { case: { $eq: ['$jobType', 'Part-time'] },   then: 1800 },
                    { case: { $eq: ['$jobType', 'Contract'] },    then: 2500 },
                    { case: { $eq: ['$jobType', 'Freelance'] },   then: 1200 },
                    { case: { $eq: ['$jobType', 'Internship'] },  then: 800  },
                ],
                default: 2000,
                }
            }
         },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]);

    // Calculate employer engagement metrics
    const employerEngagement = await JobPost.aggregate([
      {
        $match: {
          ...jobMatch,
          createdAt: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: '$employer',
          totalJobs: { $sum: 1 },
          totalApplications: { $sum: '$applicantCount' },
          lastJobDate: { $max: '$createdAt' },
        },
      },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'employer',
        },
      },
      { $unwind: '$employer' },
      {
        $project: {
          employerName: '$employer.name',
          email: '$employer.email',
          totalJobs: 1,
          totalApplications: 1,
          lastJobDate: 1,
          daysSinceLastJob: {
            $divide: [
              { $subtract: [new Date(), '$lastJobDate'] },
              1000 * 60 * 60 * 24,
            ],
          },
        },
      },
      { $sort: { totalJobs: -1 } },
      { $limit: 10 },
    ]);

    // Format trends data
    const formattedTrends = jobPostingTrends.map(item => ({
      period: `${item._id.year}-${String(item._id.month).padStart(2, '0')}`,
      jobsPosted: item.count,
      estimatedRevenue: item.estimatedRevenue,
      avgRevenuePerJob: Math.round(item.estimatedRevenue / item.count),
    }));

    // Calculate totals
    const totalJobs = formattedTrends.reduce((sum, item) => sum + item.jobsPosted, 0);
    const totalRevenue = formattedTrends.reduce((sum, item) => sum + item.estimatedRevenue, 0);
    const avgMonthlyRevenue = Math.round(totalRevenue / formattedTrends.length);

    // Calculate growth
    const recentMonths = formattedTrends.slice(-3);
    const olderMonths = formattedTrends.slice(-6, -3);
    const recentRevenue = recentMonths.reduce((sum, item) => sum + item.estimatedRevenue, 0);
    const olderRevenue = olderMonths.reduce((sum, item) => sum + item.estimatedRevenue, 0);
    const revenueGrowth = olderRevenue > 0 
      ? Math.round(((recentRevenue - olderRevenue) / olderRevenue) * 100)
      : recentRevenue > 0 ? 100 : 0;

    return res.status(200).json({
      success: true,
      disclaimer: 'Revenue metrics are estimates for demonstration purposes',
      trends: formattedTrends,
      employerEngagement,
      summary: {
        totalJobs,
        totalRevenue,
        avgMonthlyRevenue,
        revenueGrowth,
        avgRevenuePerJob: totalJobs > 0 ? Math.round(totalRevenue / totalJobs) : 0,
        activeEmployers: employerEngagement.length,
        highlyEngagedEmployers: employerEngagement.filter(e => e.totalJobs >= 3).length,
      },
      periodMonths: parseInt(months),
    });
  } catch (error) {
    next(error);
  }
};

/**
 *  MONTHLY PERFORMANCE REPORT
 * @route GET /api/v1/hr-admin-dashboard/reports/monthly-performance
 * @param {string} month - YYYY-MM format
 */
hrAdminDashboardController.getMonthlyPerformanceReport = async (req, res, next) => {
  try {
    const user = req.user;
    const { month = new Date().toISOString().slice(0, 7) } = req.query;

    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ success: false, message: 'Invalid month format. Use YYYY-MM' });
    }

    const [year, monthNum] = month.split('-').map(Number);
    const startDate = new Date(year, monthNum - 1, 1);
    const endDate = new Date(year, monthNum, 0, 23, 59, 59, 999);

    // Role-based filters
    let jobFilter = {};
    if (user.role === 'hr-admin') {
      jobFilter = { employer: { $in: user.employerIds || [] } };
    }

    // Get essential data only
    const [
      jobs,
      applications,
      candidates,
      topJobs
    ] = await Promise.all([
      // Basic job metrics
      JobPost.aggregate([
        { $match: { ...jobFilter, createdAt: { $gte: startDate, $lte: endDate } } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            published: { $sum: { $cond: [{ $eq: ['$status', 'Published'] }, 1, 0] } },
            closed: { $sum: { $cond: [{ $eq: ['$status', 'Closed'] }, 1, 0] } },
            avgTimeToFill: {
              $avg: {
                $cond: [
                  { $eq: ['$status', 'Closed'] },
                  { $divide: [{ $subtract: ['$updatedAt', '$createdAt'] }, 86400000] },
                  null
                ]
              }
            }
          }
        }
      ]),

      // Basic application metrics
      Application.aggregate([
        { $match: { createdAt: { $gte: startDate, $lte: endDate } } },
        {
          $lookup: {
            from: 'jobposts',
            localField: 'jobPost',
            foreignField: '_id',
            as: 'job'
          }
        },
        { $unwind: '$job' },
        {
          $match: user.role === 'hr-admin'
            ? { 'job.employer': { $in: user.employerIds || [] } }
            : {}
        },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            shortlisted: { $sum: { $cond: [{ $eq: ['$shortlisted', true] }, 1, 0] } },
            accepted: { $sum: { $cond: [{ $eq: ['$status', 'Accepted'] }, 1, 0] } },
            conversionRate: {
              $avg: {
                $cond: [
                  { $eq: ['$status', 'Accepted'] },
                  1,
                  0
                ]
              }
            }
          }
        }
      ]),

      // Candidate registrations
      User.countDocuments({
        role: 'candidate',
        isActive: true,
        createdAt: { $gte: startDate, $lte: endDate }
      }),

      // Top 5 performing jobs
      JobPost.aggregate([
        { $match: { ...jobFilter, createdAt: { $gte: startDate, $lte: endDate } } },
        {
          $lookup: {
            from: 'applications',
            localField: '_id',
            foreignField: 'jobPost',
            as: 'applications'
          }
        },
        {
          $lookup: {
            from: 'companyprofiles',
            localField: 'companyProfile',
            foreignField: '_id',
            as: 'company'
          }
        },
        { $unwind: { path: '$company', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            title: 1,
            companyName: '$company.companyName',
            applications: { $size: '$applications' },
            accepted: {
              $size: {
                $filter: {
                  input: '$applications',
                  as: 'app',
                  cond: { $eq: ['$$app.status', 'Accepted'] }
                }
              }
            },
            status: 1
          }
        },
        { $sort: { applications: -1 } },
        { $limit: 5 }
      ])
    ]);

    // Generate simple Excel report
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'HR Dashboard';
    
    // 1. Summary Sheet
    const summary = workbook.addWorksheet('Monthly Summary');
    
    // Header
    summary.mergeCells('A1:B1');
    summary.getCell('A1').value = `Performance Report - ${month}`;
    summary.getCell('A1').font = { bold: true, size: 14 };
    
    summary.addRow([]);
    
    // KPIs
    summary.addRow(['Key Metrics', 'Value']);
    summary.addRow(['Total Jobs Posted', jobs[0]?.total || 0]);
    summary.addRow(['Active Jobs', jobs[0]?.published || 0]);
    summary.addRow(['Jobs Filled', jobs[0]?.closed || 0]);
    summary.addRow(['Avg Time to Fill (Days)', Math.round(jobs[0]?.avgTimeToFill || 0)]);
    summary.addRow(['Total Applications', applications[0]?.total || 0]);
    summary.addRow(['Shortlisted', applications[0]?.shortlisted || 0]);
    summary.addRow(['Hired', applications[0]?.accepted || 0]);
    summary.addRow(['Conversion Rate', `${Math.round((applications[0]?.conversionRate || 0) * 100)}%`]);
    summary.addRow(['New Candidates', candidates]);
    
    // 2. Top Jobs Sheet
    const topJobsSheet = workbook.addWorksheet('Top Performing Jobs');
    topJobsSheet.addRow(['Top 5 Jobs by Applications']);
    topJobsSheet.addRow(['Job Title', 'Company', 'Applications', 'Hired', 'Status']);
    
    topJobs.forEach(job => {
      topJobsSheet.addRow([
        job.title,
        job.companyName || 'N/A',
        job.applications,
        job.accepted,
        job.status
      ]);
    });
    
    // Simple styling
    [summary, topJobsSheet].forEach(sheet => {
      sheet.getRow(1).font = { bold: true };
      sheet.getRow(2).font = { bold: true };
      
      sheet.columns.forEach(column => {
        column.width = column.values.reduce((max, value) => {
          return Math.max(max, value ? value.toString().length : 0);
        }, 10) + 2;
      });
    });
    
    // Set headers and send
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=performance-${month}.xlsx`);
    
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    next(error);
  }
};

/**
 * EMPLOYER ACTIVITY REPORT
 * @route GET /api/v1/hr-admin-dashboard/reports/employer-activity
 * @param {string} months - Last X months (default: 3)
 */
hrAdminDashboardController.getEmployerActivityReport = async (req, res, next) => {
  try {
     const user = req.user;
    const { months = 3 } = req.query;
    const monthsNum = parseInt(months, 10);

    if (isNaN(monthsNum) || monthsNum < 1 || monthsNum > 24) {
      return res.status(400).json({ success: false, message: 'Invalid months value' });
    }
    
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - monthsNum);
    
    // Role-based filter
    let employerFilter = {};
    if (user.role === 'hr-admin') {
      employerFilter = { _id: { $in: user.employerIds || [] } };
    }
    
    // First, get all employers
    const employers = await User.aggregate([
      {
        $match: {
          role: 'employer',
          isActive: true,
          ...employerFilter
        }
      },
      {
        $lookup: {
          from: 'companyprofiles',
          localField: '_id',
          foreignField: 'employer',
          as: 'company'
        }
      },
      { $unwind: { path: '$company', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          name: 1,
          email: 1,
          companyName: '$company.companyName',
          isVerified: '$company.isVerified',
          lastLogin: 1,
          status: 1,
          employerId: '$_id'
        }
      },
      { $sort: { name: 1 } }
    ]);
    
    // Now, for each employer, get their job and application counts
    const employersWithStats = await Promise.all(
      employers.map(async (employer) => {
        const employerId = employer.employerId;
        
        // Get jobs posted by this employer in the period
        const jobs = await JobPost.find({
          employer: employerId,
          createdAt: { $gte: startDate }
        }).select('_id status applicationDeadline');
        
        const jobsPosted = jobs.length;
        const activeJobs = jobs.filter(job => 
          job.status === 'Published' && 
          job.applicationDeadline >= new Date()
        ).length;
        
        // Get job IDs for this employer
        const jobIds = jobs.map(job => job._id);
        
        // Count applications for these jobs in the period
        let totalApplications = 0;
        if (jobIds.length > 0) {
          totalApplications = await Application.countDocuments({
            jobPost: { $in: jobIds },
            createdAt: { $gte: startDate }
          });
        }
        
        return {
          ...employer,
          jobsPosted,
          activeJobs,
          totalApplications
        };
      })
    );
    
    // Sort by jobs posted (descending)
    employersWithStats.sort((a, b) => b.jobsPosted - a.jobsPosted);
    
    // Generate Excel Report
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'HR Dashboard System';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Employer Activity');

    // Title
    sheet.mergeCells('A1:G1');
    sheet.getCell('A1').value = 'Employer Activity Report';
    sheet.getCell('A1').font = { size: 16, bold: true };
    sheet.getCell('A1').alignment = { horizontal: 'center' };
    
    sheet.mergeCells('A2:G2');
    sheet.getCell('A2').value = `Last ${monthsNum} months (${startDate.toLocaleDateString()} - ${new Date().toLocaleDateString()})`;
    sheet.getCell('A2').font = { italic: true };
    sheet.getCell('A2').alignment = { horizontal: 'center' };
    
    sheet.addRow([]);

    // Header row
    sheet.addRow([
      'Employer',
      'Company',
      'Email',
      'Jobs Posted',
      'Active Jobs',
      'Applications',
      'Verified'
    ]);

    const headerRow = sheet.getRow(4);
    headerRow.font = { bold: true };
    headerRow.alignment = { horizontal: 'center' };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' }
    };

    // Data rows
    employersWithStats.forEach(emp => {
      sheet.addRow([
        emp.name,
        emp.companyName || 'N/A',
        emp.email || 'N/A',
        emp.jobsPosted,
        emp.activeJobs || 0,
        emp.totalApplications,
        emp.isVerified ? '✅ Yes' : '❌ No'
      ]);
    });

    // Summary
    const summaryRow = employersWithStats.length + 5;
    sheet.addRow([]);
    sheet.mergeCells(`A${summaryRow}:G${summaryRow}`);
    sheet.getCell(`A${summaryRow}`).value = 'Summary Statistics';
    sheet.getCell(`A${summaryRow}`).font = { bold: true, size: 12 };

    const activeEmployers = employersWithStats.filter(e => e.jobsPosted > 0).length;
    const totalJobs = employersWithStats.reduce((sum, e) => sum + e.jobsPosted, 0);
    const totalActiveJobs = employersWithStats.reduce((sum, e) => sum + (e.activeJobs || 0), 0);
    const totalApps = employersWithStats.reduce((sum, e) => sum + e.totalApplications, 0);
    const verifiedCompanies = employersWithStats.filter(e => e.isVerified).length;
    // console.log("efegregreg", totalApps);
    
    sheet.addRow(['Active Employers', activeEmployers]);
    sheet.addRow(['Total Employers', employersWithStats.length]);
    sheet.addRow(['Total Jobs Posted', totalJobs]);
    sheet.addRow(['Currently Active Jobs', totalActiveJobs]);
    sheet.addRow(['Total Applications', totalApps]);
    sheet.addRow(['Verified Companies', verifiedCompanies]);
    sheet.addRow([
      'Avg Applications per Job',
      totalJobs > 0 ? Math.round(totalApps / totalJobs) : 0
    ]);

    // Styling
    sheet.columns = [
      { width: 20 },
      { width: 25 },
      { width: 25 },
      { width: 12 },
      { width: 12 },
      { width: 15 },
      { width: 10 }
    ];

    // Add borders
    for (let i = 4; i <= employersWithStats.length + 4; i++) {
      sheet.getRow(i).eachCell(cell => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' }
        };
      });
    }

    // Summary borders
    for (let i = summaryRow; i <= sheet.rowCount; i++) {
      sheet.getRow(i).getCell(1).border = {
        left: { style: 'thin' },
        right: { style: 'thin' }
      };
      sheet.getRow(i).getCell(2).border = {
        right: { style: 'thin' }
      };
    }
    
    // Freeze header
    sheet.views = [{ state: 'frozen', ySplit: 4 }];
    
    // Send file
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=employer-activity-${monthsNum}-months.xlsx`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    next(error);
  }
};

/**
 * SKILLS DEMAND REPORT 
 * @route GET /api/v1/hr-admin-dashboard/reports/skills-demand
 * @param {string} months - Last X months (default: 6)
 */
hrAdminDashboardController.getSkillsDemandReport = async (req, res, next) => {
  try {
    const user = req.user;
    const { months = 6 } = req.query;
    const monthsNum = parseInt(months, 10);

    if (isNaN(monthsNum) || monthsNum < 1 || monthsNum > 24) {
      return res.status(400).json({ success: false, message: 'Invalid months value' });
    }
    
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - monthsNum);
    
    // Role-based filter for jobs
    let jobFilter = {};
    if (user.role === 'hr-admin') {
      jobFilter = { employer: { $in: user.employerIds || [] } };
    }

    console.log("Fetching skills data for last", monthsNum, "months...");

    // GET SKILLS DEMAND (FROM JOBS - specialisms)
    const jobSkills = await JobPost.aggregate([
      {
        $match: {
          ...jobFilter,
          createdAt: { $gte: startDate },
          specialisms: { $exists: true, $ne: [] }
        }
      },
      { $unwind: '$specialisms' },
      {
        $group: {
          _id: '$specialisms',
          demandCount: { $sum: 1 },
          totalJobs: { $sum: 1 },
          // Get some job details for context
          sampleTitles: { $push: '$title' },
          avgApplicantCount: { $avg: '$applicantCount' }
        }
      },
      { $sort: { demandCount: -1 } },
      { $limit: 50 }
    ]);

    console.log("Skills from job specialisms:", jobSkills.length);

    // GET SKILLS SUPPLY (FROM CANDIDATE RESUME - skills field)
    const candidateResumeSkills = await CandidateResume.aggregate([
      {
        $match: {
          createdAt: { $gte: startDate },
          skills: { $exists: true, $ne: [] }
        }
      },
      { $unwind: '$skills' },
      {
        $group: {
          _id: '$skills',
          supplyCount: { $sum: 1 },
          totalCandidates: { $sum: 1 },
          // Get candidate experience from resume if available
          avgExperienceCount: { 
            $avg: { 
              $cond: [
                { $gt: [{ $size: '$experience' }, 0] },
                { $size: '$experience' },
                null
              ]
            }
          }
        }
      },
      { $sort: { supplyCount: -1 } },
      { $limit: 50 }
    ]);

    console.log("Skills from candidate resumes:", candidateResumeSkills.length);

    // COMBINE DEMAND AND SUPPLY DATA
    const skillsMap = new Map();
    
    // Normalize skill names (case-insensitive, trimmed)
    const normalizeSkill = (skill) => {
      if (!skill || typeof skill !== 'string') return '';
      return skill.trim().toLowerCase();
    };

    // Add demand skills from job specialisms
    jobSkills.forEach(jobSkill => {
      const skillName = normalizeSkill(jobSkill._id);
      if (!skillName) return;
      
      skillsMap.set(skillName, {
        skill: jobSkill._id, // Keep original case for display
        normalizedSkill: skillName,
        demand: jobSkill.demandCount || 0,
        supply: 0,
        source: 'Job Specialism',
        jobCount: jobSkill.totalJobs || 0,
        avgApplicants: Math.round(jobSkill.avgApplicantCount || 0),
        sampleJobTitles: jobSkill.sampleTitles?.slice(0, 3) || []
      });
    });
    
    // Add supply skills from candidate resumes
    candidateResumeSkills.forEach(candidateSkill => {
      const skillName = normalizeSkill(candidateSkill._id);
      if (!skillName) return;
      
      if (skillsMap.has(skillName)) {
        const existing = skillsMap.get(skillName);
        existing.supply = candidateSkill.supplyCount || 0;
        existing.candidateCount = candidateSkill.totalCandidates || 0;
        existing.source = 'Both';
      } else {
        skillsMap.set(skillName, {
          skill: candidateSkill._id,
          normalizedSkill: skillName,
          demand: 0,
          supply: candidateSkill.supplyCount || 0,
          source: 'Candidate Resume',
          candidateCount: candidateSkill.totalCandidates || 0,
          avgExperienceCount: Math.round(candidateSkill.avgExperienceCount || 0)
        });
      }
    });

    // CALCULATE METRICS AND GAPS
    const skillsData = Array.from(skillsMap.values())
      .map(skill => {
        const gap = skill.demand - skill.supply;
        
        // Calculate gap status
        let status = '';
        let statusColor = '';
        let priority = 0;
        
        if (skill.demand === 0) {
          status = 'Surplus';
          statusColor = 'FFCCE5FF';
          priority = 3;
        } else if (skill.supply === 0) {
          status = 'Critical Shortage';
          statusColor = 'FFFFCCCC';
          priority = 1;
        } else {
          const ratio = skill.supply / skill.demand;
          if (ratio >= 1.5) {
            status = 'High Surplus';
            statusColor = 'FFCCE5FF';
            priority = 4;
          } else if (ratio >= 1.0) {
            status = 'Balanced';
            statusColor = 'FFCCFFCC';
            priority = 3;
          } else if (ratio >= 0.5) {
            status = 'Moderate Gap';
            statusColor = 'FFFFFFCC';
            priority = 2;
          } else {
            status = 'High Gap';
            statusColor = 'FFFFE5CC';
            priority = 1;
          }
        }
        
        // Calculate gap percentage
        const gapPercentage = skill.demand > 0 
          ? Math.round((gap / skill.demand) * 100)
          : skill.supply > 0 ? -100 : 0;
        
        return {
          ...skill,
          gap,
          gapPercentage,
          status,
          statusColor,
          priority
        };
      })
      .sort((a, b) => {
        // Sort by priority (critical shortages first), then by demand, then by gap
        if (a.priority !== b.priority) return a.priority - b.priority;
        if (b.demand !== a.demand) return b.demand - a.demand;
        return Math.abs(b.gap) - Math.abs(a.gap);
      })
      .slice(0, 40); // Top 40 skills

    console.log("Final skills data count:", skillsData.length);

    // GENERATE EXCEL REPORT
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'HR Dashboard System';
    workbook.created = new Date();

    // Sheet 1: Skills Analysis
    const sheet = workbook.addWorksheet('Skills Analysis');
    
    // Title
    sheet.mergeCells('A1:D1');
    sheet.getCell('A1').value = 'Skills Demand vs Supply Analysis';
    sheet.getCell('A1').font = { size: 16, bold: true };
    sheet.getCell('A1').alignment = { horizontal: 'center' };
    
    sheet.mergeCells('A2:D2');
    sheet.getCell('A2').value = `Last ${monthsNum} months (${startDate.toLocaleDateString('en-IN')} - ${new Date().toLocaleDateString('en-IN')})`;
    sheet.getCell('A2').font = { italic: true };
    sheet.getCell('A2').alignment = { horizontal: 'center' };
    
    sheet.addRow([]);
    
    // Summary stats
    const totalDemand = skillsData.reduce((sum, s) => sum + s.demand, 0);
    const totalSupply = skillsData.reduce((sum, s) => sum + s.supply, 0);
    const criticalShortages = skillsData.filter(s => s.status === 'Critical Shortage').length;
    const highGaps = skillsData.filter(s => s.status === 'High Gap').length;
    const balanced = skillsData.filter(s => s.status === 'Balanced').length;
    const surplus = skillsData.filter(s => s.status.includes('Surplus')).length;
    
    sheet.addRow(['Summary Statistics', '']);
    sheet.getRow(sheet.rowCount).font = { bold: true };
    
    sheet.addRow(['Total Skills Analyzed', skillsData.length]);
    sheet.addRow(['Total Demand (Job Posts)', totalDemand]);
    sheet.addRow(['Total Supply (Candidates)', totalSupply]);
    sheet.addRow(['Overall Gap', totalDemand - totalSupply]);
    sheet.addRow(['Critical Shortage Skills', criticalShortages]);
    sheet.addRow(['High Gap Skills', highGaps]);
    sheet.addRow(['Balanced Skills', balanced]);
    sheet.addRow(['Surplus Skills', surplus]);
    
    sheet.addRow([]);
    
    // Header row
    const headerRowNum = sheet.rowCount + 1;
    sheet.addRow([
      'Skill',
      'Demand (Jobs)',
      'Supply (Candidates)',
      'Gap',
      'Status'
    ]);
    
    const headerRow = sheet.getRow(headerRowNum);
    headerRow.font = { bold: true };
    headerRow.alignment = { horizontal: 'center' };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' }
    };
    
    // Data rows
    skillsData.forEach(skill => {
      const row = sheet.addRow([
        skill.skill,
        skill.demand,
        skill.supply,
        skill.gap,
        skill.status
      ]);
      
      // Color coding based on status
      const statusCell = row.getCell(5);
      switch(skill.status) {
        case 'Critical Shortage':
          statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFCCCC' } };
          statusCell.font = { color: { argb: 'FF990000' }, bold: true };
          break;
        case 'High Gap':
          statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE5CC' } };
          statusCell.font = { color: { argb: 'FFE66A00' } };
          break;
        case 'Moderate Gap':
          statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFCC' } };
          statusCell.font = { color: { argb: 'FFCC9900' } };
          break;
        case 'Balanced':
          statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFCCFFCC' } };
          statusCell.font = { color: { argb: 'FF006600' } };
          break;
        case 'Surplus':
        case 'High Surplus':
          statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFCCE5FF' } };
          statusCell.font = { color: { argb: 'FF003366' } };
          break;
      }
    });

    // Sheet 2: Top Skills Breakdown
    const breakdownSheet = workbook.addWorksheet('Top Skills Breakdown');
    
    breakdownSheet.mergeCells('A1:D1');
    breakdownSheet.getCell('A1').value = 'Top Skills Breakdown';
    breakdownSheet.getCell('A1').font = { size: 16, bold: true };
    breakdownSheet.addRow([]);
    
    // Top 10 demanded skills
    const topDemanded = [...skillsData]
      .filter(s => s.demand > 0)
      .sort((a, b) => b.demand - a.demand)
      .slice(0, 10);
    
    breakdownSheet.addRow(['Top 10 Most Demanded Skills']);
    breakdownSheet.getRow(breakdownSheet.rowCount).font = { bold: true };
    breakdownSheet.addRow(['Skill', 'Jobs', 'Candidates Available', 'Gap', 'Status']);
    
    topDemanded.forEach(skill => {
      breakdownSheet.addRow([
        skill.skill,
        skill.demand,
        skill.supply,
        skill.gap,
        skill.status
      ]);
    });
    
    breakdownSheet.addRow([]);
    
    // Top 10 surplus skills
    const topSurplus = [...skillsData]
      .filter(s => s.supply > s.demand)
      .sort((a, b) => b.supply - a.supply)
      .slice(0, 10);
    
    breakdownSheet.addRow(['Top 10 Skills with Candidate Surplus']);
    breakdownSheet.getRow(breakdownSheet.rowCount).font = { bold: true };
    breakdownSheet.addRow(['Skill', 'Candidates', 'Job Demand', 'Surplus', 'Source']);
    
    topSurplus.forEach(skill => {
      breakdownSheet.addRow([
        skill.skill,
        skill.supply,
        skill.demand,
        skill.supply - skill.demand,
        skill.source
      ]);
    });
    
    breakdownSheet.addRow([]);
    
    // Critical shortages
    const criticalSkills = skillsData.filter(s => s.status === 'Critical Shortage');
    if (criticalSkills.length > 0) {
      breakdownSheet.addRow(['Critical Shortage Skills (Immediate Action Required)']);
      breakdownSheet.getRow(breakdownSheet.rowCount).font = { bold: true, color: { argb: 'FF990000' } };
      breakdownSheet.addRow(['Skill', 'Job Demand', 'Candidates Available', 'Gap', 'Sample Job Titles']);
      
      criticalSkills.slice(0, 10).forEach(skill => {
        breakdownSheet.addRow([
          skill.skill,
          skill.demand,
          skill.supply,
          skill.gap,
          skill.sampleJobTitles?.join(', ') || 'N/A'
        ]);
      });
    }

    // Styling
    [sheet, breakdownSheet].forEach(s => {
      s.columns = [
        { width: 30 },
        { width: 15 },
        { width: 15 },
        { width: 10 },
        { width: 15 }
      ];
      
      // Add borders to data tables
      const headerRow = s.name === 'Skills Analysis' ? headerRowNum : 3;
      const dataEnd = s.name === 'Skills Analysis' 
        ? skillsData.length + headerRow 
        : (topDemanded.length + topSurplus.length + criticalSkills.length + 15);
      
      for (let i = headerRow; i <= dataEnd; i++) {
        if (s.getRow(i) && s.getRow(i).cellCount > 0) {
          s.getRow(i).eachCell(cell => {
            cell.border = {
              top: { style: 'thin' },
              left: { style: 'thin' },
              bottom: { style: 'thin' },
              right: { style: 'thin' }
            };
          });
        }
      }
    });
    
    // Send file
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=skills-demand-analysis-${monthsNum}-months.xlsx`);
    
    await workbook.xlsx.write(res);
    res.end();
    
  } catch (error) {
    console.error('Error in skills demand report:', error);
    next(error);
  }
};


// Helper: Last month's baseline stats for growth calculation
async function getLastMonthStats(jobFilter, applicationJobMatch, candidateFilter) {
  const lastMonth = new Date();
  lastMonth.setMonth(lastMonth.getMonth() - 1);

  const [
    totalEmployers,
    totalJobs,
    totalApplications,
    totalCandidates,
  ] = await Promise.all([
    User.countDocuments({ role: 'employer', isActive: true, createdAt: { $lt: lastMonth } }),

    JobPost.countDocuments({ createdAt: { $lt: lastMonth }, ...jobFilter }),

    Application.aggregate([
      { $lookup: { from: 'jobposts', localField: 'jobPost', foreignField: '_id', as: 'job' } },
      { $unwind: '$job' },
      { $match: { ...applicationJobMatch, createdAt: { $lt: lastMonth } } },
      { $count: 'total' }
    ]).then(r => r[0]?.total || 0),

    User.countDocuments({ ...candidateFilter, createdAt: { $lt: lastMonth } }),
  ]);

  return { totalEmployers, totalJobs, totalApplications, totalCandidates };
}

function calculateAverageAcceptanceRate(jobs) {
  if (!jobs.length) return 0;
  
  const totalRate = jobs.reduce((sum, job) => sum + job.acceptanceRate, 0);
  return Math.round(totalRate / jobs.length);
}

export default hrAdminDashboardController;
