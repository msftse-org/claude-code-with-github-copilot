# CCGC administrator panel

The broker serves this dependency-free panel at `/ccgc/admin`. Every
administration API request uses an Entra bearer token and the broker continues
to require the `CCGC.Admin` app role.

## Browser authentication

`auth.js` implements the Microsoft Entra authorization-code flow with PKCE:

1. Fetch `GET /ccgc/admin/config`.
2. Generate a cryptographic verifier, S256 challenge, and state value.
3. Redirect to the tenant-specific Microsoft identity platform authorize
   endpoint with scopes `openid profile <configured-scope>`.
4. Validate the returned state and exchange the code at the tenant-specific
   token endpoint using the exact configured redirect URI.
5. Keep the access token only in JavaScript memory.

Only the short-lived PKCE verifier, state value, and return marker are placed in
`sessionStorage` across the redirect. Access tokens, ID tokens, and refresh
tokens are never written to browser storage, cookies, URLs, or logs. Callback
parameters are removed with `history.replaceState`.

The adapter automatically starts a new sign-in after its in-memory token
expires. Local sign-out clears the token, parsed identity claims, and unfinished
PKCE state without invoking a provider logout redirect.

The Entra application registration must include:

- SPA redirect URI `https://<broker-host>/ccgc/admin`
- assignment required
- `CCGC.Admin` assigned only to the administrator group
- delegated scope `api://<client-id>/CCGC.Invoke`
- tenant-restricted authority using `CCGC_ENTRA_TENANT_ID`

The broker returns the required public values from `/ccgc/admin/config` and
allows browser-originated administration calls only when `Origin` exactly
matches `CCGC_BROKER_ORIGIN`.

## Access inventory

`POST /ccgc/admin/access/query` accepts:

```json
{
  "limit": 25,
  "cursor": "optional-binding-object-id"
}
```

The panel renders bindings, allowed models, binding state, API-key metadata,
recent enrollment state, and cursor pagination. Revocation actions prefill only
the public tenant, object, or API-key identifiers and still require evidence
plus typed confirmation.

The response must not include LiteLLM keys, enterprise API-key values,
credential secret names, token hashes, evidence text, enrollment codes, or code
hashes. The current backend contract satisfies that boundary.

## Enrollment handling

The preferred onboarding form uses `POST /ccgc/admin/enrollments`. It never
requests or displays a LiteLLM key. Administrators provide only the employee
email and expected GitHub username; tenant, alias, immutable GitHub account ID,
and allowed models are resolved by the backend enrollment workflow. The
returned CCGC enrollment code is held only in current page memory and is
cleared on refresh or sign-out. Employee handoff instructions use the tracked
`scripts/ccgc-enterprise-macos.sh` workflow.

Enrollment is not repeated for routine control-plane, LiteLLM, model-catalog,
helper, or Claude Code updates. Administrators create a replacement enrollment
only for a new workstation/profile, expired or revoked credentials,
intentional identity rebinding, unrecoverable local credential loss, or an
approved migration that explicitly requires replacement credentials.
