// utils/roleHelper.js

// Roles that can act like "employer" (post jobs, manage applicants)
export const EMPLOYER_LIKE_ROLES = ['employer', 'hr-admin', 'sub-admin', 'superadmin'];

// Roles that can manage users/system
export const PLATFORM_ADMIN_ROLES = ['superadmin'];

export const isEmployerLike = (role) => EMPLOYER_LIKE_ROLES.includes(role);
export const isPlatformAdmin = (role) => PLATFORM_ADMIN_ROLES.includes(role);

export const getEffectiveEmployerId = (user) =>
  user?.employerOwnerId || user?.parentEmployer || user?.id || user?._id;


/**
 * Checks whether a user can manage a given job post
 * (view applicants, shortlist, approve, reject, delete, etc.)
 *
 * Permission Rules:
 * ------------------------------------------------
 * superadmin → can manage all jobs
 * employer   → can manage jobs they own
 * hr-admin   -> can manage all jobs
 *
 * @param {Object} jobPost - JobPost document
 * @param {Object} user - Logged-in user
 * @returns {Boolean}
 */
export const canManageJob = (jobPost, user) => {

  if (!jobPost || !user) return false;

  if (user.role === 'superadmin') return true;

  if (user.role === 'employer' && jobPost.employer?.toString() === getEffectiveEmployerId(user)?.toString()) {
    return true;
  }
  // console.log("tetttt", user.id);

   // HR-Admin → manages jobs for assigned employer
  if (['hr-admin', 'sub-admin'].includes(user.role)) {
    return true;
  }

  return false;
};


/**
 * Builds MongoDB query to fetch job posts
 * user is allowed to manage.
 *
 * Mirrors canManageJob() logic at query level.
 *
 * @param {Object} user - Logged-in user
 * @returns {Object} MongoDB query
 */
export const buildJobQueryForUser = (user) => {
  if (!user) return { _id: null };

  // SUPERADMIN → all jobs
  if (user.role === 'superadmin' || ['hr-admin', 'sub-admin'].includes(user.role)) {
    return {}; // All jobs
  }

  // EMPLOYER → own jobs
  if (user.role === 'employer') {
    return { employer: getEffectiveEmployerId(user) };
  }

  // HR-ADMIN → jobs of assigned employers
//   if (user.role === 'hr-admin') {
//     return {
//       $or: [
//         { employer: { $in: user.employerIds } }, // assigned employers
//         { postedBy: user.id }                    // jobs HR created
//       ]
//     };
//   }

//   if (user.role === 'hr-admin') {
//     if (user.scope === 'restricted') {
//         return { employer: { $in: user.employerIds } };
//     }
//     return {}; // full access HR
// }


  return { _id: null };
};



/**
 * Build dashboard filter based on user role
 * @param {Object} user - User object
 * @returns {Object} - Filter object for queries
 */
export const buildDashboardFilter = (user, collection) => {
  if (!user) return {};
  
  // Superadmin gets full access
  if (user.role === 'superadmin') return {};
  
  // HR-Admin filters by assigned employers
  if (['hr-admin', 'sub-admin'].includes(user.role) && user.employerIds && user.employerIds.length > 0) {
    switch (collection) {
      case 'users':
        return { _id: { $in: user.employerIds }, role: 'employer' };
      case 'jobposts':
        return { employer: { $in: user.employerIds } };
      case 'companyprofiles':
        return { employer: { $in: user.employerIds } };
      case 'applications':
        // Will be filtered via job posts
        return {};
      default:
        return {};
    }
  }
  
  // Employer filters by their own data
  if (user.role === 'employer') {
    const employerId = getEffectiveEmployerId(user);
    switch (collection) {
      case 'users':
        return { _id: employerId };
      case 'jobposts':
        return { employer: employerId };
      case 'companyprofiles':
        return { employer: employerId };
      case 'applications':
        // Will be filtered via job posts
        return {};
      default:
        return { employer: employerId };
    }
  }
  
  return {};
};

/**
 * Check if user can view platform-wide stats
 * @param {string} role - User role
 * @returns {boolean} - True if can view platform stats
 */
export const canViewPlatformStats = (role) => {
  return ['hr-admin', 'sub-admin', 'superadmin'].includes(role);
};

/**
 * Check if user can view employer-specific stats
 * @param {Object} user - User object
 * @param {string} employerId - Employer ID to check
 * @returns {boolean} - True if can view employer stats
 */
export const canViewEmployerStats = (user, employerId) => {
  if (!user || !employerId) return false;
  
  if (user.role === 'superadmin') return true;
  
  if (['hr-admin', 'sub-admin'].includes(user.role)) {
    return user.employerIds?.some(id => id.toString() === employerId.toString());
  }
  
  if (user.role === 'employer') {
    return getEffectiveEmployerId(user)?.toString() === employerId.toString();
  }
  
  return false;
};
