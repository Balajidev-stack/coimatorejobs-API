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
hrAdminDashboardController.getPendingActions = async (req, res, next) => {
  try {
    // Keep pending actions platform-wide for both HR Admin and Super Admin
    // so both dashboards show the same values.
    const companyMatch = {};
    // 1. Get pending company profile approvals (CompanyProfile model)
    const pendingCompanies = await CompanyProfile.find({
      ...companyMatch,
      status: 'pending',
    })
      .populate('employer', 'name email')
      .select('companyName email phone publicPhone internalPhone landlineNumber phoneNumber hrPhoneNumber status createdAt')
      .sort({ createdAt: -1 })
      .limit(10);

    const pendingCandidateProfiles = await CandidateProfile.find({
      status: 'pending',
      isActive: true,
    })
      .populate('candidate', 'name email status')
      .select('candidate fullName email phone jobTitle status createdAt')
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    const [pendingCompanyCount, pendingCandidateProfileCount] = await Promise.all([
      CompanyProfile.countDocuments({
        ...companyMatch,
        status: 'pending',
      }),
      CandidateProfile.countDocuments({
        status: 'pending',
        isActive: true,
      }),
    ]);

    const pendingCandidates = [
      ...pendingCandidateProfiles.map((profile) => ({
        ...profile,
        approvalType: 'candidate-profile',
        name: profile.fullName || profile.candidate?.name || 'Unknown Candidate',
        email: profile.email || profile.candidate?.email || '',
        subtitle: profile.jobTitle || 'Candidate Profile',
      })),
    ]
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .slice(0, 10);

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
          count: pendingCompanyCount,
          items: pendingCompanies,
        },
        jobs: {
          count: 0,
          items: [],
        },
        employers: {
          count: 0,
          items: [],
        },
        candidates: {   
          count: pendingCandidateProfileCount,
          items: pendingCandidates,
        },
      },
      recentActivities,
      totalPendingActions: pendingCompanyCount + pendingCandidateProfileCount,
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

