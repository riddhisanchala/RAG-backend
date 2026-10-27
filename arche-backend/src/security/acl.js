// ─────────────────────────────────────────────────────────────────────────────
// acl.js — the ONE place where "may this user see this passage?" is decided.
//
// An ACL looks like:   { department: 'HR', allowedRoles: ['HR'], allowedUsers: ['employee01'] }
//
// Rules (evaluated per chunk / per record row):
//   1. ADMIN can read everything.
//   2. If the user's username is in allowedUsers  → allowed   (row owner, private upload)
//   3. If allowedRoles is non-empty               → allowed only if user's role is listed
//   4. If both lists are empty                    → allowed if the user's role may read the
//                                                    ACL's department (ROLE_DEPARTMENTS)
//   Anything else → DENIED.  Unknown / malformed ACL → DENIED (fail closed).
// ─────────────────────────────────────────────────────────────────────────────
import { ROLES, ROLE_DEPARTMENTS, DEPARTMENTS, SHARING_ROLES } from '../config/roles.js';

export function canAccess(principal, acl) {
  if (!principal || !principal.username || !principal.role) return false;
  if (!acl || typeof acl.department !== 'string') return false; // fail closed
  if (principal.role === ROLES.ADMIN) return true;

  const users = acl.allowedUsers || [];
  const roles = acl.allowedRoles || [];

  if (users.includes(principal.username)) return true;
  if (roles.length > 0) return roles.includes(principal.role);
  if (users.length > 0) return false; // explicitly restricted to named users
  return (ROLE_DEPARTMENTS[principal.role] || []).includes(acl.department);
}

// Which partitions (departments) COULD contain something this user may read?
// Used to prune the search; the per-chunk check above remains the authority.
export function departmentsByRole(principal) {
  return ROLE_DEPARTMENTS[principal?.role] || [];
}

// Plain-object snapshot of a principal from a Mongo user (never trust token claims).
export function toPrincipal(userDoc) {
  return {
    id: String(userDoc._id),
    username: userDoc.username,
    role: userDoc.role,
    department: userDoc.department,
    name: userDoc.name,
  };
}

// Build an ACL from an upload request. Validates what the uploader is allowed to grant.
//   access: 'department' | 'roles' | 'private'
export function buildAcl(principal, { department, access = 'department', allowedRoles = [] }) {
  const err = (m) => Object.assign(new Error(m), { status: 403 });
  const bad = (m) => Object.assign(new Error(m), { status: 400 });

  if (!DEPARTMENTS.includes(department)) throw bad(`Unknown department "${department}".`);
  if (!['department', 'roles', 'private'].includes(access)) throw bad('Invalid access mode.');

  if (access === 'private') {
    // Anyone may keep a private document; it lives in GENERAL so partition rules are simple.
    return {
      acl: { department: 'GENERAL', allowedRoles: [], allowedUsers: [principal.username] },
      label: 'Only you (private)',
    };
  }

  // Shared documents: only staff roles (ADMIN / HR), and only into departments they can already read.
  if (!SHARING_ROLES.includes(principal.role)) throw err('Your role can only upload private documents.');
  if (!departmentsByRole(principal).includes(department)) {
    throw err(`Your role cannot add documents to the ${department} department.`);
  }

  if (access === 'roles') {
    const roles = [...new Set(allowedRoles)].filter((r) => Object.values(ROLES).includes(r));
    if (roles.length === 0) throw bad('Select at least one role.');
    return {
      acl: { department, allowedRoles: roles, allowedUsers: [] },
      label: `Roles: ${roles.join(', ')}`,
    };
  }

  return { acl: { department, allowedRoles: [], allowedUsers: [] }, label: `${department} department` };
}

export const normUser = (s) => String(s || '').trim().toLowerCase();
