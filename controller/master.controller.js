import mongoose from 'mongoose';
import Industry from '../models/industry.model.js';
import FunctionalArea from '../models/functionalArea.model.js';
import Role from '../models/role.model.js';
import Skill from '../models/skill.model.js';
import Location from '../models/location.model.js';

const masterController = {
  /**
   * Get all industries (SEO: sorted, active only)
   */
  getIndustries: async (req, res) => {
    try {
      const data = await Industry.find({ isActive: true })
        .select('name slug')
        .sort({ name: 1 })
        .lean(); // Fast, no Mongoose overhead

      res.json({ success: true, data });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Failed to fetch industries', error: error.message });
    }
  },

/**
 * Get functional areas (SEO: global + industry-specific)
*/
getFunctionalAreas: async (req, res) => {
  try {
    const { industryId } = req.query;

    // Base filter
    let filter = { isActive: true };

    /**
     * Industry filter
     */
    if (industryId) {
      if (!mongoose.Types.ObjectId.isValid(industryId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid industryId',
        });
      }

      // Fetch active industry
      const industry = await Industry.findOne({
        _id: industryId,
        isActive: true,
      })
        .select('slug')
        .lean();

      if (!industry) {
        return res.status(404).json({
          success: false,
          message: 'Industry not found',
        });
      }

      // "Other" industry → all functional areas (SEO catch-all)
      if (industry.slug !== 'other') {
        filter.$or = [
          { industry: industryId },
          { isGlobal: true },
        ];
      }
      // else: keep base filter (all active)
    } else {
      // No industry → only global functional areas
      filter.isGlobal = true;
    }

    const data = await FunctionalArea.find(filter)
      .select('name slug isGlobal priority')
      .sort({
        isGlobal: 1,     // global first
        priority: -1,    // higher priority first
        name: 1,         // alphabetical
      })
      .lean();

    return res.json({ success: true, data });
  } catch (error) {
    console.error('❌ getFunctionalAreas error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch functional areas',
    });
  }
},

  /**
   * Get roles (SEO: search, trending, priority; global + filtered)
   */
  getRoles: async (req, res) => {
    try {
      const { functionalAreaId, industryId, search, includeGlobal = 'true' } = req.query;

      const andConditions = [{ isActive: true }];

      // Functional Area filter
      if (functionalAreaId) {
        if (!mongoose.Types.ObjectId.isValid(functionalAreaId)) {
          return res.status(400).json({ success: false, message: 'Invalid functionalAreaId' });
        }

        andConditions.push({ functionalArea: functionalAreaId });
      }

      // Industry filter (get FAs for industry + global)
      if (industryId) {
        if (!mongoose.Types.ObjectId.isValid(industryId)) {
          return res.status(400).json({ success: false, message: 'Invalid industryId' });
        }
        const faIds = await FunctionalArea.find({
          isActive: true,
          $or: [{ industry: industryId }, { isGlobal: true }],
        }).distinct('_id');

        andConditions.push({ functionalArea: { $in: faIds } });
      }

      // Search filter (SEO: keywords, alt names)
      if (search?.trim()) {
        const regex = new RegExp(search.trim(), 'i');
        andConditions.push({
          $or: [{ name: regex }, { keywords: regex }, { alternativeNames: regex }],
        });
      }

      const baseFilter = { $and: andConditions };

      let finalFilter = baseFilter;
      if (includeGlobal !== 'false') {
        if (functionalAreaId) {
          // For FA-specific dropdowns, include:
          // 1) roles from selected FA
          // 2) all global roles
          // Then dedupe by name so roles like Faculty won't repeat.
          finalFilter = {
            $or: [
              { functionalArea: functionalAreaId, isActive: true },
              { isGlobal: true, isActive: true },
            ],
          };
        } else {
          finalFilter = {
            $or: [{ isGlobal: true, isActive: true }, baseFilter],
          };
        }
      }

      // Keep role dropdown complete in dashboard forms.
      // Hard 100-limit was truncating A-Z list around "Faculty".
      const rawData = await Role.find(finalFilter)
        .select('name slug priority isGlobal searchVolume isTrending keywords alternativeNames functionalArea')
        .populate({
          path: 'functionalArea',
          select: 'name industry',
          populate: {
            path: 'industry',
            select: 'name slug',
          },
        })
        .sort({ name: 1 }) // Keep dropdown roles in consistent A-Z order
        .lean();

      // Defensive dedupe:
      // - for FA-specific requests with global merge: dedupe by role name
      // - otherwise: dedupe by role name + functional area
      const dedupedMap = new Map();
      for (const role of rawData) {
        const faId =
          role.functionalArea && typeof role.functionalArea === 'object'
            ? String(role.functionalArea._id || '')
            : String(role.functionalArea || '');
        const roleNameKey = String(role.name || '').trim().toLowerCase();
        const key = functionalAreaId ? roleNameKey : `${roleNameKey}__${faId}`;
        if (!dedupedMap.has(key)) {
          dedupedMap.set(key, role);
        }
      }
      const data = Array.from(dedupedMap.values());

      res.json({ success: true, data });
    } catch (error) {
      console.error('Roles fetch error:', error);
      res.status(500).json({ success: false, message: 'Failed to fetch roles' });
    }
  },

  /**
   * Get skills (SEO: searchable, paginated)
   */
  getSkills: async (req, res) => {
    try {
      const q = req.query.q?.trim() || '';
      const page = parseInt(req.query.page) || 1;
      const limit = Math.min(parseInt(req.query.limit) || 20, 50); // Cap at 50
      const skip = (page - 1) * limit;

      const filter = { isActive: true };
      if (q) {
        const regex = new RegExp(q, 'i');
        filter.$or = [{ name: regex }, { keywords: regex }];
      }

      const total = await Skill.countDocuments(filter);

      const data = await Skill.find(filter)
        .select('name slug keywords')
        .skip(skip)
        .limit(limit)
        .sort({ name: 1 })
        .lean();

      res.json({
        success: true,
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        data,
      });
    } catch (error) {
      console.error('Skills fetch error:', error);
      res.status(500).json({ success: false, message: 'Failed to fetch skills' });
    }
  },

  /**
   * Get popular roles (SEO: dynamic trending page)
   */
  getPopularRoles: async (req, res) => {
    try {
      const data = await Role.find({ isActive: true })
        .select('name slug searchVolume isTrending')
        .sort({ searchVolume: -1, isTrending: -1 })
        .limit(20)
        .lean();

      res.json({ success: true, data });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Failed to fetch popular roles', error: error.message });
    }
  },

  /**
   * Get skill categories (SEO: category pages)
   */
getSkillCategories: async (req, res) => {
  try {
    const categories = await Skill.distinct('category', {
      category: { $ne: null, $ne: '' },
      isActive: true 
    });

    console.log("ejfbkuf", categories);
    

    res.json({
      success: true,
      data: categories.sort(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch skill categories',
    });
  }
},


  /**
   * Get locations (SEO: city-based job pages)
   */
  getLocations: async (req, res) => {
    try {
      const q = req.query.q || '';
      const filter = { isActive: true };
      if (q) {
        filter.name = { $regex: q, $options: 'i' };
      }

      const data = await Location.find(filter)
        .select('name slug state keywords')
        .limit(20)
        .sort({ name: 1 })
        .lean();

      res.json({ success: true, data });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Failed to fetch locations', error: error.message });
    }
  },
};

export default masterController;
