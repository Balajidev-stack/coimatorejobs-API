import mongoose from 'mongoose';
import ResumeAlert from '../models/resumeAlert.model.js'; 
import CandidateProfile from '../models/candidateProfile.model.js';
import { BadRequestError, NotFoundError } from '../utils/errors.js';
import { sendResumeAlertEmail } from '../utils/mailer.js';
import { matchResumeToAlert } from '../utils/resumeMatching.js'; 
import { requireEmployerResumeAlertLimit } from '../utils/employerPlanAccess.js';
import EventEmitter from 'events';

const alertEmitter = new EventEmitter();

const resumeAlertController = {};

// Helper: Parse mixed field inputs
const parseField = (val) => {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  try { return JSON.parse(val); } catch (e) { return [val]; }
};

// Helper: Sanitize criteria to prevent type crashes (like .some is not a function)
const sanitizeCriteria = (criteria) => {
  if (!criteria) return criteria;

  // Normalize optional ObjectId fields: empty strings should be treated as unset
  if (typeof criteria.role === 'string' && criteria.role.trim() === '') {
    delete criteria.role;
  }

  // Keep only valid ObjectId-like strings in multi-select taxonomy fields
  if (criteria.functionalAreas) {
    const parsedFunctionalAreas = parseField(criteria.functionalAreas);
    criteria.functionalAreas = parsedFunctionalAreas.filter((id) => mongoose.Types.ObjectId.isValid(id));
  }

  if (criteria.skills) {
    const parsedSkills = parseField(criteria.skills);
    criteria.skills = parsedSkills.filter((id) => mongoose.Types.ObjectId.isValid(id));
  }
  
  // Guarantee location.city is always an array
  if (criteria.location) {
    if (criteria.location.city && !Array.isArray(criteria.location.city)) {
      criteria.location.city = [criteria.location.city];
    } else if (!criteria.location.city) {
      criteria.location.city = [];
    }
  } else {
    criteria.location = { city: [], country: 'India' };
  }

  return criteria;
};

/**
 * Creates a resume alert for the logged-in employer.
 * @route POST /api/v1/employer/resume-alerts
 * @access Private (Employer only)
 */
