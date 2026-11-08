#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function runAz(args, { json = true, allowFailure = false } = {}) {
  const result = spawnSync('az', args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    if (allowFailure) return null;
    fail(result.stderr.trim() || `az ${args.join(' ')} failed.`);
  }
  const value = result.stdout.trim();
  if (!json) return value;
  return value ? JSON.parse(value) : null;
}

function graph(method, path, body) {
  const args = [
    'rest',
    '--method', method,
    '--url', `https://graph.microsoft.com/v1.0${path}`,
    '--output', 'json',
  ];
  if (body !== undefined) args.push('--body', JSON.stringify(body));
  return runAz(args);
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function has(name) {
  return process.argv.includes(name);
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

const displayName = option('--display-name') ?? 'CCGC Enterprise API';
const pilotGroupObjectId = option('--pilot-group-object-id');
const adminGroupObjectId = option('--admin-group-object-id');
const adminPortalRedirectUri = option('--admin-portal-redirect-uri');
if (!pilotGroupObjectId || !/^[0-9a-f-]{36}$/i.test(pilotGroupObjectId)) {
  fail('Use --pilot-group-object-id with the Entra object ID of the employee pilot group.');
}
if (!adminGroupObjectId || !/^[0-9a-f-]{36}$/i.test(adminGroupObjectId)) {
  fail('Use --admin-group-object-id with the Entra object ID of the enterprise IT administrator group.');
}
if (pilotGroupObjectId.toLowerCase() === adminGroupObjectId.toLowerCase()) {
  fail('Employee and enterprise IT administrator groups must be separate.');
}
if (!adminPortalRedirectUri) {
  fail('Use --admin-portal-redirect-uri with the public broker /ccgc/admin HTTPS URL.');
}
let adminPortalRedirect;
try {
  adminPortalRedirect = new URL(adminPortalRedirectUri);
} catch {
  fail('The administrator portal redirect URI must be an absolute HTTPS URL.');
}
if (adminPortalRedirect.protocol !== 'https:' || adminPortalRedirect.username || adminPortalRedirect.password
  || adminPortalRedirect.pathname !== '/ccgc/admin' || adminPortalRedirect.search || adminPortalRedirect.hash) {
  fail('The administrator portal redirect URI must be a fixed HTTPS /ccgc/admin URL.');
}
if (!has('--confirm-entra-changes')) {
  fail('Add --confirm-entra-changes after reviewing the tenant, employee group, and administrator group.');
}

const account = runAz(['account', 'show', '--output', 'json']);
const tenantId = account.tenantId;
const pilotGroup = graph('GET', `/groups/${pilotGroupObjectId}?$select=id,displayName,securityEnabled`);
if (pilotGroup.securityEnabled !== true) {
  fail('The pilot employee group must be an Entra security-enabled group.');
}
const adminGroup = graph('GET', `/groups/${adminGroupObjectId}?$select=id,displayName,securityEnabled`);
if (adminGroup.securityEnabled !== true) {
  fail('The enterprise IT administrator group must be an Entra security-enabled group.');
}
const escapedName = displayName.replaceAll("'", "''");
const applications = runAz([
  'ad', 'app', 'list',
  '--filter', `displayName eq '${escapedName}'`,
  '--output', 'json',
]);
if (applications.length > 1) fail(`Multiple app registrations are named ${displayName}.`);

const application = applications[0] ?? runAz([
  'ad', 'app', 'create',
  '--display-name', displayName,
  '--sign-in-audience', 'AzureADMyOrg',
  '--output', 'json',
]);
const applicationDetails = graph('GET', `/applications/${application.id}`);
const audience = `api://${application.appId}`;
const existingScope = (applicationDetails.api?.oauth2PermissionScopes ?? [])
  .find(scope => scope.value === 'CCGC.Invoke' || scope.value === 'CCGC.Access');
const existingRole = (applicationDetails.appRoles ?? [])
  .find(role => role.value === 'CCGC.Access');
const existingAdminRole = (applicationDetails.appRoles ?? [])
  .find(role => role.value === 'CCGC.Admin');
const scopeId = existingScope?.id ?? randomUUID();
const roleId = existingRole?.id ?? randomUUID();
const adminRoleId = existingAdminRole?.id ?? randomUUID();
const azureCliAppId = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';

const scopes = [
  ...(applicationDetails.api?.oauth2PermissionScopes ?? [])
    .filter(scope => scope.value !== 'CCGC.Invoke' && scope.value !== 'CCGC.Access'),
  {
    id: scopeId,
    adminConsentDescription: 'Acquire a signed-in user token for the CCGC enterprise broker. App roles authorize routes.',
    adminConsentDisplayName: 'Acquire CCGC enterprise broker token',
    isEnabled: true,
    type: 'Admin',
    userConsentDescription: 'Acquire a CCGC enterprise broker token as you. Assigned app roles authorize routes.',
    userConsentDisplayName: 'Acquire CCGC enterprise broker token',
    value: 'CCGC.Invoke',
  },
];
const roles = [
  ...(applicationDetails.appRoles ?? []).filter(role =>
    role.value !== 'CCGC.Access' && role.value !== 'CCGC.Admin'),
  {
    id: roleId,
    allowedMemberTypes: ['User'],
    description: 'Allows an assigned employee to access the CCGC enterprise broker.',
    displayName: 'CCGC Access',
    isEnabled: true,
    value: 'CCGC.Access',
  },
  {
    id: adminRoleId,
    allowedMemberTypes: ['User', 'Application'],
    description: 'Allows an assigned enterprise IT administrator or approved automation identity to operate the CCGC control plane.',
    displayName: 'CCGC Administrator',
    isEnabled: true,
    value: 'CCGC.Admin',
  },
];
const preAuthorizedApplications = [
  ...(applicationDetails.api?.preAuthorizedApplications ?? [])
    .filter(client => client.appId !== azureCliAppId && client.appId !== application.appId),
  {
    appId: azureCliAppId,
    delegatedPermissionIds: [scopeId],
  },
  {
    appId: application.appId,
    delegatedPermissionIds: [scopeId],
  },
];

graph('PATCH', `/applications/${application.id}`, {
  identifierUris: [...new Set([...(applicationDetails.identifierUris ?? []), audience])],
  api: {
    requestedAccessTokenVersion: 2,
    oauth2PermissionScopes: scopes,
  },
  spa: {
    redirectUris: [...new Set([
      ...(applicationDetails.spa?.redirectUris ?? []),
      adminPortalRedirect.href,
    ])],
  },
  appRoles: roles,
});

let scopeAvailable = false;
for (let attempt = 0; attempt < 10; attempt += 1) {
  const current = graph('GET', `/applications/${application.id}?$select=api`);
  scopeAvailable = (current.api?.oauth2PermissionScopes ?? [])
    .some(scope => scope.id === scopeId && scope.value === 'CCGC.Invoke' && scope.isEnabled === true);
  if (scopeAvailable) break;
  sleep(2000);
}
if (!scopeAvailable) fail('The CCGC.Invoke delegated permission did not propagate to the app registration.');
graph('PATCH', `/applications/${application.id}`, {
  api: {
    requestedAccessTokenVersion: 2,
    oauth2PermissionScopes: scopes,
    preAuthorizedApplications,
  },
});

let servicePrincipal = runAz([
  'ad', 'sp', 'show',
  '--id', application.appId,
  '--output', 'json',
], { allowFailure: true });
if (!servicePrincipal) {
  runAz(['ad', 'sp', 'create', '--id', application.appId, '--output', 'json']);
  servicePrincipal = runAz([
    'ad', 'sp', 'show',
    '--id', application.appId,
    '--output', 'json',
  ]);
}
graph('PATCH', `/servicePrincipals/${servicePrincipal.id}`, {
  appRoleAssignmentRequired: true,
});

let roleAvailable = false;
for (let attempt = 0; attempt < 10; attempt += 1) {
  const current = graph('GET', `/servicePrincipals/${servicePrincipal.id}`);
  const currentRoleIds = new Set((current.appRoles ?? []).map(role => role.id));
  roleAvailable = currentRoleIds.has(roleId) && currentRoleIds.has(adminRoleId);
  if (roleAvailable) break;
  sleep(2000);
}
if (!roleAvailable) fail('The CCGC.Access and CCGC.Admin app roles did not propagate to the Enterprise Application.');

for (const assignment of [
  { principalId: pilotGroupObjectId, roleId },
  { principalId: adminGroupObjectId, roleId: adminRoleId },
]) {
  const assignments = graph(
    'GET',
    `/groups/${assignment.principalId}/appRoleAssignments`,
  );
  if (assignments.value.some(current =>
    current.resourceId === servicePrincipal.id && current.appRoleId === assignment.roleId)) continue;
  graph('POST', `/groups/${assignment.principalId}/appRoleAssignments`, {
    principalId: assignment.principalId,
    resourceId: servicePrincipal.id,
    appRoleId: assignment.roleId,
  });
}

console.log(JSON.stringify({
  tenantId,
  applicationObjectId: application.id,
  applicationClientId: application.appId,
  servicePrincipalObjectId: servicePrincipal.id,
  audience,
  delegatedTokenScope: 'CCGC.Invoke',
  employeeRequiredPermission: 'CCGC.Access',
  administratorRequiredPermission: 'CCGC.Admin',
  administratorPortalRedirectUri: adminPortalRedirect.href,
  pilotGroupObjectId,
  pilotGroupDisplayName: pilotGroup.displayName,
  adminGroupObjectId,
  adminGroupDisplayName: adminGroup.displayName,
  assignmentRequired: true,
  employeeCredentialSource: 'Azure CLI through DefaultAzureCredential',
}, null, 2));
