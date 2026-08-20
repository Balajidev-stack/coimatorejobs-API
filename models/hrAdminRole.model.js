import mongoose from "mongoose";

const hrAdminRoleSchema = new mongoose.Schema({
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

hrAdminRoleSchema.index(
  { normalizedName: 1, isActive: 1 },
  { unique: true, partialFilterExpression: { isActive: true } }
);

const HrAdminRole = mongoose.model("HrAdminRole", hrAdminRoleSchema);

export default HrAdminRole;
