# Add CCGC to an existing LiteLLM

This overlay preserves the customer's existing LiteLLM models, virtual keys,
teams, budgets, callbacks, and database. It adds only the CCGC authentication
extension.

1. Build from the exact LiteLLM image already approved by the customer:

   ```bash
   docker build \
     --build-arg LITELLM_IMAGE=customer-registry/litellm@sha256:APPROVED_DIGEST \
     -f deploy/existing-litellm/Dockerfile \
     -t customer-registry/litellm-ccgc:VERSION .
   ```

2. Merge `config.patch.yaml` into the existing LiteLLM configuration.
3. Configure the variables in `environment.example` through the customer's
   secret and workload-identity mechanism.
4. Grant the LiteLLM workload identity read access to CCGC employee secrets and
   database access to the single customer's CCGC schema.
5. Run the standard CCGC bootstrap reconciliation against the existing
   LiteLLM URL. The operation is idempotent and creates only the namespaced
   GitHub Copilot credential, Claude model groups, users, and virtual keys
   managed by CCGC.

`custom_auth_settings.mode: auto` is required. It allows existing LiteLLM keys
to continue through normal LiteLLM authentication while CCGC Entra tokens,
employee API keys, and bounded admission tokens are resolved through the
single-tenant Entra-to-GitHub binding.

Applying or upgrading this overlay must preserve the CCGC PostgreSQL schema,
Key Vault employee secrets, LiteLLM users/virtual keys, encrypted GitHub
connections, and control-plane bindings. Run bootstrap reconciliation after
the rollout, but do not issue new employee enrollment codes merely because the
overlay or underlying LiteLLM image changed. Existing employees verify with
their installed helper; re-enrollment is reserved for explicit credential,
identity, workstation, or migration recovery.
