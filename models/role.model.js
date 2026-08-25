import mongoose from 'mongoose';

const COLLAR_CATEGORIES = [
  'Blue Collar',
  'White Collar',
  'Black Collar',
  'Grey Collar',
  'Pink Collar',
  'Gold Collar',
  'Green Collar',
  'Red Collar',
];

const roleSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },

  slug: {
    type: String,
    required: true,
  },

  functionalArea: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FunctionalArea',
    required: true,
    index: true,
  },

  /**
   * GLOBAL / STATUS
   */
  isGlobal: {
    type: Boolean,
    default: false,
    index: true,
  },

  isActive: {
    type: Boolean,
    default: true,
    index: true,
  },

  isCustom: {
    type: Boolean,
    default: false,
    index: true,
  },

  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true,
  },

  defaultCollarCategory: {
    type: String,
    default: null,
    trim: true,
  },

  /**
   * SEO + DISCOVERY
   */
  searchVolume: {
    type: Number,
    default: 0,
    index: true,
  },

  isTrending: {
    type: Boolean,
    default: false,
    index: true,
  },

  priority: {
    type: Number,
    default: 0,
    index: true,
  },

  jobCount: {
    type: Number,
    default: 0,
  },

  /**
   * SEARCH SUPPORT
   */
  keywords: {
    type: [String],
    default: [],
  },

  alternativeNames: {
    type: [String],
    default: [],
  },

  /**
   * SEO META
   */
  seoTitle: String,
  seoDescription: String,

}, { timestamps: true });

/**
 * Allow same role name under different Functional Areas
 */
roleSchema.index(
  { slug: 1, functionalArea: 1 },
  { unique: true }
);

/**
 * Full-text search index
 */
roleSchema.index({
  name: 'text',
  keywords: 'text',
  alternativeNames: 'text',
});

/**
 * High-performance sorting 
 */
roleSchema.index({
  isActive: 1,
  isTrending: -1,
  searchVolume: -1,
  priority: -1,
});

export default mongoose.model('Role', roleSchema);
