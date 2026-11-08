#!/usr/bin/env node
// Creates the Entra identity that the "CCGC employee access" GitHub Actions
// workflow uses through OIDC. The identity has no secret and no Azure RBAC; its
// only permission is the CCGC.Admin app role on the broker API.
import { spawnSync } from 'node:child_process';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, { json = true, allowFailure = false, input } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    if (allowFailure) return null;
    fail(result.stderr.trim() || `${command} ${args[0]} failed.`);
  }
  const value = result.stdout.trim();
  if (!json) return value;
  return value ? JSON.parse(value) : null;
}

const az = (args, options) => run('az', [...args, '--output', 'json'], options);

function graph(method, path, body) {
  const args = ['rest', '--method', method, '--url', `https://graph.microsoft.com/v1.0${path}`];
  if (body !== undefined) args.push('--headers', 'Content-Type=application/json', '--body', JSON.stringify(body));
  return az(args);
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

function single(displayName, create) {
  const applications = az(['ad', 'app', 'list', '--filter', `displayName eq '${displayName.replaceAll("'", "''")}'`]);
  if (applications.length > 1) fail(`Multiple app registrations are named ${displayName}.`);
  if (applications.length === 1) return applications[0];
  if (!create) fail(`App registration ${displayName} was not found. Run scripts/enterprise-entra.mjs first.`);
  return az(['ad', 'app', 'create', '--display-name', displayName, '--sign-in-audience', 'AzureADMyOrg']);
}

function servicePrincipal(appId) {
  const existing = az(['ad', 'sp', 'show', '--id', appId], { allowFailure: true });
  if (existing) return existing;
  az(['ad', 'sp', 'create', '--id', appId]);
  return az(['ad', 'sp', 'show', '--id', appId]);
}

const repository = option('--repository');
const environment = option('--environment') ?? 'ccgc-admin';
const branch = option('--branch') ?? 'main';
const brokerUrl = option('--broker-url');
const apiDisplayName = option('--api-display-name') ?? 'CCGC Enterprise API';
const displayName = option('--display-name') ?? 'CCGC Employee Access Automation';
const configureGitHub = has('--configure-github');
const subjectOverride = option('--subject');

// GitHub repositories can emit name-based or immutable (owner/repository ID)
// OIDC subjects; the federated credential must match the one actually emitted.
function githubSubject() {
  const settings = run('gh', ['api', `repos/${repository}/actions/oidc/customization/sub`], { allowFailure: true });
  if (!settings) fail('Could not read the repository OIDC subject settings with gh. Pass --subject explicitly.');
  if (settings.use_default === false) {
    fail('The repository uses a custom OIDC subject template. Pass the exact environment subject with --subject.');
  }
  let prefix = settings.sub_claim_prefix;
  if (!prefix && settings.use_immutable_subject) {
    const details = run('gh', ['api', `repos/${repository}`]);
    prefix = `repo:${details.owner.login}@${details.owner.id}/${details.name}@${details.id}`;
  }
  return `${prefix ?? `repo:${repository}`}:environment:${environment}`;
}

if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  fail('Use --repository OWNER/REPOSITORY for the repository that runs the employee access workflow.');
}
if (!/^[A-Za-z0-9_.-]{1,100}$/.test(environment)) fail('Use --environment with a simple GitHub environment name.');
if (!/^[A-Za-z0-9_./-]{1,200}$/.test(branch)) fail('Use --branch with the protected branch allowed to run the workflow.');
if (!brokerUrl || !/^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?\/?$/.test(brokerUrl)) {
  fail('Use --broker-url with the public broker HTTPS origin, for example https://broker.example.com.');
}
if (subjectOverride !== undefined && !/^repo:[^\s:]+:environment:[A-Za-z0-9_.-]+$/.test(subjectOverride)) {
  fail('Use --subject in the form repo:...:environment:NAME.');
}
if (!has('--confirm-entra-changes')) {
  fail('Add --confirm-entra-changes after reviewing the tenant, repository, and environment. This grants the workflow CCGC.Admin.');
}

const { tenantId } = az(['account', 'show']);
const apiApplication = single(apiDisplayName, false);
const apiDetails = graph('GET', `/applications/${apiApplication.id}`);
const adminRole = (apiDetails.appRoles ?? []).find(role => role.value === 'CCGC.Admin' && role.isEnabled);
if (!adminRole) fail('The broker API has no enabled CCGC.Admin app role. Run scripts/enterprise-entra.mjs first.');
if (!adminRole.allowedMemberTypes.includes('Application')) {
  graph('PATCH', `/applications/${apiApplication.id}`, {
    appRoles: apiDetails.appRoles.map(role => role.id === adminRole.id
      ? { ...role, allowedMemberTypes: [...new Set([...role.allowedMemberTypes, 'Application'])] }
      : role),
  });
}
const apiServicePrincipal = servicePrincipal(apiApplication.appId);

