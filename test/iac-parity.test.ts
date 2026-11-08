import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { parseOptions } from '../scripts/deploy.mjs';

// Bicep and Terraform must deploy the same solution: same Azure resources at the same
// API versions, same defaults, same outputs, and settings only from infra/solution.json.
const infra = join(import.meta.dirname, '..', 'infra');
const terraformDirectory = join(infra, 'terraform');

async function bicepSource() {
  return (await Promise.all(['main.bicep', join('modules', 'litellm.bicep')]
    .map(file => readFile(join(infra, file), 'utf8')))).join('\n');
}

async function terraformSource() {
  const files = (await readdir(terraformDirectory)).filter(file => file.endsWith('.tf')).sort();
  return (await Promise.all(files.map(file => readFile(join(terraformDirectory, file), 'utf8')))).join('\n');
}

function block(source: string, header: string) {
  const start = source.indexOf(`${header} {`);
  assert.notEqual(start, -1, `${header} is missing`);
  return source.slice(start, source.indexOf('\n}\n', start));
}

test('Bicep and Terraform deploy the same Azure resource types at the same API versions', async () => {
  const bicep = [...(await bicepSource()).matchAll(/^resource \w+ '([^']+)' =/gm)].map(match => match[1]).sort();
  const terraform = await terraformSource();
  const resources = [...terraform.matchAll(/^resource "(\w+)" "\w+" \{/gm)];
  assert.ok(resources.every(match => match[1] === 'azapi_resource'), 'Terraform must use only azapi_resource, like Bicep uses ARM');
  const types = resources.map(match => block(terraform, match[0].slice(0, -2)).match(/^\s+type\s+= "([^"]+)"/m)?.[1]).sort();
  assert.ok(bicep.length > 20);
  assert.deepEqual(types, bicep);
});

test('Bicep, Terraform, and deploy.mjs share defaults, outputs, and solution settings', async () => {
  const main = await readFile(join(infra, 'main.bicep'), 'utf8');
  const variables = await readFile(join(terraformDirectory, 'variables.tf'), 'utf8');
  const bicepDefault = (name: string) => main.match(new RegExp(`^param ${name} string = '([^']*)'`, 'm'))?.[1];
  const terraformDefault = (name: string) => block(variables, `variable "${name}"`).match(/^\s+default\s+= "([^"]*)"/m)?.[1];
  const options = parseOptions(['--subscription', '00000000-0000-4000-8000-000000000001']);
  assert.ok(!('help' in options));
  const defaults = { prefix: options.prefix, location: options.location, nameSeed: options.nameSeed };
  assert.deepEqual({ prefix: bicepDefault('prefix'), location: bicepDefault('location'), nameSeed: bicepDefault('nameSeed') }, defaults);
  assert.deepEqual({
    prefix: terraformDefault('prefix'),
    location: terraformDefault('location'),
    nameSeed: terraformDefault('name_seed'),
  }, defaults);

  const bicepOutputs = [...main.matchAll(/^output (\w+) /gm)]
    .map(match => match[1]!.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)).sort();
  const terraformOutputs = [...(await readFile(join(terraformDirectory, 'outputs.tf'), 'utf8')).matchAll(/^output "(\w+)"/gm)]
    .map(match => match[1]).sort();
  assert.deepEqual(terraformOutputs, bicepOutputs);

  const settings = JSON.parse(await readFile(join(infra, 'solution.json'), 'utf8'));
  assert.match(settings.litellm.image, /^ghcr\.io\/berriai\/litellm:v[\d.]+@sha256:[0-9a-f]{64}$/);
  for (const source of [await bicepSource(), await terraformSource()]) assert.equal(source.includes('ghcr.io/'), false);
});
