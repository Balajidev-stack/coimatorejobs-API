import mongoose from "mongoose";

const employerAccessRoleSchema = new mongoose.Schema({
  roleId: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    uppercase: true,
  },
  ownerEmployer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
    minlength: 2,
    maxlength: 60,
  },
  normalizedName: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
  },
  accessTabs: [{
    type: String,
    trim: true,
  }],
  isActive: {
    type: Boolean,
    default: true,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null,
  },
}, { timestamps: true });

employerAccessRoleSchema.index(
  { ownerEmployer: 1, normalizedName: 1, isActive: 1 },
  { unique: true, partialFilterExpression: { isActive: true } }
);

const EmployerAccessRole = mongoose.model("EmployerAccessRole", employerAccessRoleSchema);

export default EmployerAccessRole;
