import JobPost from '../models/jobs.model.js';
import Application from '../models/jobApply.model.js';
import CompanyProfile from "../models/companyProfile.model.js";
import CandidateProfile from '../models/candidateProfile.model.js';
import User from '../models/user.model.js';
import mongoose from 'mongoose';
import { getEffectiveEmployerId } from '../utils/roleHelper.js';

const dashboardController = {};

/**
 * Get aggregated dashboard statistics for employer
 * @route GET /api/v1/employer-dashboard/stats
 * @access Private (Employer)
 */
dashboardController.getDashboardStats = async (req, res, next) => {
  try {
    const employerId = getEffectiveEmployerId(req.user);
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const startOfLastMonth = new Date(startOfMonth);
    startOfLastMonth.setMonth(startOfLastMonth.getMonth() - 1);

    // Get all employer's jobs
    const employerJobs = await JobPost.find({ employer: employerId }).select('_id');

    if (!employerJobs.length) {
      return res.status(200).json({
        success: true,
        stats: {
          totalJobs: 0,
          activeJobs: 0,
          totalApplications: 0,
          thisMonthApplications: 0,
          pendingApplications: 0,
          shortlistedCount: 0,
          totalMessages: 0,
          unreadMessages: 0,
          profileViews: 0,
          conversionRate: 0,
          applicationGrowth: 0,
        },
      });
    }

    const jobIds = employerJobs.map(job => job._id);

    // Aggregate statistics
    const [
      totalJobs,
      activeJobs,
      totalApplications,
      thisMonthApplications,
      pendingApplications,
      shortlistedCount,
      applicationStats,
    ] = await Promise.all([
      // Total jobs count
      JobPost.countDocuments({ employer: employerId }),

      // Active jobs (not expired)
      JobPost.countDocuments({
        employer: employerId,
        applicationDeadline: { $gte: new Date() },
      }),

      // Total applications
      Application.countDocuments({ jobPost: { $in: jobIds } }),

      // This month applications
      Application.countDocuments({
        jobPost: { $in: jobIds },
        createdAt: { $gte: startOfMonth },
      }),

      // Pending applications
      Application.countDocuments({
        jobPost: { $in: jobIds },
        status: 'Pending',
      }),

      // Shortlisted count
      Application.countDocuments({
        jobPost: { $in: jobIds },
        shortlisted: true,
      }),

      // Last month applications for growth calculation
      Application.countDocuments({
        jobPost: { $in: jobIds },
        createdAt: { $gte: startOfLastMonth, $lt: startOfMonth },
      }),
    ]);

    //    console.log("testtttttt", activeJobs);

    // Get company profile views 
    const companyProfile = await CompanyProfile.findOne({ employer: employerId });
    const profileViews = companyProfile?.profileViews || 0;

    // Calculate growth percentage
    const lastMonthApplications = applicationStats;
    const applicationGrowth = lastMonthApplications > 0 
      ? Math.round(((thisMonthApplications - lastMonthApplications) / lastMonthApplications) * 100)
      : thisMonthApplications > 0 ? 100 : 0;

    // Calculate conversion rate (applications to shortlisted)
    const conversionRate = totalApplications > 0 
      ? Math.round((shortlistedCount / totalApplications) * 100)
      : 0;

    const stats = {
      totalJobs,
      activeJobs,
      totalApplications,
      thisMonthApplications,
      pendingApplications,
      shortlistedCount,
      totalMessages: 0, // You'll need a messages count API
    //   unreadMessages,
      profileViews,
    //   uniqueViewers: companyProfile.uniqueViewers?.length || 0,
    //   recentViews: viewsData.recentViews,
      conversionRate,
      applicationGrowth,
      lastUpdated: new Date(),
    };

    return res.status(200).json({
      success: true,
      stats,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get profile views data for chart
 * @route GET /api/v1/employer-dashboard/profile-views
 * @access Private (Employer)
 */
dashboardController.getProfileViewsData = async (req, res, next) => {
  try {
    const employerId = getEffectiveEmployerId(req.user);
    const { range = '6' } = req.query;
    const monthsBack = parseInt(range, 10);

    const companyProfile = await CompanyProfile.findOne({ employer: employerId });
    if (!companyProfile) {
      return res.status(200).json({ success: true, monthlyData: [] });
    }

    // Generate last N months labels
    const views = [];
    const now = new Date();

    for (let i = monthsBack - 1; i >= 0; i--) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const key = `${year}-${month}`;
      const monthName = date.toLocaleString('default', { month: 'long' });

      // Aggregate ALL days of the month
      const monthEntries = companyProfile.dailyViews.filter(d =>
        d.date.startsWith(key)
      );

      const totalViews = monthEntries.reduce((sum, d) => sum + (d.count || 0), 0);
      const uniqueViews = monthEntries.reduce((sum, d) => sum + (d.unique || 0), 0);

      views.push({
        month: monthName,
        year,
        totalViews,
        uniqueViews
      });
    }

    return res.status(200).json({
      success: true,
      totalViews: companyProfile.profileViews || 0,
      uniqueViewers: companyProfile.uniqueViewers?.length || 0,
      monthlyData: views.reverse() // DESC (latest first)
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get recent activities for dashboard
 * @route GET /api/v1/employer-dashboard/recent-activities
 * @access Private (Employer)
 */
dashboardController.getRecentActivity = async (req, res, next) => {
  try {
    const employerId = getEffectiveEmployerId(req.user);
    const limit = parseInt(req.query.limit) || 10;

    const employerJobs = await JobPost.find({ employer: employerId }).select('_id title');

    const jobIds = employerJobs.map(j => j._id);

    // Fetch recent applications
    const recentApps = await Application.find({ jobPost: { $in: jobIds } })
      .populate('candidate', 'name email')
      .populate('jobPost', 'title')
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('candidate jobPost createdAt status');

    // console.log("test-activity", recentApps);
    

    const activities = recentApps.map(app => ({
      type: 'application',
      message: `${app.candidate?.name || 'A candidate'} applied for ${app.jobPost?.title}`,
      time: app.createdAt,
      status: app.status
    }));

    // @toDo: we can merge other activities (messages, job posts, etc.) here

    return res.status(200).json({
      success: true,
      activities
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get message statistics
 * @route GET /api/v1/employer-dashboard/message-stats
 * @access Private (Employer)
 */
// dashboardController.getMessageStats = async (req, res, next) => {
//   try {
//     const employerId = req.user.id;

//     // Get total messages count
//     const totalMessages = await Message.countDocuments({
//       $or: [
//         { sender: employerId },
//         { receiver: employerId },
//       ],
//     });

//     // Get unread messages count
//     const unreadMessages = await Message.countDocuments({
//       receiver: employerId,
//       read: false,
//     });

//     // Get recent conversations
//     const recentConversations = await Message.aggregate([
//       {
//         $match: {
//           $or: [
//             { sender: new mongoose.Types.ObjectId(employerId) },
//             { receiver: new mongoose.Types.ObjectId(employerId) },
//           ],
//         },
//       },
//       {
//         $sort: { createdAt: -1 },
//       },
//       {
//         $group: {
//           _id: {
//             $cond: [
//               { $eq: ['$sender', new mongoose.Types.ObjectId(employerId)] },
//               '$receiver',
//               '$sender',
//             ],
//           },
//           lastMessage: { $first: '$$ROOT' },
//           unreadCount: {
//             $sum: {
//               $cond: [
//                 { 
//                   $and: [
//                     { $eq: ['$receiver', new mongoose.Types.ObjectId(employerId)] },
//                     { $eq: ['$read', false] },
//                   ],
//                 },
//                 1,
//                 0,
//               ],
//             },
//           },
//         },
//       },
//       {
//         $lookup: {
//           from: 'users',
//           localField: '_id',
//           foreignField: '_id',
//           as: 'user',
//         },
//       },
//       {
//         $unwind: '$user',
//       },
//       {
//         $project: {
//           userId: '$_id',
//           userName: '$user.name',
//           userAvatar: '$user.profilePhoto',
//           lastMessage: '$lastMessage.message',
//           lastMessageTime: '$lastMessage.createdAt',
//           unreadCount: 1,
//         },
//       },
//       {
//         $limit: 5,
//       },
//     ]);

//     return res.status(200).json({
//       success: true,
//       stats: {
//         totalMessages,
//         unreadMessages,
//         recentConversations,
//       },
//     });
//   } catch (error) {
//     next(error);
//   }
// };

/**
 * Get application trends for chart
 * @route GET /api/v1/employer-dashboard/application-trends
 * @access Private (Employer)
 */
dashboardController.getApplicationTrends = async (req, res, next) => {
  try {
    const employerId = getEffectiveEmployerId(req.user);
    const { period = 'monthly' } = req.query; // daily, weekly, monthly

    const employerJobs = await JobPost.find({ employer: employerId }).select('_id');
    const jobIds = employerJobs.map(job => job._id);

    let groupByFormat;
    let dateFormat;
    let matchDate;

    const now = new Date();
    const startDate = new Date();

    switch (period) {
      case 'daily':
        startDate.setDate(startDate.getDate() - 30); // Last 30 days
        groupByFormat = {
          year: { $year: '$createdAt' },
          month: { $month: '$createdAt' },
          day: { $dayOfMonth: '$createdAt' },
        };
        dateFormat = '%Y-%m-%d';
        break;
      case 'weekly':
        startDate.setDate(startDate.getDate() - 12 * 7); // Last 12 weeks
        groupByFormat = {
          year: { $year: '$createdAt' },
          week: { $week: '$createdAt' },
        };
        dateFormat = 'Week %U, %Y';
        break;
      case 'monthly':
      default:
        startDate.setMonth(startDate.getMonth() - 12); // Last 12 months
        groupByFormat = {
          year: { $year: '$createdAt' },
          month: { $month: '$createdAt' },
        };
        dateFormat = '%Y-%m';
        break;
    }

    const trends = await Application.aggregate([
      {
        $match: {
          jobPost: { $in: jobIds },
          createdAt: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: groupByFormat,
          count: { $sum: 1 },
          pending: {
            $sum: { $cond: [{ $eq: ['$status', 'Pending'] }, 1, 0] },
          },
          accepted: {
            $sum: { $cond: [{ $eq: ['$status', 'Accepted'] }, 1, 0] },
          },
          rejected: {
            $sum: { $cond: [{ $eq: ['$status', 'Rejected'] }, 1, 0] },
          },
        },
      },
      {
        $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1, '_id.week': 1 },
      },
    ]);

    // Format data for chart
    const formattedData = trends.map(item => ({
      date: formatTrendDate(item._id, period),
      total: item.count,
      pending: item.pending,
      accepted: item.accepted,
      rejected: item.rejected,
    }));

    return res.status(200).json({
      success: true,
      period,
      data: formattedData,
      startDate,
      endDate: now,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get job status distribution
 * @route GET /api/v1/employer-dashboard/job-status-distribution
 * @access Private (Employer)
 */
dashboardController.getJobStatusDistribution = async (req, res, next) => {
  try {
    const employerId = getEffectiveEmployerId(req.user);

    const distribution = await JobPost.aggregate([
      {
        $match: { employer: new mongoose.Types.ObjectId(employerId) },
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalApplications: { $sum: '$applicantCount' },
        },
      },
    ]);

    const totalJobs = distribution.reduce((sum, item) => sum + item.count, 0);

    const formattedDistribution = distribution.map(item => ({
      status: item._id || 'Draft',
      count: item.count,
      percentage: totalJobs > 0 ? Math.round((item.count / totalJobs) * 100) : 0,
      totalApplications: item.totalApplications || 0,
    }));

    return res.status(200).json({
      success: true,
      distribution: formattedDistribution,
      totalJobs,
    });
  } catch (error) {
    next(error);
  }
};

// Helper functions
function generateMockProfileViewsData(months) {
  const data = [];
  const now = new Date();
  
  for (let i = months - 1; i >= 0; i--) {
    const date = new Date();
    date.setMonth(date.getMonth() - i);
    
    data.push({
      month: date.toLocaleString('default', { month: 'short' }),
      year: date.getFullYear(),
      views: Math.floor(Math.random() * 1000) + 500,
      applications: Math.floor(Math.random() * 100) + 20,
      engagement: Math.floor(Math.random() * 30) + 20,
    });
  }
  
  return data;
}

function formatProfileViewsData(data, months) {
  if (!data || data.length === 0) {
    return generateMockProfileViewsData(months);
  }

  return data.map(item => ({
    month: new Date(item._id.year, item._id.month - 1).toLocaleString('default', { month: 'short' }),
    year: item._id.year,
    views: item.count,
    applications: Math.floor(item.count * 0.1), // Assuming 10% conversion
    engagement: Math.floor(Math.random() * 30) + 20,
  }));
}


function formatTrendDate(dateObj, period) {
  if (period === 'daily') {
    return `${dateObj.year}-${String(dateObj.month).padStart(2, '0')}-${String(dateObj.day).padStart(2, '0')}`;
  } else if (period === 'weekly') {
    return `Week ${dateObj.week}, ${dateObj.year}`;
  } else {
    return `${dateObj.year}-${String(dateObj.month).padStart(2, '0')}`;
  }
}

export default dashboardController;
