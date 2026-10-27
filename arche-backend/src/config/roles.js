// roles.js: single source of truth for roles, department access and sign-up policy.

export const ROLES = {
  ADMIN: 'ADMIN',
  HR: 'HR',
  EMPLOYEE: 'EMPLOYEE',
};

// Partitions of the knowledge base. Each department has its own FAISS index.
export const DEPARTMENTS = ['HR', 'GENERAL'];

// Which departments' data each role may read by default.
export const ROLE_DEPARTMENTS = {
  ADMIN: ['HR', 'GENERAL'],
  HR: ['HR', 'GENERAL'],
  EMPLOYEE: ['GENERAL'],
};

// ── Sign-up policy ────────────────────────────────────────────────────────────
// Which roles a person may REQUEST on the public sign-up form: Employee or HR. ADMIN is never self-service.
export const SELF_SIGNUP_ROLES = [ROLES.EMPLOYEE, ROLES.HR];
// Every self-service role needs approval before the account can sign in.
//   EMPLOYEE requests can be approved by HR or ADMIN; HR requests only by ADMIN.
export const APPROVAL_REQUIRED = [ROLES.EMPLOYEE, ROLES.HR];
export const APPROVERS = {
  [ROLES.EMPLOYEE]: [ROLES.HR, ROLES.ADMIN],
  [ROLES.HR]: [ROLES.ADMIN],
};

export const ACCOUNT_STATUS = { ACTIVE: 'ACTIVE', PENDING: 'PENDING', REJECTED: 'REJECTED' };

// Roles that may upload documents shared with others (everyone else: private uploads only).
export const SHARING_ROLES = [ROLES.ADMIN, ROLES.HR];
