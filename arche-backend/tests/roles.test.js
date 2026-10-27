// Role policy tests (pure logic, no database needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { canAccess, buildAcl } from '../src/security/acl.js';
import { ROLES, SELF_SIGNUP_ROLES, APPROVAL_REQUIRED, APPROVERS } from '../src/config/roles.js';

const U = (username, role) => ({ username, role });
const general = { department: 'GENERAL', allowedRoles: [], allowedUsers: [] };
const hrDoc = { department: 'HR', allowedRoles: [], allowedUsers: [] };

test('EMPLOYEE never sees HR documents and only sees private uploads that are theirs', () => {
  assert.equal(canAccess(U('u', 'EMPLOYEE'), hrDoc), false);
  assert.equal(canAccess(U('u', 'EMPLOYEE'), { department: 'GENERAL', allowedRoles: [], allowedUsers: ['u'] }), true, 'own private upload');
  assert.equal(canAccess(U('u', 'EMPLOYEE'), { department: 'GENERAL', allowedRoles: [], allowedUsers: ['someone'] }), false);
});

test('EMPLOYEE reads GENERAL only; HR reads HR + GENERAL', () => {
  assert.equal(canAccess(U('e', 'EMPLOYEE'), general), true);
  assert.equal(canAccess(U('e', 'EMPLOYEE'), hrDoc), false);
  assert.equal(canAccess(U('h', 'HR'), hrDoc), true);
  assert.equal(canAccess(U('a', 'ADMIN'), hrDoc), true);
  // a retired / unknown department is never readable by non-admin roles
  assert.equal(canAccess(U('h', 'HR'), { department: 'FINANCE', allowedRoles: [], allowedUsers: [] }), false);
});

test('only ADMIN / HR may share documents; EMPLOYEE can only upload private ones', () => {
  for (const role of ['EMPLOYEE']) {
    assert.throws(() => buildAcl(U('x', role), { department: 'GENERAL', access: 'department' }), /private/i);
    assert.deepEqual(buildAcl(U('x', role), { department: 'GENERAL', access: 'private' }).acl.allowedUsers, ['x']);
  }
  assert.ok(buildAcl(U('h', 'HR'), { department: 'HR', access: 'department' }));
  assert.throws(() => buildAcl(U('h', 'HR'), { department: 'FINANCE', access: 'department' }), /unknown department/i);
});

test('sign-up policy: only Employee / HR can be requested, all need approval; HR needs an admin', () => {
  assert.ok(!SELF_SIGNUP_ROLES.includes(ROLES.ADMIN));
  assert.deepEqual([...SELF_SIGNUP_ROLES].sort(), ['EMPLOYEE', 'HR']);
  assert.deepEqual([...APPROVAL_REQUIRED].sort(), ['EMPLOYEE', 'HR']);
  assert.deepEqual(APPROVERS.HR, ['ADMIN']);
  assert.deepEqual(APPROVERS.EMPLOYEE.sort(), ['ADMIN', 'HR']);
});

test('ADMIN can read everything, including other people\'s private uploads and every department', () => {
  const A = U('admin', 'ADMIN');
  assert.equal(canAccess(A, { department: 'GENERAL', allowedRoles: [], allowedUsers: ['employee01'] }), true, 'employee private file');
  assert.equal(canAccess(A, { department: 'GENERAL', allowedRoles: [], allowedUsers: ['hr01'] }), true, 'HR private file');
  assert.equal(canAccess(A, { department: 'HR', allowedRoles: ['HR'], allowedUsers: [] }), true, 'HR-only file');
  assert.equal(canAccess(A, hrDoc), true);
});