resumeAlertController.createResumeAlert = async (req, res, next) => {
  try {
    const employerId = req.user.id || req.user._id;
    let { title, criteria, frequency } = req.body;

    const canCreateByPlan = await requireEmployerResumeAlertLimit(req, res);
    if (!canCreateByPlan) return;

    if (!title || !criteria || Object.keys(criteria).length === 0) {
      throw new BadRequestError('Title and at least one criterion are required');
    }

    // Sanitize criteria before validation and saving
    criteria = sanitizeCriteria(criteria);

    // Validate Master Fields
    if (!criteria.industry || !(await mongoose.model('Industry').findById(criteria.industry))) {
      throw new BadRequestError('Valid Industry is required');
    }

    const faIds = parseField(criteria.functionalAreas);
    if (faIds.length > 0) {
      const faCount = await mongoose.model('FunctionalArea').countDocuments({ _id: { $in: faIds } });
      if (faCount !== faIds.length) throw new BadRequestError('One or more Functional Areas are invalid');
    }
    criteria.functionalAreas = faIds;

    if (criteria.role && !(await mongoose.model('Role').findById(criteria.role))) {
      throw new BadRequestError('Invalid Role');
    }

    const newAlert = new ResumeAlert({
      employer: employerId,
      title,
      criteria,
      frequency,
    });

    await newAlert.save();

    return res.status(201).json({
      success: true,
      message: 'Resume alert created successfully',
      alert: newAlert,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Updates an existing resume alert for the logged-in employer.
 * @route PUT /api/v1/employer/resume-alerts/:id
 * @access Private (Employer only)
 */
resumeAlertController.updateResumeAlert = async (req, res, next) => {
  try {
    const employerId = req.user.id || req.user._id;
    const alertId = req.params.id;
    let { title, criteria, frequency } = req.body;

    const alert = await ResumeAlert.findById(alertId);
    if (!alert || alert.employer.toString() !== employerId.toString()) {
      throw new NotFoundError('Resume alert not found or not yours');
    }

    // Validate Master Fields if updating
    if (criteria) {
        // Sanitize criteria to prevent type crashes
        criteria = sanitizeCriteria(criteria);

        if (criteria.industry && criteria.industry !== alert.criteria.industry?.toString()) {
            if (!(await mongoose.model('Industry').findById(criteria.industry))) throw new BadRequestError('Invalid Industry');
        }
        if (criteria.functionalAreas) {
            criteria.functionalAreas = parseField(criteria.functionalAreas).filter((id) => mongoose.Types.ObjectId.isValid(id));
        }
        if (criteria.role && criteria.role !== alert.criteria.role?.toString()) {
            if (!(await mongoose.model('Role').findById(criteria.role))) throw new BadRequestError('Invalid Role');
        }
        alert.criteria = criteria;
    }

    alert.title = title || alert.title;
    alert.frequency = frequency || alert.frequency;

    await alert.save();

    return res.status(200).json({
      success: true,
      message: 'Resume alert updated successfully',
      alert,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Deletes a resume alert for the logged-in employer.
 * @route DELETE /api/v1/employer/resume-alerts/:id
 * @access Private (Employer only)
 */
resumeAlertController.deleteResumeAlert = async (req, res, next) => {
  try {
    const employerId = req.user.id;
    const alertId = req.params.id;

    const alert = await ResumeAlert.findById(alertId);
    if (!alert || alert.employer.toString() !== employerId.toString()) {
      throw new NotFoundError('Resume alert not found or not yours');
    }

    await alert.deleteOne();

    return res.status(200).json({
      success: true,
      message: 'Resume alert deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Lists all resume alerts for the logged-in employer.
 * @route GET /api/v1/employer/resume-alerts
 * @access Private (Employer only)
 */
resumeAlertController.listResumeAlerts = async (req, res, next) => {
  try {
    const employerId = req.user.id || req.user._id;

    // Fetch alerts for employer and populate taxonomy names for the frontend
    const alerts = await ResumeAlert.find({ employer: employerId })
      .populate('criteria.industry', 'name')
      .populate('criteria.functionalAreas', 'name')
      .populate('criteria.role', 'name')
      .populate('criteria.skills', 'name')
      .select('-__v')
      .sort({ createdAt: -1 })
      .lean(); 

    //  If no alerts, respond early
    if (!alerts.length) {
      return res.status(200).json({
        success: true,
        message: 'No resume alerts found for this employer.',
        alerts: [],
      });
    }

    // Fetch all active, searchable candidates once to avoid n+1 DB queries
    const candidates = await CandidateProfile.find({ isActive: true, allowInSearch: true })
      .select('skills industry role functionalAreas experience educationLevels location expectedSalary preferences age gender socialMedia fullName jobTitle description')
      .lean();

    //  Enrich alerts with accurate matching candidate count
    const formattedAlerts = alerts.map((alert) => {
        let matchingCount = 0;
        
        // Defensively sanitize criteria to handle old corrupted DB records
        const safeCriteria = sanitizeCriteria(alert.criteria);

        // Run every candidate through the weighted algorithm
        candidates.forEach(candidate => {
            const matchResult = matchResumeToAlert(candidate, safeCriteria);
            if (matchResult.matched) {
                matchingCount++;
            }
        });

        return {
            ...alert,
            stats: {
                ...alert.stats,
                totalMatches: matchingCount
            }
        };
    });

    return res.status(200).json({
      success: true,
      count: formattedAlerts.length,
      alerts: formattedAlerts,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Gets matching candidate profiles for a specific resume alert.
 * @route GET /api/v1/employer/resume-alerts/:alertid/matches
 * @access Private (Employer, Admin, Superadmin)
 */
resumeAlertController.getAlertMatches = async (req, res, next) => {
  try {
    const employerId = req.user.id;
    const alertId = req.params.id;
    const { page = 1, limit = 10 } = req.query;

    const alert = await ResumeAlert.findById(alertId);
    if (!alert || alert.employer.toString() !== employerId.toString()) {
      throw new NotFoundError('Resume alert not found or not yours');
    }

    const allProfiles = await CandidateProfile.find({
      isActive: true,
      allowInSearch: true,
    });
    
    // Apply liberal matching using defensively sanitized logic
    const safeCriteria = sanitizeCriteria(alert.criteria);
    const matches = allProfiles
      .map(profile => {
        const { matched, matchScore } = matchResumeToAlert(profile, safeCriteria);
        return matched ? { ...profile.toObject(), matchScore } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.matchScore - a.matchScore);

    if (!matches.length) {
      throw new NotFoundError('No Candidate are available for matching');
    }

    const startIndex = (page - 1) * limit;
    const paginated = matches.slice(startIndex, startIndex + parseInt(limit));

    return res.status(200).json({
      success: true,
      matches: paginated.map(p => ({
        id: p._id,
        fullName: p.fullName,
        jobTitle: p.jobTitle,
        location: p.location?.city || 'N/A',
        expectedSalary: p.expectedSalary || 'N/A',
        experience: p.experience || 'N/A',
        categories: p.categories || [],
        matchScore: p.matchScore?.toFixed(1),
        profilePhoto: p.profilePhoto || '/default-avatar.jpg',
      })),
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(matches.length / limit),
        total: matches.length,
        limit: parseInt(limit),
      },
    });
  } catch (error) {
    next(error);
  }
};

// Event listener for resume alerts
alertEmitter.on('resumeAlert', async ({ alertId, profileId }) => {
  try {
    const alert = await ResumeAlert.findById(alertId).populate('employer', 'email');
    const profile = await CandidateProfile.findById(profileId);
    if (alert && profile && alert.employer.email) {
      
      const safeCriteria = sanitizeCriteria(alert.criteria);
      const matches = matchResumeToAlert(profile, safeCriteria);
      
      if (matches) {
        await sendResumeAlertEmail({
          recipient: alert.employer.email,
          candidateName: profile.fullName,
          jobTitle: profile.jobTitle,
          profileId: profile._id,
          alert,
        });
        await ResumeAlert.findByIdAndUpdate(alertId, { $inc: { matchingCount: 1 } });
      }
    }
  } catch (error) {
    console.error('Error in resumeAlert emitter:', error);
  }
});

export default resumeAlertController;
