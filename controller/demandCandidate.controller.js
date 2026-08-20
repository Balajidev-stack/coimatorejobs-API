import CompanyProfile from '../models/companyProfile.model.js';
import DemandCandidate from '../models/demandCandidate.model.js';
import User from '../models/user.model.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors.js';
import { sendDemandCandidateStatusEmail } from '../utils/mailer.js';
import { createNotification, notificationPresets } from '../utils/notificationHelper.js';
import { sendPushToUsers } from '../utils/fcm.js';
import { getEffectiveEmployerId } from '../utils/roleHelper.js';

const demandCandidateController = {};

const toCleanString = (value) => String(value ?? '').trim();

const normalizeSkills = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item) => toCleanString(item)).filter(Boolean).slice(0, 20);
  }
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
};

const normalizeStringList = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item) => toCleanString(item)).filter(Boolean).slice(0, 20);
  }
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
};

const canManageCompanyDemand = (user, companyProfile) => {
  return ['hr-admin', 'superadmin'].includes(user?.role);
};

const formatDemandStatus = (status = 'pending') => {
  const labels = {
    pending: 'Pending',
    in_progress: 'In Progress',
    candidates_available: 'Candidates Available',
    closed: 'Closed',
  };
  return labels[status] || status;
};

const getFrontendUrl = (path = '/') =>
  `${String(process.env.FRONTEND_URL || '').replace(/\/+$/, '')}${path}`;

const getAdminDashboardPath = (role = 'superadmin') =>
  role === 'hr-admin'
    ? '/hr-admin-dashboard/company-profile'
    : '/super-admin-dashboard/company-profile';

const getDemandAdminUsers = async () =>
  User.find({
    isActive: true,
    $or: [
      { role: 'hr-admin', status: 'approved' },
      { role: 'superadmin' },
    ],
  }).select('_id name email role');

demandCandidateController.createDemandCandidate = async (req, res, next) => {
  try {
    const employerId = getEffectiveEmployerId(req.user);
    const {
      roleTitle,
      jobPostTitle,
      similarCandidateRoles,
      similarRoles,
      searchQuery,
      location,
      experience,
      skills,
      note,
    } = req.body;

    if (!toCleanString(roleTitle)) {
      throw new BadRequestError('Role title is required');
    }

    const companyProfile = await CompanyProfile.findOne({ employer: employerId })
      .sort({ status: 1, createdAt: -1 })
      .select('_id employer companyName email');

    if (!companyProfile) {
      throw new BadRequestError('Please create a company profile before sending a candidate demand enquiry');
    }

    const demand = await DemandCandidate.create({
      employer: employerId,
      companyProfile: companyProfile._id,
      roleTitle: toCleanString(roleTitle),
      jobPostTitle: toCleanString(jobPostTitle),
      similarCandidateRoles: normalizeStringList(similarCandidateRoles || similarRoles),
      searchQuery: toCleanString(searchQuery),
      location: toCleanString(location),
      experience: toCleanString(experience),
      skills: normalizeSkills(skills),
      note: toCleanString(note),
    });

    try {
      const admins = await getDemandAdminUsers();
      const notificationPayload = {
        ...notificationPresets.emailUpdate(
          'New Candidate Demand Enquiry Submitted',
          `${companyProfile.companyName} has requested candidates for ${demand.roleTitle}.`
        ),
        actionUrl: '/super-admin-dashboard/company-profile',
        icon: 'la-users',
        color: '#f59e0b',
      };

      await Promise.allSettled(
        admins.map((admin) =>
          createNotification(admin._id, 'email_update', {
            ...notificationPayload,
            actionUrl: getAdminDashboardPath(admin.role),
          })
        )
      );

      await Promise.allSettled(
        admins.map((admin) => {
          const actionUrl = getAdminDashboardPath(admin.role);
          return sendPushToUsers([admin._id], {
            title: notificationPayload.title,
            body: notificationPayload.description,
            link: getFrontendUrl(actionUrl),
            data: {
              type: 'candidate_demand_created',
              demandId: demand._id,
              companyProfileId: companyProfile._id,
              actionUrl,
            },
          });
        })
      );
    } catch (notificationError) {
      console.error('Failed to notify admins about candidate demand enquiry:', notificationError);
    }

    return res.status(201).json({
      success: true,
      message: 'Candidate demand enquiry submitted successfully',
      demand,
    });
  } catch (error) {
    next(error);
  }
};