hrAdminDashboardController.getEmployerActivityReport = async (req, res, next) => {
  try {
    const legacyMonths = req.query.months || 3;
    const rangeInput = req.query.period
      ? req.query
      : { period: `${legacyMonths}months` };
    const { startDate, endDate, label, period, error } = parseCandidateActivityDateRange(rangeInput);

    if (error) {
      return res.status(400).json({ success: false, message: error });
    }

    const dateFilter = { $gte: startDate, $lte: endDate };
    const scopedEmployerCondition = {};
    const scopedUserCondition = {};

    const [
      newEmployers,
      createdCompanyProfiles,
      updatedCompanyProfiles,
      jobPosts,
      expiredJobPosts,
      overallTotals,
    ] = await Promise.all([
      User.find({
        role: 'employer',
        isActive: true,
        $or: [{ isDeleted: false }, { isDeleted: { $exists: false } }],
        createdAt: dateFilter,
        ...scopedUserCondition,
      }).select('name email contactEmail status isActive createdAt').lean(),

      CompanyProfile.find({
        createdAt: dateFilter,
        ...scopedEmployerCondition,
      })
        .populate('employer', 'name email contactEmail status')
        .select('employer companyName email phone companyType industry status isVerified location createdAt')
        .lean(),

      CompanyProfile.find({
        updatedAt: dateFilter,
        ...scopedEmployerCondition,
      })
        .populate('employer', 'name email contactEmail status')
        .select('employer companyName email phone companyType industry status isVerified location createdAt updatedAt')
        .lean(),

      JobPost.find({
        createdAt: dateFilter,
        ...scopedEmployerCondition,
      })
        .populate('employer', 'name email contactEmail')
        .populate('companyProfile', 'companyName')
        .select('employer companyProfile title jobType offeredSalary careerLevel experience industry location status applicationDeadline createdAt applicantCount')
        .lean(),

      JobPost.find({
        applicationDeadline: dateFilter,
        ...scopedEmployerCondition,
      })
        .populate('employer', 'name email contactEmail')
        .populate('companyProfile', 'companyName')
        .select('employer companyProfile title jobType industry location status applicationDeadline createdAt applicantCount')
        .lean(),

      Promise.all([
        JobPost.countDocuments({}),
        User.countDocuments({
          role: 'employer',
          $or: [{ isDeleted: false }, { isDeleted: { $exists: false } }],
        }),
        CompanyProfile.countDocuments({}),
      ]).then(([totalJobs, totalEmployers, totalCompanyProfiles]) => ({
        totalJobs,
        totalEmployers,
        totalCompanyProfiles,
      })),
    ]);

    const jobIds = jobPosts.map((job) => job._id);
    const applicationCounts = jobIds.length
      ? await Application.aggregate([
          { $match: { jobPost: { $in: jobIds }, createdAt: dateFilter } },
          { $group: { _id: '$jobPost', count: { $sum: 1 } } },
        ])
      : [];
    const applicationCountMap = new Map(
      applicationCounts.map((row) => [String(row._id), Number(row.count || 0)])
    );
    const updatedCompanyProfileRows = updatedCompanyProfiles.filter(
      (profile) => profile.updatedAt && String(profile.updatedAt) !== String(profile.createdAt)
    );

    const activeJobPosts = jobPosts.filter(
      (job) => job.status === 'Published' && new Date(job.applicationDeadline) >= new Date()
    );
    const uniqueJobPostingEmployers = new Set(
      jobPosts.map((job) => String(job.employer?._id || job.employer)).filter(Boolean)
    );
    const uniqueCompanyCreatedEmployers = new Set(
      createdCompanyProfiles.map((profile) => String(profile.employer?._id || profile.employer)).filter(Boolean)
    );
    const uniqueCompanyUpdatedEmployers = new Set(
      updatedCompanyProfileRows.map((profile) => String(profile.employer?._id || profile.employer)).filter(Boolean)
    );
    const uniqueExpiredJobEmployers = new Set(
      expiredJobPosts.map((job) => String(job.employer?._id || job.employer)).filter(Boolean)
    );

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'HR Dashboard System';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Employer Activity');
    const addSectionTitle = (title) => {
      sheet.addRow([]);
      const row = sheet.addRow([title]);
      row.font = { bold: true, size: 13 };
      return row;
    };
    const addHeaderRow = (values) => {
      const row = sheet.addRow(values);
      row.font = { bold: true };
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF2FF' } };
      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' },
        };
      });
      return row;
    };
    const addTotalRow = (labelText, value) => {
      const row = sheet.addRow([labelText, value]);
      row.font = { bold: true };
      return row;
    };
    const getEmployerName = (record) => record.employer?.name || record.name || 'N/A';
    const getEmployerEmail = (record) =>
      record.employer?.contactEmail || record.employer?.email || record.contactEmail || record.email || 'N/A';
    const getCompanyName = (record) => record.companyName || record.companyProfile?.companyName || 'N/A';
    const getIndustryName = (record) => {
      if (!record?.industry) return 'N/A';
      if (typeof record.industry === 'string') return record.industry;
      return record.industry?.name || String(record.industry);
    };
    const getLocationLabel = (location) => {
      if (!location) return 'N/A';
      const city = Array.isArray(location.city) ? location.city.join(', ') : location.city;
      return [city, location.state, location.country].filter(Boolean).join(', ') || 'N/A';
    };
    const generatedBy =
      req.user?.role === 'superadmin'
        ? 'Super Admin'
        : req.user?.name || req.user?.email || 'HR Admin';

    sheet.mergeCells('A1:C1');
    sheet.getCell('A1').value = 'Employer Activity Report';
    sheet.getCell('A1').font = { size: 16, bold: true };
    sheet.getCell('A1').alignment = { horizontal: 'center' };
    sheet.addRow(['Period', label]);
    sheet.addRow(['From', formatReportDate(startDate)]);
    sheet.addRow(['To', formatReportDate(endDate)]);
    sheet.addRow([]);

    sheet.addRow(['Overall DB Totals']);
    addHeaderRow(['Metric', 'Total Count']);
    sheet.addRow(['Total Jobs', overallTotals.totalJobs]);
    sheet.addRow(['Total Employers', overallTotals.totalEmployers]);
    sheet.addRow(['Total Company Profiles', overallTotals.totalCompanyProfiles]);
    sheet.addRow([]);

    sheet.addRow(['Activity Summary']);
    addHeaderRow(['Activity', 'Employer Count', 'Total Actions']);
    sheet.addRow(['New Employer Registrations', newEmployers.length, newEmployers.length]);
    sheet.addRow(['Company Profiles Created', uniqueCompanyCreatedEmployers.size, createdCompanyProfiles.length]);
    sheet.addRow(['Company Profiles Updated', uniqueCompanyUpdatedEmployers.size, `${updatedCompanyProfileRows.length} Updates`]);
    sheet.addRow(['Jobs Posted', uniqueJobPostingEmployers.size, `${jobPosts.length} Job Posts`]);
    sheet.addRow(['Expired Job Posts', uniqueExpiredJobEmployers.size, `${expiredJobPosts.length} Expired Jobs`]);

    addSectionTitle('1. New Employer Registrations');
    addHeaderRow(['S.No', 'Employer Name', 'Email', 'Registered Date', 'Account Status']);
    newEmployers.forEach((employer, index) => {
      sheet.addRow([
        index + 1,
        employer.name || 'N/A',
        employer.contactEmail || employer.email || 'N/A',
        formatReportDate(employer.createdAt),
        employer.isActive ? 'Active' : employer.status || 'N/A',
      ]);
    });
    addTotalRow('Total Registrations :', newEmployers.length);

    addSectionTitle('2. Newly Created Company Profiles');
    addHeaderRow(['S.No', 'Employer Name', 'Company Name', 'Email', 'Mobile', 'Industry', 'Location', 'Profile Status', 'Created On']);
    createdCompanyProfiles.forEach((profile, index) => {
      sheet.addRow([
        index + 1,
        getEmployerName(profile),
        profile.companyName || 'N/A',
        profile.email || getEmployerEmail(profile),
        profile.phone || 'N/A',
        getIndustryName(profile),
        getLocationLabel(profile.location),
        profile.status || 'N/A',
        formatReportDate(profile.createdAt),
      ]);
    });
    addTotalRow('Total Company Profiles Created :', createdCompanyProfiles.length);

    addSectionTitle('3. Company Profile Updates');
    addHeaderRow(['S.No', 'Employer Name', 'Company Name', 'Email', 'Updated Fields', 'Updated On']);
    updatedCompanyProfileRows.forEach((profile, index) => {
      sheet.addRow([
        index + 1,
        getEmployerName(profile),
        profile.companyName || 'N/A',
        profile.email || getEmployerEmail(profile),
        'Company Profile Details',
        formatReportDate(profile.updatedAt),
      ]);
    });
    addTotalRow('Total Updated Company Profiles :', updatedCompanyProfileRows.length);

    addSectionTitle('4. Job Posts');
    addHeaderRow(['S.No', 'Employer Name', 'Company', 'Job Title', 'Job Type', 'Industry', 'Location', 'Posted Date', 'Expiry Date', 'Job Status', 'Applications']);
    jobPosts.forEach((job, index) => {
      sheet.addRow([
        index + 1,
        getEmployerName(job),
        getCompanyName(job),
        job.title || 'N/A',
        job.jobType || 'N/A',
        getIndustryName(job),
        getLocationLabel(job.location),
        formatReportDate(job.createdAt),
        formatReportDate(job.applicationDeadline),
        job.status || 'N/A',
        applicationCountMap.get(String(job._id)) || 0,
      ]);
    });
    addTotalRow('Total Employers Posted Jobs :', uniqueJobPostingEmployers.size);
    addTotalRow('Total Job Posts :', jobPosts.length);
    addTotalRow('Currently Active Jobs :', activeJobPosts.length);

    addSectionTitle('5. Expired Job Posts');
    addHeaderRow(['S.No', 'Employer Name', 'Company', 'Job Title', 'Job Type', 'Industry', 'Location', 'Posted Date', 'Expired On', 'Job Status']);
    expiredJobPosts.forEach((job, index) => {
      sheet.addRow([
        index + 1,
        getEmployerName(job),
        getCompanyName(job),
        job.title || 'N/A',
        job.jobType || 'N/A',
        getIndustryName(job),
        getLocationLabel(job.location),
        formatReportDate(job.createdAt),
        formatReportDate(job.applicationDeadline),
        job.status || 'N/A',
      ]);
    });
    addTotalRow('Total Expired Job Posts :', expiredJobPosts.length);

    addSectionTitle('Report Footer');
    sheet.addRow(['Generated By', generatedBy]);
    sheet.addRow(['Generated On', formatReportDate(new Date())]);

    sheet.columns = [
      { width: 12 },
      { width: 28 },
      { width: 30 },
      { width: 30 },
      { width: 20 },
      { width: 24 },
      { width: 28 },
      { width: 24 },
      { width: 24 },
      { width: 18 },
      { width: 16 },
    ];
    sheet.views = [{ state: 'frozen', ySplit: 7 }];

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const filenameSuffix =
      period === 'custom'
        ? `${req.query.fromDate}-to-${req.query.toDate}`
        : period;

    res.setHeader('Content-Disposition', `attachment; filename=employer-activity-${filenameSuffix}.xlsx`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    next(error);
  }
};

