import mongoose from 'mongoose';

const candidateCoverLetterSchema = new mongoose.Schema({
  candidate: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  title: {
    type: String,
    required: true,
    trim: true,
  },
  template: {
    type: String,
    trim: true,
    default: '',
  },
  fullName: {
    type: String,
    trim: true,
    default: '',
  },
  jobTitle: {
    type: String,
    trim: true,
    default: '',
  },
  email: {
    type: String,
    trim: true,
    default: '',
  },
  city: {
    type: String,
    trim: true,
    default: '',
  },
  mobileNumber: {
    type: String,
    trim: true,
    default: '',
  },
  company: {
    type: String,
    trim: true,
    default: '',
  },
  managerName: {
    type: String,
    trim: true,
    default: '',
  },
  role: {
    type: String,
    trim: true,
    default: '',
  },
  content: {
    type: String,
    trim: true,
    default: '',
  },
  html: {
    type: String,
    default: '',
  },
  isActive: {
    type: Boolean,
    default: true,
  },
}, { timestamps: true });

candidateCoverLetterSchema.index({ candidate: 1, isActive: 1, updatedAt: -1 });

const CandidateCoverLetter = mongoose.model('CandidateCoverLetter', candidateCoverLetterSchema);

export default CandidateCoverLetter;