demandCandidateController.getCompanyDemandCandidates = async (req, res, next) => {
  try {
    const { companyProfileId } = req.params;
    const companyProfile = await CompanyProfile.findById(companyProfileId).select('_id employer createdBy companyName email');

    if (!companyProfile) {
      throw new NotFoundError('Company profile not found');
    }

    if (!canManageCompanyDemand(req.user, companyProfile)) {
      throw new ForbiddenError('You do not have permission to view these candidate demands');
    }

    const demands = await DemandCandidate.find({ companyProfile: companyProfileId })
      .populate('statusUpdatedBy', 'name email role')
      .sort({ createdAt: -1 })
      .select('-__v');

    return res.status(200).json({
      success: true,
      demands,
    });
  } catch (error) {
    next(error);
  }
};

demandCandidateController.getMyDemandCandidates = async (req, res, next) => {
  try {
    const employerId = getEffectiveEmployerId(req.user);

    const demands = await DemandCandidate.find({ employer: employerId })
      .populate('companyProfile', 'companyName email')
      .populate('statusUpdatedBy', 'name email role')
      .sort({ updatedAt: -1, createdAt: -1 })
      .select('-__v');

    return res.status(200).json({
      success: true,
      demands,
    });
  } catch (error) {
    next(error);
  }
};

demandCandidateController.updateDemandCandidateStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, adminNote } = req.body;
    const allowedStatuses = ['pending', 'in_progress', 'candidates_available', 'closed'];

    if (!allowedStatuses.includes(status)) {
      throw new BadRequestError('Invalid status value');
    }

    const demand = await DemandCandidate.findById(id);
    if (!demand) {
      throw new NotFoundError('Candidate demand enquiry not found');
    }

    const companyProfile = await CompanyProfile.findById(demand.companyProfile).select('_id employer createdBy companyName email');
    if (!companyProfile) {
      throw new NotFoundError('Company profile not found');
    }

    if (!canManageCompanyDemand(req.user, companyProfile)) {
      throw new ForbiddenError('You do not have permission to update this candidate demand');
    }

    const previousStatus = demand.status;
    demand.status = status;
    demand.adminNote = toCleanString(adminNote);
    demand.statusUpdatedBy = req.user.id;
    demand.statusUpdatedAt = new Date();
    await demand.save();

    if (previousStatus !== status) {
      const employer = await User.findById(demand.employer).select('name email contactEmail isSystemGeneratedEmail');
      const recipient = employer?.isSystemGeneratedEmail
        ? (employer.contactEmail || companyProfile.email)
        : (employer?.email || companyProfile.email);

      try {
        await sendDemandCandidateStatusEmail({
          recipient,
          employerName: employer?.name || companyProfile.companyName,
          companyName: companyProfile.companyName,
          roleTitle: demand.roleTitle,
          statusLabel: formatDemandStatus(status),
          previousStatusLabel: formatDemandStatus(previousStatus),
          dashboardLink: getFrontendUrl('/employers-dashboard/all-applicants'),
        });
      } catch (emailError) {
        console.error('Failed to send candidate demand status email:', emailError);
      }

      const statusNotificationPayload = {
        ...notificationPresets.emailUpdate(
          'Candidate Demand Status Updated',
          `Your candidate demand request for ${demand.roleTitle} is now ${formatDemandStatus(status)}.`
        ),
        actionUrl: '/employers-dashboard/all-applicants',
        icon: status === 'candidates_available' ? 'la-check-circle' : 'la-info-circle',
        color: status === 'candidates_available' ? '#22c55e' : '#1967d2',
      };

      try {
        await createNotification(demand.employer, 'email_update', statusNotificationPayload);
        await sendPushToUsers([demand.employer], {
          title: statusNotificationPayload.title,
          body: statusNotificationPayload.description,
          link: getFrontendUrl(statusNotificationPayload.actionUrl),
          data: {
            type: 'candidate_demand_status_updated',
            demandId: demand._id,
            companyProfileId: companyProfile._id,
            status,
            actionUrl: statusNotificationPayload.actionUrl,
          },
        });
      } catch (notificationError) {
        console.error('Failed to notify employer about candidate demand status:', notificationError);
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Candidate demand status updated successfully',
      demand,
    });
  } catch (error) {
    next(error);
  }
};

export default demandCandidateController;