const automation = single(displayName, true);
const automationServicePrincipal = servicePrincipal(automation.appId);

const issuer = 'https://token.actions.githubusercontent.com';
const subject = subjectOverride ?? githubSubject();
const credentials = graph('GET', `/applications/${automation.id}/federatedIdentityCredentials`).value ?? [];
if (!credentials.some(credential => credential.issuer === issuer && credential.subject === subject)) {
  const name = `github-${repository}-${environment}`.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 120);
  if (credentials.some(credential => credential.name === name)) {
    fail(`Federated credential ${name} exists with a different subject. Review it in Entra before rerunning.`);
  }
  graph('POST', `/applications/${automation.id}/federatedIdentityCredentials`, {
    name,
    issuer,
    subject,
    audiences: ['api://AzureADTokenExchange'],
    description: `GitHub Actions environment ${environment} in ${repository} for CCGC employee access.`,
  });
}

let assigned = false;
for (let attempt = 0; attempt < 15 && !assigned; attempt += 1) {
  const resource = graph('GET', `/servicePrincipals/${apiServicePrincipal.id}?$select=appRoles`);
  const role = (resource.appRoles ?? []).find(current => current.id === adminRole.id);
  if (!role?.allowedMemberTypes?.includes('Application')) {
    sleep(2000);
    continue;
  }
  const assignments = graph('GET', `/servicePrincipals/${automationServicePrincipal.id}/appRoleAssignments`).value ?? [];
  if (!assignments.some(current => current.resourceId === apiServicePrincipal.id && current.appRoleId === adminRole.id)) {
    graph('POST', `/servicePrincipals/${automationServicePrincipal.id}/appRoleAssignments`, {
      principalId: automationServicePrincipal.id,
      resourceId: apiServicePrincipal.id,
      appRoleId: adminRole.id,
    });
  }
  assigned = true;
}
if (!assigned) fail('The CCGC.Admin application role did not propagate to the broker Enterprise Application. Rerun shortly.');

const variables = {
  AZURE_CLIENT_ID: automation.appId,
  AZURE_TENANT_ID: tenantId,
  CCGC_ADMIN_AUDIENCE: `api://${apiApplication.appId}`,
  CCGC_BROKER_URL: brokerUrl.replace(/\/$/, ''),
};

if (configureGitHub) {
  const gh = (args, options) => run('gh', args, options);
  const current = gh(['api', `repos/${repository}/environments/${environment}`], { allowFailure: true });
  const reviewers = (current?.protection_rules ?? [])
    .filter(rule => rule.type === 'required_reviewers')
    .flatMap(rule => rule.reviewers ?? [])
    .map(reviewer => ({ type: reviewer.type, id: reviewer.reviewer.id }));
  const waitTimer = (current?.protection_rules ?? []).find(rule => rule.type === 'wait_timer')?.wait_timer ?? 0;
  gh(['api', '--method', 'PUT', `repos/${repository}/environments/${environment}`, '--input', '-'], {
    input: JSON.stringify({
      wait_timer: waitTimer,
      reviewers,
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    }),
  });
  const policies = gh(['api', `repos/${repository}/environments/${environment}/deployment-branch-policies`]);
  if (!(policies.branch_policies ?? []).some(policy => policy.name === branch && (policy.type ?? 'branch') === 'branch')) {
    gh(['api', '--method', 'POST', `repos/${repository}/environments/${environment}/deployment-branch-policies`,
      '-f', `name=${branch}`, '-f', 'type=branch']);
  }
  for (const [name, value] of Object.entries(variables)) {
    gh(['variable', 'set', name, '--repo', repository, '--env', environment, '--body', value], { json: false });
  }
}

console.log(JSON.stringify({
  tenantId,
  automationApplicationClientId: automation.appId,
  automationServicePrincipalObjectId: automationServicePrincipal.id,
  federatedCredentialSubject: subject,
  brokerApplicationClientId: apiApplication.appId,
  grantedAppRole: 'CCGC.Admin',
  azureRoleAssignments: 'none',
  githubEnvironment: environment,
  allowedBranch: branch,
  githubConfigured: configureGitHub,
  environmentVariables: variables,
}, null, 2));
