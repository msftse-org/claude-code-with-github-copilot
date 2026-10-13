import assert from 'node:assert/strict';
import test from 'node:test';
import { entraJwksUrl, hasEnterpriseRole } from '../src/enterprise-auth.ts';

test('enterprise token verification uses the tenant signing-key endpoint', () => {
  assert.equal(
    entraJwksUrl('2e1ff9b6-0978-4e17-84c5-b55ad1f6041d').href,
    'https://login.microsoftonline.com/2e1ff9b6-0978-4e17-84c5-b55ad1f6041d/discovery/v2.0/keys',
  );
});

test('enterprise authorization requires the assigned app role', () => {
  assert.equal(hasEnterpriseRole({ roles: ['CCGC.Access'] }, 'CCGC.Access'), true);
  assert.equal(hasEnterpriseRole({ roles: ['CCGC.Admin'] }, 'CCGC.Access'), false);
  assert.equal(hasEnterpriseRole({ roles: ['CCGC.Access'] }, 'CCGC.Admin'), false);
  assert.equal(hasEnterpriseRole({ roles: ['CCGC.Admin'] }, 'CCGC.Admin'), true);
});

test('a delegated scope cannot substitute for an enterprise app role', () => {
  assert.equal(hasEnterpriseRole({ scp: 'CCGC.Access' }, 'CCGC.Access'), false);
  assert.equal(hasEnterpriseRole({ roles: 'CCGC.Access' }, 'CCGC.Access'), false);
  assert.equal(hasEnterpriseRole({ roles: ['CCGC.Invoke'] }, 'CCGC.Access'), false);
});
