import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DualEnterpriseAuthenticator,
  entraJwksUrl,
  hasEnterpriseRole,
  type EnterpriseAuthenticator,
} from '../src/enterprise-auth.ts';

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

test('employee authentication routes only ccgc API keys to the API-key resolver', async () => {
  const calls: string[] = [];
  const entra: EnterpriseAuthenticator = {
    async authenticate(token) {
      calls.push(`entra:${token}`);
      return {
        tenantId: '11111111-1111-1111-1111-111111111111',
        objectId: '22222222-2222-2222-2222-222222222222',
        subject: 'entra',
        authentication: 'entra',
      };
    },
  };
  const authenticator = new DualEnterpriseAuthenticator(entra, {
    async authenticateApiKey(token) {
      calls.push(`api:${token}`);
      return {
        tenantId: '11111111-1111-1111-1111-111111111111',
        objectId: '33333333-3333-3333-3333-333333333333',
        subject: 'api-key',
        authentication: 'apiKey',
      };
    },
  });
  assert.equal((await authenticator.authenticate('jwt.header.signature')).authentication, 'entra');
  assert.equal((await authenticator.authenticate(`ccgc_sk_${'a'.repeat(43)}`)).authentication, 'apiKey');
  assert.deepEqual(calls, [
    'entra:jwt.header.signature',
    `api:ccgc_sk_${'a'.repeat(43)}`,
  ]);
});
