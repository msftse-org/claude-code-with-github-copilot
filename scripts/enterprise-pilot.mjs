#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, { json = false, cwd = process.cwd() } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    fail(result.stderr.trim() || `${command} ${args.join(' ')} failed.`);
  }
  const value = result.stdout.trim();
  if (!json || !value) return value;
  try {
    return JSON.parse(value);
  } catch {
    const objectStart = value.indexOf('{');
    const arrayStart = value.indexOf('[');
    const starts = [objectStart, arrayStart].filter(index => index >= 0);
    if (starts.length === 0) fail(`${command} did not return JSON.`);
    return JSON.parse(value.slice(Math.min(...starts)));
  }
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

function parameters(path) {
  const document = JSON.parse(readFileSync(path, 'utf8'));
  const values = {};
  for (const [name, entry] of Object.entries(document.parameters ?? {})) {
    values[name] = entry.value;
  }
  return values;
}

function deploymentArgs(action, deploymentName, location, parameterPath, overrides) {
  const args = [
    'deployment', 'sub', action,
    '--name', deploymentName,
    '--location', location,
    '--template-file', 'infra/enterprise/main.bicep',
    '--parameters', `@${parameterPath}`,
  ];
  for (const [name, value] of Object.entries(overrides)) {
    args.push(`${name}=${value}`);
  }
  if (action === 'what-if') args.push('--no-pretty-print');
  args.push('--output', 'json');
  return args;
}

const command = process.argv[2];
if (!['foundation', 'images', 'runtime'].includes(command)) {
  fail(`Usage:
  node scripts/enterprise-pilot.mjs foundation --parameters /private/enterprise.parameters.json [--confirm-deploy]
  node scripts/enterprise-pilot.mjs images --parameters /private/enterprise.parameters.json
  node scripts/enterprise-pilot.mjs runtime --parameters /private/enterprise.parameters.json --images .azure/enterprise-images.<sha>.json [--confirm-deploy]`);
}

const root = resolve(import.meta.dirname, '..');
const parameterPath = resolve(option('--parameters') ?? '');
if (!option('--parameters')) fail('--parameters is required.');
const parameterStat = lstatSync(parameterPath);
if (!parameterStat.isFile() || parameterStat.isSymbolicLink()
  || (process.getuid && parameterStat.uid !== process.getuid())
  || (parameterStat.mode & 0o077) !== 0) {
  fail('The deployment parameter file must be a non-symlink regular file owned by you with mode 0600.');
}
const configured = parameters(parameterPath);
const prefix = configured.prefix;
const litellmMode = configured.litellmMode ?? 'managed';
const location = option('--location') ?? configured.location ?? 'swedencentral';
if (!prefix || !/^[a-z0-9-]{3,18}$/.test(prefix)) fail('The parameter file must contain a valid prefix.');
if (!['managed', 'existing'].includes(litellmMode)) fail('litellmMode must be managed or existing.');
if (litellmMode === 'existing') {
  try {
    const existing = new URL(configured.existingLiteLLMUrl);
    if (existing.protocol !== 'https:' || existing.username || existing.password
      || existing.pathname !== '/' || existing.search || existing.hash) {
      throw new Error();
    }
  } catch {
    fail('existingLiteLLMUrl must be a fixed HTTPS origin when litellmMode is existing.');
  }
  if (!/^[0-9a-f-]{36}$/i.test(configured.existingLiteLLMPrincipalId ?? '')
    || !/^[A-Za-z0-9-]{1,128}$/.test(configured.existingLiteLLMDatabasePrincipalName ?? '')) {
    fail('Existing LiteLLM workload identity and database principal settings are required.');
  }
}
const foundationName = `${prefix}-enterprise-foundation`;

if (command === 'foundation') {
  const action = has('--confirm-deploy') ? 'create' : 'what-if';
  const result = run('az', deploymentArgs(
    action,
    foundationName,
    location,
    parameterPath,
    {
      deployRuntime: false,
      brokerImage: '',
      workerImage: '',
      litellmImage: '',
      buildAgentPoolCount: 1,
    },
  ), { json: true, cwd: root });
  console.log(JSON.stringify(result, null, 2));
  if (!has('--confirm-deploy')) {
    console.error('Foundation what-if completed. Re-run with --confirm-deploy only after reviewing the changes and cost.');
  }
  process.exit(0);
}

const foundation = run('az', [
  'deployment', 'sub', 'show',
  '--name', foundationName,
  '--output', 'json',
], { json: true, cwd: root });
const outputs = foundation.properties?.outputs ?? {};
const registryName = outputs.registryName?.value;
const registryLoginServer = outputs.registryLoginServer?.value;
const buildAgentPoolName = outputs.buildAgentPoolName?.value;
if (!registryName || !registryLoginServer || !buildAgentPoolName) {
  fail(`Foundation deployment ${foundationName} does not expose the expected registry outputs.`);
}