const IST_OFFSET_MINUTES = 330;

const getIstDateParts = (value = new Date()) => {
  const istDate = new Date(value.getTime() + IST_OFFSET_MINUTES * 60 * 1000);
  return {
    year: istDate.getUTCFullYear(),
    month: istDate.getUTCMonth(),
    day: istDate.getUTCDate(),
  };
};

const createIstBoundaryDate = (year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0) =>
  new Date(Date.UTC(year, month, day, hour, minute, second, millisecond) - IST_OFFSET_MINUTES * 60 * 1000);

const parseDateInputParts = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]) - 1,
    day: Number(match[3]),
  };
};

const parseCandidateActivityDateRange = ({ period = 'monthly', fromDate, toDate }) => {
  const now = new Date();
  const istNow = getIstDateParts(now);
  let startDate = new Date(now);
  let endDate = new Date(now);
  let label = 'Current month';
  const normalizedPeriod = String(period || 'monthly').toLowerCase();

  if (normalizedPeriod === 'all') {
    startDate = new Date(0);
    endDate = createIstBoundaryDate(istNow.year, istNow.month, istNow.day, 23, 59, 59, 999);
    label = 'All time';
  } else if (normalizedPeriod === 'daily') {
    startDate = createIstBoundaryDate(istNow.year, istNow.month, istNow.day);
    endDate = createIstBoundaryDate(istNow.year, istNow.month, istNow.day, 23, 59, 59, 999);
    label = 'Today';
  } else if (normalizedPeriod === 'monthly') {
    startDate = createIstBoundaryDate(istNow.year, istNow.month, 1);
    endDate = createIstBoundaryDate(istNow.year, istNow.month + 1, 0, 23, 59, 59, 999);
    label = 'Current month';
  } else if (['3months', '6months', '12months'].includes(normalizedPeriod)) {
    const months = Number(normalizedPeriod.replace('months', ''));
    startDate = createIstBoundaryDate(istNow.year, istNow.month - months, istNow.day);
    endDate = createIstBoundaryDate(istNow.year, istNow.month, istNow.day, 23, 59, 59, 999);
    label = `Last ${months} months`;
  } else if (normalizedPeriod === 'custom') {
    const fromParts = parseDateInputParts(fromDate);
    const toParts = parseDateInputParts(toDate);
    if (!fromParts || !toParts) {
      return { error: 'fromDate and toDate are required for custom period' };
    }

    startDate = createIstBoundaryDate(fromParts.year, fromParts.month, fromParts.day);
    endDate = createIstBoundaryDate(toParts.year, toParts.month, toParts.day, 23, 59, 59, 999);
    label = `${fromDate} to ${toDate}`;
  } else {
    return { error: 'Invalid period. Use all, daily, monthly, 3months, 6months, 12months, or custom' };
  }

  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return { error: 'Invalid date format. Use YYYY-MM-DD' };
  }

  if (startDate > endDate) {
    return { error: 'fromDate cannot be after toDate' };
  }

  return { startDate, endDate, label, period: normalizedPeriod };
};

