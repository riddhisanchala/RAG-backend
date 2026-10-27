// A user account. Passwords are stored only as bcrypt hashes.
import mongoose from 'mongoose';
import { ROLES, ACCOUNT_STATUS } from '../config/roles.js';

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, trim: true, lowercase: true },
    email: { type: String, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, required: true, enum: Object.values(ROLES) },
    department: { type: String, required: true },
    isActive: { type: Boolean, default: true },
    // PENDING = waiting for approval (cannot sign in), REJECTED = request declined.
    status: { type: String, enum: Object.values(ACCOUNT_STATUS), default: ACCOUNT_STATUS.ACTIVE },
    decidedBy: { type: String, default: '' },
  },
  { timestamps: true, collection: 'user_data' }
);

// Email is optional (default accounts have none). A plain unique/sparse index treats a missing email as
// null and rejects the 2nd account without one (E11000 duplicate key {email: null}), which broke seeding
// and therefore login. A partial index only covers documents that really have an email string.
userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });

export default mongoose.model('User', userSchema);