if (command === 'images') {
  const gitSha = run('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root });
  const images = [
    ['broker', 'ccgc-enterprise-broker', 'server/Dockerfile.enterprise'],
    ...(litellmMode === 'managed'
      ? [['litellm', 'ccgc-enterprise-litellm', 'server/Dockerfile.enterprise-litellm']]
      : []),
  ];
  let cleanupAgentPool = true;
  process.on('exit', () => {
    if (!cleanupAgentPool) return;
    spawnSync('az', [
      'acr', 'agentpool', 'delete',
      '--registry', registryName,
      '--name', buildAgentPoolName,
      '--yes',
      '--output', 'none',
    ], { cwd: root, stdio: 'ignore' });
  });
  try {
    const published = {};
    for (const [key, repository, dockerfile] of images) {
      const build = run('az', [
        'acr', 'build',
        '--registry', registryName,
        '--agent-pool', buildAgentPoolName,
        '--image', `${repository}:${gitSha}`,
        '--file', dockerfile,
        '.',
        '--no-logs',
        '--output', 'json',
      ], { json: true, cwd: root });
      const outputImage = build.outputImages?.find(image =>
        image.registry === registryLoginServer
        && image.repository === repository
        && image.tag === gitSha);
      const digest = outputImage?.digest;
      if (!/^sha256:[a-f0-9]{64}$/.test(digest)) fail(`ACR returned an invalid digest for ${repository}.`);
      published[`${key}Image`] = `${registryLoginServer}/${repository}@${digest}`;
    }
    mkdirSync(resolve(root, '.azure'), { recursive: true, mode: 0o700 });
    const outputPath = resolve(root, `.azure/enterprise-images.${gitSha}.json`);
    writeFileSync(outputPath, `${JSON.stringify({
      gitSha,
      registryName,
      registryLoginServer,
      ...published,
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(outputPath);
  } finally {
    run('az', [
      'acr', 'agentpool', 'delete',
      '--registry', registryName,
      '--name', buildAgentPoolName,
      '--yes',
      '--output', 'none',
    ], { cwd: root });
    cleanupAgentPool = false;
  }
  process.exit(0);
}

const imagePath = option('--images');
if (!imagePath) fail('--images is required for runtime deployment.');
const imageDocument = JSON.parse(readFileSync(resolve(imagePath), 'utf8'));
for (const name of [
  'brokerImage',
  ...(litellmMode === 'managed' ? ['litellmImage'] : []),
]) {
  if (!new RegExp(`^${registryLoginServer.replaceAll('.', '\\.')}\\/[^@]+@sha256:[a-f0-9]{64}$`).test(imageDocument[name] ?? '')) {
    fail(`${name} must be an immutable digest in ${registryLoginServer}.`);
  }
}
const action = has('--confirm-deploy') ? 'create' : 'what-if';
const result = run('az', deploymentArgs(
  action,
  `${prefix}-enterprise-runtime`,
  location,
  parameterPath,
  {
    deployRuntime: true,
    brokerImage: imageDocument.brokerImage,
    workerImage: '',
    deployLegacyWorker: false,
    litellmImage: litellmMode === 'managed' ? imageDocument.litellmImage : '',
    buildAgentPoolCount: 0,
  },
), { json: true, cwd: root });
console.log(JSON.stringify(result, null, 2));
if (!has('--confirm-deploy')) {
  console.error('Runtime what-if completed. Re-run with --confirm-deploy only after reviewing the changes and cost.');
  process.exit(0);
}

const bootstrapJobName = result.properties?.outputs?.bootstrapJobName?.value;
const resourceGroupName = result.properties?.outputs?.resourceGroupName?.value;
if (!bootstrapJobName || !resourceGroupName) {
  fail('Runtime deployment did not expose the bootstrap job and resource group outputs.');
}
run('az', [
  'containerapp', 'job', 'start',
  '--name', bootstrapJobName,
  '--resource-group', resourceGroupName,
  '--output', 'none',
], { cwd: root });

const bootstrapDeadline = Date.now() + 15 * 60 * 1000;
while (Date.now() < bootstrapDeadline) {
  const execution = run('az', [
    'containerapp', 'job', 'execution', 'list',
    '--name', bootstrapJobName,
    '--resource-group', resourceGroupName,
    '--query', 'sort_by(@,&properties.startTime)[-1]',
    '--output', 'json',
  ], { json: true, cwd: root });
  const status = execution?.properties?.status;
  if (status === 'Succeeded') {
    console.error(`Bootstrap job ${bootstrapJobName} completed successfully.`);
    process.exit(0);
  }
  if (status === 'Failed') fail(`Bootstrap job ${bootstrapJobName} failed.`);
  sleep(10_000);
}
fail(`Bootstrap job ${bootstrapJobName} did not complete within 15 minutes.`);