const formatReportDate = (value) => {
  if (!value) return 'N/A';
  return new Date(value).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

/**
 * HIRING ACTIVITIES REPORT
 * @route GET /api/v1/hr-admin-dashboard/reports/hiring-activities
 */
hrAdminDashboardController.getHiringActivitiesReport = async (req, res, next) => {
  try {
    const { startDate, endDate, label, period, error } = parseCandidateActivityDateRange(req.query);

    if (error) {
      return res.status(400).json({ success: false, message: error });
    }

    const dateFilter = { $gte: startDate, $lte: endDate };
    const scopedJobCondition = {};

    const jobs = await JobPost.find({
      ...scopedJobCondition,
      $or: [
        { createdAt: dateFilter },
        { updatedAt: dateFilter },
      ],
    })
      .populate('employer', 'name email contactEmail')
      .populate('companyProfile', 'companyName')
      .select('employer companyProfile title status applicationDeadline createdAt updatedAt applicantCount')
      .lean();

    const jobIdsFromPeriod = jobs.map((job) => job._id);
    const applicationJobIds = await Application.distinct('jobPost', { createdAt: dateFilter });
    const scopedApplicationJobIds = applicationJobIds.length
      ? await JobPost.find({
          _id: { $in: applicationJobIds },
          ...scopedJobCondition,
        }).distinct('_id')
      : [];

    const allJobIds = [
      ...new Set([
        ...jobIdsFromPeriod.map((id) => String(id)),
        ...scopedApplicationJobIds.map((id) => String(id)),
      ]),
    ].map((id) => new mongoose.Types.ObjectId(id));

    const reportJobs = allJobIds.length
      ? await JobPost.find({ _id: { $in: allJobIds }, ...scopedJobCondition })
          .populate('employer', 'name email contactEmail')
          .populate('companyProfile', 'companyName')
          .select('employer companyProfile title status applicationDeadline createdAt updatedAt applicantCount')
          .lean()
      : [];

    const applicationStats = allJobIds.length
      ? await Application.aggregate([
          {
            $match: {
              jobPost: { $in: allJobIds },
              createdAt: dateFilter,
            },
          },
          {
            $group: {
              _id: '$jobPost',
              applied: { $sum: 1 },
              selected: { $sum: { $cond: [{ $eq: ['$status', 'Accepted'] }, 1, 0] } },
              rejected: { $sum: { $cond: [{ $eq: ['$status', 'Rejected'] }, 1, 0] } },
              shortlisted: { $sum: { $cond: [{ $eq: ['$shortlisted', true] }, 1, 0] } },
              placed: {
                $sum: {
                  $cond: [{ $eq: ['$candidateJoinConfirmation', 'confirmed'] }, 1, 0],
                },
              },
            },
          },
        ])
      : [];

    const statsMap = new Map(
      applicationStats.map((row) => [
        String(row._id),
        {
          applied: Number(row.applied || 0),
          selected: Number(row.selected || 0),
          rejected: Number(row.rejected || 0),
          shortlisted: Number(row.shortlisted || 0),
          placed: Number(row.placed || 0),
        },
      ])
    );

    const getEmployerName = (job) => job.employer?.name || 'N/A';
    const getEmployerEmail = (job) => job.employer?.contactEmail || job.employer?.email || 'N/A';
    const getCompanyName = (job) => job.companyProfile?.companyName || 'N/A';
    const getJobStatus = (job) => {
      if (job.status === 'Closed') return 'Closed';
      if (job.applicationDeadline && new Date(job.applicationDeadline) < new Date()) return 'Expired';
      if (job.status === 'Published') return 'Open';
      return job.status || 'N/A';
    };

    const rows = reportJobs
      .map((job) => ({
        job,
        stats: statsMap.get(String(job._id)) || {
          applied: 0,
          selected: 0,
          rejected: 0,
          shortlisted: 0,
          placed: 0,
        },
      }))
      .sort((a, b) => b.stats.applied - a.stats.applied || new Date(b.job.createdAt) - new Date(a.job.createdAt));

    const applicationDetails = allJobIds.length
      ? await Application.find({
          jobPost: { $in: allJobIds },
          createdAt: dateFilter,
        })
          .populate('candidate', 'name email')
          .populate('candidateProfile', 'fullName email phone jobTitle experience location')
          .populate({
            path: 'jobPost',
            select: 'title companyProfile employer status applicationDeadline createdAt',
            populate: [
              { path: 'companyProfile', select: 'companyName' },
              { path: 'employer', select: 'name email contactEmail' },
            ],
          })
          .select('candidate candidateProfile jobPost status shortlisted candidateJoinConfirmation candidateJoinConfirmedAt selectedAt createdAt updatedAt')
          .lean()
      : [];

    const candidateDetailRows = applicationDetails
      .filter((application) => application.jobPost)
      .map((application) => {
        const job = application.jobPost;
        return {
          application,
          job,
          jobTitle: job.title || 'N/A',
          companyName: job.companyProfile?.companyName || 'N/A',
          employerName: job.employer?.name || 'N/A',
          employerEmail: job.employer?.contactEmail || job.employer?.email || 'N/A',
          candidateName:
            application.candidateProfile?.fullName ||
            application.candidate?.name ||
            'N/A',
          candidateEmail:
            application.candidateProfile?.email ||
            application.candidate?.email ||
            'N/A',
          candidatePhone: application.candidateProfile?.phone || 'N/A',
          candidateJobTitle: application.candidateProfile?.jobTitle || 'N/A',
          candidateExperience: application.candidateProfile?.experience || 'N/A',
          status: application.status || 'N/A',
          selected: application.status === 'Accepted' ? 'Yes' : 'No',
          rejected: application.status === 'Rejected' ? 'Yes' : 'No',
          shortlisted: application.shortlisted ? 'Yes' : 'No',
          placed: application.candidateJoinConfirmation === 'confirmed' ? 'Yes' : 'No',
        };
      })
      .sort((a, b) =>
        String(a.jobTitle).localeCompare(String(b.jobTitle)) ||
        new Date(b.application.createdAt) - new Date(a.application.createdAt)
      );

    const totals = rows.reduce(
      (acc, row) => {
        acc.applied += row.stats.applied;
        acc.selected += row.stats.selected;
        acc.rejected += row.stats.rejected;
        acc.shortlisted += row.stats.shortlisted;
        acc.placed += row.stats.placed;
        return acc;
      },
      { applied: 0, selected: 0, rejected: 0, shortlisted: 0, placed: 0 }
    );

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'HR Dashboard System';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Hiring Activities');
    const addHeaderRow = (values) => {
      const row = sheet.addRow(values);
      row.font = { bold: true };
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF2FF' } };
      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' },
        };
      });
      return row;
    };

    const generatedBy =
      user?.role === 'superadmin'
        ? 'Super Admin'
        : user?.name || user?.email || 'HR Admin';

    sheet.mergeCells('A1:K1');
    sheet.getCell('A1').value = 'Hiring Activities Report';
    sheet.getCell('A1').font = { size: 16, bold: true };
    sheet.getCell('A1').alignment = { horizontal: 'center' };
    sheet.addRow(['Period', label]);
    sheet.addRow(['From', formatReportDate(startDate)]);
    sheet.addRow(['To', formatReportDate(endDate)]);
    sheet.addRow(['Generated By', generatedBy]);
    sheet.addRow(['Generated On', formatReportDate(new Date())]);
    sheet.addRow([]);

    sheet.addRow(['Summary']);
    addHeaderRow(['Jobs', 'Applied Candidates', 'Selected', 'Rejected', 'Shortlisted', 'Placed']);
    sheet.addRow([rows.length, totals.applied, totals.selected, totals.rejected, totals.shortlisted, totals.placed]);
    sheet.addRow([]);

    addHeaderRow([
      'S.No',
      'Job Title',
      'Company',
      'Employer',
      'Employer Email',
      'Job Status',
      'Posted Date',
      'Expiry Date',
      'Applied Candidates',
      'Selected',
      'Rejected',
      'Shortlisted',
      'Placed',
    ]);

    rows.forEach(({ job, stats }, index) => {
      sheet.addRow([
        index + 1,
        job.title || 'N/A',
        getCompanyName(job),
        getEmployerName(job),
        getEmployerEmail(job),
        getJobStatus(job),
        formatReportDate(job.createdAt),
        formatReportDate(job.applicationDeadline),
        stats.applied,
        stats.selected,
        stats.rejected,
        stats.shortlisted,
        stats.placed,
      ]);
    });

    sheet.columns = [
      { width: 10 },
      { width: 34 },
      { width: 28 },
      { width: 28 },
      { width: 32 },
      { width: 16 },
      { width: 22 },
      { width: 22 },
      { width: 20 },
      { width: 14 },
      { width: 14 },
      { width: 16 },
      { width: 12 },
    ];
    sheet.views = [{ state: 'frozen', ySplit: 12 }];

    const detailSheet = workbook.addWorksheet('Candidate Details');
    const addDetailHeaderRow = (values) => {
      const row = detailSheet.addRow(values);
      row.font = { bold: true };
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF2FF' } };
      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' },
        };
      });
      return row;
    };

    detailSheet.mergeCells('A1:Q1');
    detailSheet.getCell('A1').value = 'Hiring Activities - Candidate Details';
    detailSheet.getCell('A1').font = { size: 16, bold: true };
    detailSheet.getCell('A1').alignment = { horizontal: 'center' };
    detailSheet.addRow(['Period', label]);
    detailSheet.addRow(['From', formatReportDate(startDate)]);
    detailSheet.addRow(['To', formatReportDate(endDate)]);
    detailSheet.addRow([]);

    addDetailHeaderRow([
      'S.No',
      'Job Title',
      'Company',
      'Employer',
      'Employer Email',
      'Candidate Name',
      'Candidate Email',
      'Candidate Phone',
      'Candidate Current Role',
      'Experience',
      'Applied Date',
      'Application Status',
      'Selected',
      'Rejected',
      'Shortlisted',
      'Placed',
      'Joining Confirmed On',
    ]);

    candidateDetailRows.forEach((row, index) => {
      detailSheet.addRow([
        index + 1,
        row.jobTitle,
        row.companyName,
        row.employerName,
        row.employerEmail,
        row.candidateName,
        row.candidateEmail,
        row.candidatePhone,
        row.candidateJobTitle,
        row.candidateExperience,
        formatReportDate(row.application.createdAt),
        row.status,
        row.selected,
        row.rejected,
        row.shortlisted,
        row.placed,
        row.application.candidateJoinConfirmedAt
          ? formatReportDate(row.application.candidateJoinConfirmedAt)
          : 'N/A',
      ]);
    });

    detailSheet.columns = [
      { width: 10 },
      { width: 34 },
      { width: 28 },
      { width: 28 },
      { width: 32 },
      { width: 28 },
      { width: 32 },
      { width: 18 },
      { width: 26 },
      { width: 18 },
      { width: 22 },
      { width: 18 },
      { width: 12 },
      { width: 12 },
      { width: 14 },
      { width: 12 },
      { width: 24 },
    ];
    detailSheet.views = [{ state: 'frozen', ySplit: 6 }];

    const filenameSuffix =
      period === 'custom'
        ? `${req.query.fromDate}-to-${req.query.toDate}`
        : period;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=hiring-activities-${filenameSuffix}.xlsx`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    next(error);
  }
};

/**
 * CANDIDATE ACTIVITY REPORT
 * @route GET /api/v1/hr-admin-dashboard/reports/candidate-activity
 */
hrAdminDashboardController.getCandidateActivityReport = async (req, res, next) => {
  try {
    const { startDate, endDate, label, period, error } = parseCandidateActivityDateRange(req.query);

    if (error) {
      return res.status(400).json({ success: false, message: error });
    }

    const dateFilter = { $gte: startDate, $lte: endDate };
    const [
      newCandidates,
      createdProfiles,
      updatedProfiles,
      applications,
      statusChangedApplications,
    ] = await Promise.all([
      User.find({
        role: 'candidate',
        createdAt: dateFilter,
      }).select('name email status isActive createdAt').lean(),

      CandidateProfile.find({
        createdAt: dateFilter,
      })
        .populate('candidate', 'name email status')
        .populate('industry', 'name')
        .populate('functionalAreas', 'name')
        .populate('role', 'name')
        .select('candidate fullName email phone jobTitle status resume experience location industry functionalAreas role createdAt')
        .lean(),

      CandidateProfile.find({
        updatedAt: dateFilter,
      })
        .populate('candidate', 'name email status')
        .select('candidate fullName email phone jobTitle status resume experience location createdAt updatedAt')
        .lean(),

      Application.find({
        createdAt: dateFilter,
      })
        .populate('candidate', 'name email')
        .populate('candidateProfile', 'fullName email')
        .populate({
          path: 'jobPost',
          select: 'title companyProfile',
          populate: { path: 'companyProfile', select: 'companyName' },
        })
        .select('candidate candidateProfile jobPost status createdAt')
        .lean(),

      Application.find({
        status: { $ne: 'Pending' },
        updatedAt: dateFilter,
      })
        .populate('candidate', 'name email')
        .populate('candidateProfile', 'fullName email')
        .populate({
          path: 'jobPost',
          select: 'title companyProfile',
          populate: { path: 'companyProfile', select: 'companyName' },
        })
        .select('candidate candidateProfile jobPost status updatedAt')
        .lean(),
    ]);
    const updatedProfileRows = updatedProfiles.filter(
      (profile) => profile.updatedAt && String(profile.updatedAt) !== String(profile.createdAt)
    );

    const registrationProfileMap = new Map(
      (
        await CandidateProfile.find({
          candidate: { $in: newCandidates.map((candidate) => candidate._id) },
        })
          .select('candidate phone')
          .lean()
      ).map((profile) => [String(profile.candidate), profile])
    );

    const uniqueAppliedCandidates = new Set(
      applications.map((application) => String(application.candidate?._id || application.candidate)).filter(Boolean)
    );
    const uniqueStatusChangedCandidates = new Set(
      statusChangedApplications.map((application) => String(application.candidate?._id || application.candidate)).filter(Boolean)
    );

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'HR Dashboard System';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Candidate Activity');
    const addSectionTitle = (title) => {
      sheet.addRow([]);
      const row = sheet.addRow([title]);
      row.font = { bold: true, size: 13 };
      return row;
    };
    const addHeaderRow = (values) => {
      const row = sheet.addRow(values);
      row.font = { bold: true };
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF2FF' } };
      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' },
        };
      });
      return row;
    };
    const addTotalRow = (labelText, value) => {
      const row = sheet.addRow([labelText, value]);
      row.font = { bold: true };
      return row;
    };
    const calculateProfileCompletion = (profile) => {
      const checks = [
        profile?.fullName,
        profile?.email,
        profile?.phone,
        profile?.jobTitle,
        profile?.resume,
        profile?.experience,
        profile?.location?.city,
      ];
      const completed = checks.filter(Boolean).length;
      return `${Math.round((completed / checks.length) * 100)}%`;
    };
    const getFieldName = (value) => {
      if (!value) return '';
      if (typeof value === 'string') return value;
      return value.name || '';
    };
    const getFunctionalAreaNames = (profile) => {
      const areas = Array.isArray(profile?.functionalAreas) ? profile.functionalAreas : [];
      const names = areas.map(getFieldName).filter(Boolean);
      return names.length ? names.join(', ') : 'N/A';
    };
    const getCompanyName = (application) => application.jobPost?.companyProfile?.companyName || 'N/A';

    const generatedBy =
      req.user?.role === 'superadmin'
        ? 'Super Admin'
        : req.user?.name || req.user?.email || 'HR Admin';

    sheet.mergeCells('A1:K1');
    sheet.getCell('A1').value = 'Candidate Activity Report';
    sheet.getCell('A1').font = { size: 16, bold: true };
    sheet.getCell('A1').alignment = { horizontal: 'center' };
    sheet.addRow(['Period', label]);
    sheet.addRow(['From', formatReportDate(startDate)]);
    sheet.addRow(['To', formatReportDate(endDate)]);
    sheet.addRow([]);

    sheet.addRow(['Activity Summary']);
    addHeaderRow(['Activity', 'Candidate Count', 'Total Actions']);
    sheet.addRow(['New Candidate Registrations', newCandidates.length, newCandidates.length]);
    sheet.addRow(['Candidate Profiles Created', createdProfiles.length, createdProfiles.length]);
    sheet.addRow(['Candidate Profiles Updated', updatedProfileRows.length, `${updatedProfileRows.length} Updates`]);
    sheet.addRow(['Candidates Applied to Jobs', uniqueAppliedCandidates.size, `${applications.length} Applications`]);
    sheet.addRow(['Application Status Changed', uniqueStatusChangedCandidates.size, `${statusChangedApplications.length} Status Changes`]);

    addSectionTitle('1. New Candidate Registrations');
    addHeaderRow(['S.No', 'Candidate Name', 'Email', 'Mobile', 'Registered Date', 'Login Method', 'Status']);
    newCandidates.forEach((candidate, index) => {
      const profile = registrationProfileMap.get(String(candidate._id));
      sheet.addRow([
        index + 1,
        candidate.name || 'N/A',
        candidate.email || 'N/A',
        profile?.phone || 'N/A',
        formatReportDate(candidate.createdAt),
        'Email',
        candidate.isActive ? 'Active' : candidate.status || 'N/A',
      ]);
    });
    addTotalRow('Total Registrations :', newCandidates.length);

    addSectionTitle('2. Newly Created Candidate Profiles');
    addHeaderRow(['S.No', 'Candidate Name', 'Email', 'Industry', 'Functional Area', 'Primary Role', 'Profile Completion', 'Resume Uploaded', 'Experience', 'Preferred Location', 'Created On']);
    createdProfiles.forEach((profile, index) => {
      sheet.addRow([
        index + 1,
        profile.fullName || profile.candidate?.name || 'N/A',
        profile.email || profile.candidate?.email || 'N/A',
        getFieldName(profile.industry) || 'N/A',
        getFunctionalAreaNames(profile),
        getFieldName(profile.role) || profile.jobTitle || 'N/A',
        calculateProfileCompletion(profile),
        profile.resume ? 'Yes' : 'No',
        profile.experience || 'N/A',
        profile.location?.city || 'N/A',
        formatReportDate(profile.createdAt),
      ]);
    });
    addTotalRow('Total Profiles Created :', createdProfiles.length);

    addSectionTitle('3. Candidate Profile Updates');
    addHeaderRow(['S.No', 'Candidate Name', 'Email', 'Updated Fields', 'Updated On']);
    updatedProfileRows.forEach((profile, index) => {
      sheet.addRow([
        index + 1,
        profile.fullName || profile.candidate?.name || 'N/A',
        profile.email || profile.candidate?.email || 'N/A',
        'Profile Details',
        formatReportDate(profile.updatedAt),
      ]);
    });
    addTotalRow('Total Updated Profiles :', updatedProfileRows.length);

    addSectionTitle('4. Job Applications');
    addHeaderRow(['S.No', 'Candidate Name', 'Email', 'Job Title', 'Company', 'Applied Date', 'Application Status']);
    applications.forEach((application, index) => {
      sheet.addRow([
        index + 1,
        application.candidateProfile?.fullName || application.candidate?.name || 'N/A',
        application.candidateProfile?.email || application.candidate?.email || 'N/A',
        application.jobPost?.title || 'N/A',
        getCompanyName(application),
        formatReportDate(application.createdAt),
        application.status || 'N/A',
      ]);
    });
    addTotalRow('Total Candidates Applied :', uniqueAppliedCandidates.size);
    addTotalRow('Total Applications :', applications.length);

    addSectionTitle('5. Application Status Changes');
    addHeaderRow(['S.No', 'Candidate Name', 'Email', 'Job Title', 'Company', 'Previous Status', 'Current Status', 'Changed On']);
    statusChangedApplications.forEach((application, index) => {
      sheet.addRow([
        index + 1,
        application.candidateProfile?.fullName || application.candidate?.name || 'N/A',
        application.candidateProfile?.email || application.candidate?.email || 'N/A',
        application.jobPost?.title || 'N/A',
        getCompanyName(application),
        'N/A',
        application.status || 'N/A',
        formatReportDate(application.updatedAt),
      ]);
    });
    addTotalRow('Total Status Changes :', statusChangedApplications.length);

    addSectionTitle('Report Footer');
    sheet.addRow(['Generated By', generatedBy]);
    sheet.addRow(['Generated On', formatReportDate(new Date())]);

    sheet.columns = [
      { width: 12 },
      { width: 28 },
      { width: 32 },
      { width: 28 },
      { width: 32 },
      { width: 28 },
      { width: 20 },
      { width: 28 },
      { width: 20 },
      { width: 22 },
      { width: 22 },
    ];
    sheet.views = [{ state: 'frozen', ySplit: 7 }];

    const filenameSuffix =
      period === 'custom'
        ? `${req.query.fromDate}-to-${req.query.toDate}`
        : period;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=candidate-activity-${filenameSuffix}.xlsx`);
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
    const { months = 6 } = req.query;
    const normalizedMonths = String(months || 6).toLowerCase();
    const isAllTime = normalizedMonths === 'all';
    const monthsNum = isAllTime ? null : parseInt(months, 10);

    if (!isAllTime && (isNaN(monthsNum) || monthsNum < 1 || monthsNum > 24)) {
      return res.status(400).json({ success: false, message: 'Invalid months value' });
    }
    
    const now = new Date();
    const istNow = getIstDateParts(now);
    const startDate = isAllTime
      ? new Date(0)
      : createIstBoundaryDate(istNow.year, istNow.month - monthsNum, istNow.day);
    const endDate = createIstBoundaryDate(istNow.year, istNow.month, istNow.day, 23, 59, 59, 999);
    const dateFilter = { $gte: startDate, $lte: endDate };
    const reportRangeLabel = isAllTime
      ? 'All time'
      : `Last ${monthsNum} months (${startDate.toLocaleDateString('en-IN')} - ${endDate.toLocaleDateString('en-IN')})`;
    
    // Role-based filter for jobs
    const jobFilter = {};

    console.log("Fetching skills data for", isAllTime ? "all time" : `last ${monthsNum} months`, "...");

    // GET SKILLS DEMAND (FROM JOBS - specialisms)
    const jobSkills = await JobPost.aggregate([
      {
        $match: {
          ...jobFilter,
          createdAt: dateFilter,
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
      { $sort: { demandCount: -1 } }
    ]);

    console.log("Skills from job specialisms:", jobSkills.length);

    // GET SKILLS SUPPLY (FROM CANDIDATE RESUME - skills field)
    const candidateResumeSkills = await CandidateResume.aggregate([
      {
        $match: {
          createdAt: dateFilter,
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
      { $sort: { supplyCount: -1 } }
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
      });

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
    sheet.getCell('A2').value = reportRangeLabel;
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
    const filenameSuffix = isAllTime ? 'all' : `${monthsNum}-months`;
    res.setHeader('Content-Disposition', `attachment; filename=skills-demand-analysis-${filenameSuffix}.xlsx`);
    
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
