# PRD: Claude Code with GitHub Copilot

| Field | Value |
|---|---|
| Project | `claude-code-with-github-copilot` |
| Revision | 0.22 - single-tenant central LiteLLM |
| Created / revised | 2026-10-04 / 2026-11-01 |
| Status | Central-LiteLLM migration deployed and validated in the Sweden Central enterprise pilot; production release gates remain open |
| Working name / command | Copilot Gateway for Claude Code / ordinary Claude client, with optional `ccgc` setup and diagnostics |
| Initial platform | macOS on Apple silicon |
| Product decision owner | Project owner |

## 1. Product decision

### Enterprise implementation (revision 0.22)

Revision 0.22 defines one deployment as exactly one customer and one Microsoft
Entra tenant. LiteLLM becomes the central inference gateway rather than a
private connector behind a project broker and worker.

The CCGC LiteLLM custom-auth extension accepts three CCGC credential forms:
single-tenant Entra JWTs, revocable employee API keys, and bounded admission
tokens. It resolves the active `(tenant ID, Entra object ID)` binding, verifies
the bound immutable GitHub numeric account ID against the Key Vault secret, and
returns only that employee's existing LiteLLM virtual key. LiteLLM then applies
its normal user/team/model/budget policy and selects the same user's encrypted
GitHub Copilot connection. Ordinary customer LiteLLM keys continue through
normal authentication in custom-auth `auto` mode.

The project control plane remains for enrollment, revocation, administration,
admission issuance, and idempotent model/user reconciliation. It is not in the
inference data path. The legacy broker-to-worker path is disabled by default and
retained only for an explicit migration rollback.

Employee enrollment is durable lifecycle state, not a per-release installation
step. Routine control-plane, LiteLLM, model-catalog, helper, and Claude Code
updates must preserve the active employee binding, GitHub connection, employee
credential, and workstation profile. Re-enrollment is permitted only for a new
workstation/profile, credential expiry or revocation, intentional identity
rebind, unrecoverable local credential loss, or an approved migration whose
rollout explicitly revokes and replaces existing credentials.

The deployment supports two modes:

1. `managed` deploys the complete CCGC-enabled LiteLLM, one PostgreSQL Flexible
   Server with separate `ccgc` and `litellm` schemas, Key Vault, monitoring,
   control plane, and bootstrap job.
2. `existing` deploys CCGC control resources and attaches to one fixed customer
   LiteLLM origin and workload identity. The additive overlay preserves existing
   models, keys, teams, budgets, callbacks, scaling, and unrelated workloads.

The managed schemas have separate responsibilities and connection paths:
CCGC services use Entra-authenticated connections with `search_path=ccgc`;
LiteLLM uses its Prisma connection with `schema=litellm`. Existing-LiteLLM mode
does not move the customer's LiteLLM data and retains a separate CCGC server.

API Management remains unnecessary because LiteLLM is already the customer's
inference and policy gateway. Release remains blocked on controlled deployment,
two-user live isolation, existing-LiteLLM compatibility across approved
versions, revoked-seat behavior, long SSE, scale-out/draining, license review,
and zero-delete infrastructure review.

### Superseded enterprise implementation (revision 0.21, historical)

Revision 0.21 used one public broker, an internal shared worker, and an internal
LiteLLM Gateway. It introduced LiteLLM per-user GitHub OAuth but kept project
dispatch signing, worker forwarding, encrypted branch checkpoints, and separate
inference routing. Revision 0.22 supersedes that runtime to remove redundant
inference components while preserving the enrollment and immutable identity
contract.

### Superseded enterprise implementation (revision 0.20, historical)

Revision 0.20 replaces the per-user worker/LiteLLM target with a horizontally
scaled, shared multi-user Container Apps worker fleet. Microsoft Entra JWT
validation, immutable tenant/object-to-GitHub bindings, opaque bounded
admissions, PostgreSQL reservation/fencing, and the audit outbox remain.
The broker now signs 60-second dispatch assertions binding the principal,
binding revision, GitHub account, credential reference, admission, branch,
model, fence, and dispatch ID.

Any worker replica can verify that assertion, select an account-keyed native
Copilot connector, and restore the encrypted branch checkpoint from private Blob
Storage. Connector objects never share OAuth credentials, Copilot token caches,
or refresh locks. PostgreSQL and worker limits enforce per-user fairness before
global capacity. Blob ETags reject stale checkpoint writers. This removes sticky
session and one-container-per-user requirements while preserving one employee
Copilot seat per binding.

The revision 0.20 decision was superseded by revision 0.21. At that point,
LiteLLM remained only in the retained single-user proof. Its process-wide GitHub
Copilot credential directory is not suitable for many users in one worker
process. The enterprise connector is now based on the repository's native
`CopilotBackend`, extended with Key Vault credential resolution and account
scoping. The implementation and remaining gates are in
[ENTERPRISE.md](ENTERPRISE.md).

This revision did not deploy Azure resources, publish images, create an Entra
application, authorize another Copilot account or claim production readiness.
Supported linking/token rotation, private live tests, long-duration Container
Apps SSE, load/soak, replica-failure recovery, signed release, cost review, and
vendor approval remain release gates.

### Enterprise target (revision 0.17)

The owner requested an enterprise-level solution diagram and explicitly separated
provisioning from runtime. This establishes a **proposed internal, multi-employee
target**, not shipped multi-user support or approval to provision it. The actual
gateway, account binding, client settings and single-user IaC remain unchanged.
The older MVP requirements below continue to describe the alpha unless explicitly
identified as target requirements here.

The [runtime architecture](diagrams/ccgc-enterprise-runtime.html) contains only
inference, identity, credentials, durable control state and operations.
The [provisioning workflow](diagrams/ccgc-enterprise-provisioning.html) separately
shows approvals, Bicep/Terraform planning, platform creation, account onboarding,
acceptance and rollout. Both have GPT-image presentation companions in the
[diagram index](diagrams/README.md).

| Target boundary | Proposed design and required invariant |
|---|---|
| Developer machine | Actual unmodified Claude Code, ordinary gateway URL/model discovery and a credential helper. A new enterprise helper acquires gateway-audience Entra access tokens through a supported identity library and browser authorization-code/PKCE sign-in. Its local token cache uses OS-protected storage. Read/Edit/Bash and approvals remain in Claude; there is no local inference proxy or separate agent. This helper is not implemented by the alpha's existing Keychain renewal-key helper. |
| Gateway identity | Entra tenant/issuer/audience/signature/expiry validation plus approved conditional-access policies. Bind immutable `(tenant ID, object ID)` to the same developer's verified immutable GitHub account ID through a short-lived, anti-replay linking transaction. Email matching or a client-supplied account header is insufficient. |
| Authenticated public ingress | Public HTTPS, zone-redundant Azure Container Apps broker. Employees connect over the internet without VPN. The broker validates Entra tenant, issuer, audience, signature, immutable object ID, and `CCGC.Access`; the Enterprise Application requires assignment to the approved employee group. Worker and LiteLLM ingress remain internal, and ingress never supplies a Copilot entitlement. |
| Admission and seat broker | Zone-redundant Azure Container Apps environment with multiple gateway replicas. Recheck principal, link revision, grant, model policy and revocation before dispatch. The gateway-owned catalog is the intersection of organizational policy and that user's live entitlement; no client-side per-model routing table. |
| Copilot workers | Shared Container Apps replicas serve many users, but each request resolves an immutable account-keyed connector. Broker assertions bind every identity and routing field; workers cannot accept caller-selected accounts. Per-user branch/concurrency limits precede global limits. Any turn can land on any replica. |
| Credential custody | Worker managed identity has private Key Vault secret-read access. Long-lived account authorization is stored under the immutable binding reference; each connector owns independent short-lived Copilot token and refresh state. Managed identity accesses Azure resources; it is not Copilot authorization. Supported browser linking, rotation, unlinking, and narrower per-secret authorization remain release gates. |
| Durable controls | Zone-redundant PostgreSQL stores principal/account bindings, admission budgets, active branch reservations, monotonic fences, dispatch outcomes, and audit intent. Private Blob Storage holds client-side-encrypted branch checkpoints; ETags provide conditional writes. This is not a transcript store. |
| Availability and recovery | Healthy replicas can accept new admissions, but an interrupted stream is not transparently resumed. A failed owner retires affected work; uncertain dispatches retain their accounting and are not replayed. Ownership leases require fencing and verified old-owner retirement; a lease alone cannot prevent an old process from making a late external call. Start with one foreground session per user and separately identified auxiliary requests. |
| Operations and governance | Metadata-only Azure Monitor/Application Insights, restricted audit access and retention, alerts for denials, refresh failures, saturation and interrupted streams. Never log authorization headers, prompts, responses or tool bodies. Persist audit intent with control-state changes before export. Reconcile gateway counters with authorized provider reporting where available; counters are not a guaranteed billing cap or authoritative Copilot invoice. |

**Why this baseline:** Container Apps provides managed public HTTPS for the
authenticated broker and internal ingress for the inference plane without
introducing a second API gateway or assuming Kubernetes.
PostgreSQL provides the transactional reservation/fencing model; a cache is not
the source of authorization or accounting truth. This is a logical resource and
trust-boundary diagram, not a claim that managed PaaS services physically execute
inside one subnet. Key Vault is a managed Azure service reached privately.
The telemetry arrow summarizes collection; the body-log prohibition applies to
every hop, not only the drawn gateway emitter.

**Blocking streaming and replay gate:** the Container Apps ingress and broker
must forward SSE immediately, avoid response caching/body logging, and handle
idle keepalives. Container Apps documents a 240-second HTTP request timeout; premium ingress
has a separately configurable idle timeout of 4-30 minutes. Do not infer that
the idle setting removes every total-request limit. Before accepting this compute
choice, test the real pinned Claude native Messages/tool stream beyond the
required duration, including first-token stalls, pings, cancellation, deployment
draining, network failures and zone/owner failure. Account for platform-level
retries as well as SDK/policy retries. A durable dispatch reservation must prevent
duplicate upstream submission; idempotent database/control operations must not
be confused with replay-safe inference. If these conditions cannot be satisfied,
block release and approve a revised compute/ingress design instead of silently
truncating streams, replaying requests or switching providers.

**Separate provisioning contract:** approve integration permission, SLO and costs;
build/test/scan and sign immutable images; plan **one of Bicep or Terraform**;
approve the exact changes; provision private network/DNS, HA data, Entra apps,
managed identities, scoped RBAC and Key Vault; deploy the broker and worker
services; have each user complete their own approved GitHub linking; then perform
isolated acceptance before pilot and release rings. Use federated CI identity,
protected environment approvals, an authenticated private deployment runner and
centrally protected, locked IaC state. Account credentials must never enter IaC
parameters, Terraform state, pipeline output or image layers. Runtime release
rollback requires a known-good compatible image/schema and fresh admissions,
not data deletion or inferred replay; a failed first installation stays blocked.
New enterprise templates, services and tests are **not implemented by this
diagram task** or by the existing `server/deploy.py` VM coordinator.

**Production gates:** explicit permission and support/terms review for this exact
third-party Copilot integration; approved same-user linking mechanism; two-user
cross-access/secret/cancellation isolation tests; disabled-model and revoked-seat
tests; concurrent quota/fencing and duplicate-dispatch fault tests; real-client
all-model tool/streaming acceptance; load/soak and restore drills; no-body-log
canaries; signed release, rollback and operator runbooks. Infrastructure
redundancy cannot make an unsupported access route vendor-supported.

**Open decisions, not assumptions:** user count and concurrency; acceptable
first-token and stream durations; SLO/RTO/RPO; primary and recovery regions/data
residency; corporate connectivity and device policy; retention; per-worker
isolation/capacity; Container Apps and database sizing; budget; and approved
account-linking permissions. Regional DR and upstream inference
residency are not established by this target drawing.

Azure design references fetched on 2026-10-07:

- [Container Apps ingress](https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview),
  [premium ingress settings](https://learn.microsoft.com/en-us/azure/container-apps/ingress-environment-configuration)
  and [reliability](https://learn.microsoft.com/en-us/azure/reliability/reliability-container-apps).
- [PostgreSQL reliability](https://learn.microsoft.com/en-us/azure/reliability/reliability-database-postgresql),
  [Key Vault security](https://learn.microsoft.com/en-us/azure/key-vault/general/secure-key-vault)
  and [Entra authorization code/PKCE](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow).

### Earlier implementation milestones

Revision 0.16 adds the [current architecture diagram](diagrams/ccgc-automated-solution.html)
and a [GPT-image-enhanced presentation companion](diagrams/README.md).
They distinguish the live single-user runtime from the locally tested
Bicep/Terraform automation. This documentation update does not deploy, upgrade,
or certify the solution for enterprise use.

Revision 0.15 adds `server/deploy.py` and equivalent Bicep/Terraform entrypoints
for repeatable **new single-user deployments**. The coordinator automates the
reviewed subscription/tenant, plan approval, D-series provisioning, bounded
Defender JIT, Azure-authenticated SSH host keys, allowlisted source installation,
expected-account/model binding, HTTPS activation, private Mac backups/Keychain
configuration, synthetic all-model tool proof and admission/restart recovery.
It never adopts the proof host, pools seats, bypasses browser authorization,
implicitly upgrades a release or claims enterprise production readiness.
Creation timestamps and first backups survive resumption; credentials are not
stored in IaC or deployment evidence. Plans, client changes and live inference
have separate explicit approvals. See [the automation runbook](AUTOMATION.md).
Both templates and mocked lifecycle paths are locally validated; fresh cloud
applies using this coordinator remain unexecuted, separate from the existing
gateway's live proof.

**Revision 0.13 supersedes the single-model implementation restriction below.**
The gateway owns a frozen catalog of enabled Claude models from the linked
Copilot account, a preserved default, and explicit version-preserving mappings.
Claude uses ordinary gateway discovery and `/model`; no client mapping table
or response/prompt rewriting is introduced. Switching shares the existing
admission, history, attempt limits and fail-closed state.

The old 2.1.220 client itself inserts "Sonnet 5" into its system context for
`claude-sonnet-5.5`. A model catalog response alone cannot repair that hardcoded
identity. The selected minimum reviewed client is 2.1.296, which recognizes
Sonnet 5.5 and performs discovery while nonessential traffic remains disabled.
The one-time migration removes only project-owned all-alias pins and preserves
unrelated settings, account identity and stored credentials. The original live
proof remains valid historical evidence. Revision 0.14 adds live proof for all
six enabled models and a switch back to Sonnet 5.5 in one actual CLI process:
seven Read/Edit/Bash workflows, 33 successful native Copilot Messages requests,
unchanged credentials and one shared admission budget. The owner explicitly
approved activating the staged upgrade.

The real-client regression now switches after full tool workflows, not just
text replies. This exposed Haiku's embedding of token-budget system reminders
into tool-result text, with a trailing-whitespace trim. The gateway normalizes
only that comparison representation, preserving the reminder value, tool
identity/error status and meaningful result text while forwarding the original
request unchanged. Replays, changed content, incomplete tool batches, expired
admissions and unapproved model IDs still fail closed.

**Run the actual, unmodified Claude Code client, through its app or CLI, using Anthropic/Claude models made available through the developer's GitHub Copilot seat/license.**

Claude Code is the client and owns the coding workflow, repository tools, and permission controls. GitHub Copilot is the source of model access and entitlement. The goal is **Copilot-backed access to Anthropic models, not billing redirection**. A charge appearing on a GitHub bill is neither necessary evidence nor sufficient proof that this goal has been met.

**The primary product experience is configuration-first: the unmodified Claude client connects to a remote HTTPS AI gateway without a local inference proxy or an always-running project launcher.** CLI users configure Claude's supported gateway settings; Desktop users configure its separate third-party inference surface. A short-lived credential helper or sign-in callback is allowed; neither is a local model proxy.

The preferred Azure topology uses the public Entra-authorized Container Apps
enterprise broker as the single employee gateway in front of account-isolated
LiteLLM connections. Worker and LiteLLM endpoints remain internal.
**LiteLLM's native Copilot Messages provider is the selected connector**, because
its reviewed implementation covers the required protocol and authentication
path. The connector still owns Copilot authentication, token exchange/refresh,
endpoint discovery, and Claude model access. Moving this work off the developer's
machine does not eliminate it or make an unofficial upstream supported. Azure
hosting charges are separate from Copilot model entitlement.

The existing local native Messages adapter remains a development/test harness and a possible source for the remote connector, not the target user deployment. A direct client-to-Copilot route with a credential helper is an optional feasibility alternative, not an established configuration-only solution. An SDK adapter remains a fallback candidate, not a requirement; it must additionally reconcile two agent/tool lifecycles. No candidate switch is an automatic runtime fallback.

Remote Copilot-backed operation was demonstrated on 2026-10-07 for the pinned CLI/model tuple, not certified as vendor-supported or production-ready. Actual Claude Code 2.1.220 completed an isolated route probe and an ordinary configured Read/Edit/Bash workflow through the linked seat's `claude-sonnet-5.5`, Azure HTTPS and LiteLLM 1.104.0. Live upstream proof normally precedes cost-approved remote deployment; section 4.3 records the owner's explicit hosting-first sequencing exception and subsequent account/inference authorization. Hosting alone is not live proof or account authorization. See section 17 and the project README for the exact evidence and remaining target requirements.

Either a verified app path or a verified CLI path can satisfy the initial goal; supporting both is not an MVP prerequisite. Failure of one client surface or backend does not invalidate the others. If no candidate meets the requirements within the investigation window, produce a reproducible blocker report and a hold/no-go decision, not a replacement client or separate model provider.

### 1.1 Entitlement and client boundaries

- Users obtain the actual Claude Code client from its official distribution; this project does not patch or redistribute it. An app path means a first-party Claude Code coding surface, not generic Claude chat or a third-party imitation.
- All supported primary and auxiliary inference uses Anthropic models available to the selected Copilot identity, subject to seat validity, enabled models, organization policies, allowances, and additional-usage settings.
- No separate Anthropic API credential or BYOK/cloud-provider inference entitlement participates in the supported route. A client installation/sign-in requirement, if any, is distinct from model access and must be disclosed; a Copilot seat must not be assumed to unlock an otherwise restricted app.
- Seat-backed authentication, an entitled model, the effective Copilot inference route, and functioning Claude Code tools are the success evidence. Cost reporting is a secondary operational safeguard, not the product objective.
- An existing Copilot license does **not** mean unlimited usage, zero additional charges, or ownership of a general-purpose Anthropic API key.
- Official, community-documented, and reverse-engineered integrations must be distinguished. Neither an official SDK nor a successful community proxy call establishes vendor support or organizational authorization for this use.
- Gateway sign-in and Copilot authorization are separate. An Entra/OIDC identity or a gateway key authenticates access to the gateway; it does not confer a Copilot seat. Bind the authenticated gateway principal to the same developer's explicitly authorized GitHub account.
- Pointing Claude at another gateway, Foundry, or Bedrock does not by itself meet this goal. The effective upstream must remain Copilot for every primary and auxiliary request; a separately entitled Claude model is not an acceptable fallback.

## 2. Users, needs, and success

### 2.1 Primary user

A developer with a GitHub Copilot seat who wants Claude Code's existing app or terminal coding workflow using Copilot-provided Anthropic models. For an organization-provided seat, the administrator must permit the relevant model and integration; the project cannot override those controls.

### 2.2 User stories

| ID | Need | Observable outcome |
|---|---|---|
| US-01 | Use Claude Code with model access supplied by my Copilot seat | The real Claude Code app or CLI completes coding tasks through Anthropic models accessible to the selected Copilot identity, with no separate inference provider. |
| US-02 | Understand setup failures before sending repository content | Diagnostics identify version, routing, model, authentication, and policy blockers without a billable prompt by default. |
| US-03 | Read and change code through familiar controls | Claude Code presents and executes its own tool calls; denial leaves the target unchanged. |
| US-04 | Continue a conversation reliably | Repeated turns preserve role boundaries and tool-result associations without duplicated history. |
| US-05 | Know which seat and model provide the service | Setup/diagnostics display the gateway principal, linked Copilot identity, exact Claude mapping, deployment/client profile, entitlement evidence, and usage caveats without exposing credentials. |
| US-06 | Stop safely | Cancellation stops only affected generation; session expiry or revocation retires its state without shutting down the remotely operated gateway or unrelated client sessions. |
| US-07 | Know whether the app or CLI is usable | Each surface has an explicit verified, blocked, or untested status; CLI success is not advertised as app compatibility. |
| US-08 | Use ordinary Claude client configuration instead of running a local proxy | After explicit setup and route verification, the selected client connects to a remote HTTPS gateway with no local inference listener or persistent `ccgc` parent process. |
| US-09 | Keep provider credentials off my development machine | The connector holds its reviewed Copilot credential; the client receives only its own revocable gateway credential. |

### 2.3 Definition of success

MVP success requires all P0 requirements and applicable acceptance cases to pass on at least one pinned client-surface/remote-deployment/backend/version combination, using synthetic repository fixtures and a real Copilot-entitled Claude model. The actual client, its tool approvals, the linked authenticated Copilot identity, the permitted model, and the remote gateway-to-Copilot route must be observable. The workflow must run without a local inference proxy or persistent launcher. A billing statement or charge reconciliation is not an MVP success criterion.

A successful text prompt, a configured model label, or the model's own claim about its identity is not proof of feasibility or entitlement. A Copilot agent doing all the work while Claude Code merely displays the final answer is not success either.

## 3. Evidence and uncertainty

The initial sources were reviewed on 2026-10-04. Gateway/client documentation, LiteLLM provider documentation, and Azure gateway/SSE guidance were reviewed on 2026-10-06; native Sonnet 5.5 effort/system-message guidance was reviewed on 2026-10-07. References are defined in section 16. Documentation and source inspection are not live compatibility results for a released client/backend combination; the separate executed evidence below establishes the observed tuple only. Newer documented client features must not be assumed available in the existing 2.1.220 profile.

| Finding | Evidence | Consequence |
|---|---|---|
| Claude Code documents remote gateway settings, bearer/API-key authentication, and a rotating `apiKeyHelper`. | [S1], [S2] | Local inference proxying is not a client requirement. Configuration and an on-demand credential helper can replace the local launcher in the target CLI experience. |
| Gateways must provide Anthropic Messages semantics, including valid streaming and tool blocks. Token counting is optional. | [S3] | Compatibility is a protocol contract, not just URL rewriting. |
| Settings-file environment values take precedence over shell values; supervisor-hosted background agents may not inherit shell configuration. | [S2] | Process environment injection alone cannot prove routing. |
| Copilot SDK uses the Copilot runtime and supports signed-in-user authentication. | [S4], [S5] | A candidate access path, not a mandatory backend; its agent isolation still requires proof. |
| SDK tools can be declaration-only. External tool requests can be completed through a pending-tool RPC. | [S6], [S7] | There is a concrete candidate for returning execution to Claude Code. Its HTTP integration still needs proof. |
| Copilot runs its own multi-turn agent loop and enables first-party tools by default. | [S5], [S8] | Disable unrelated tools and establish explicit turn boundaries; do not equate `session.idle` with every Messages response. |
| Anthropic does not support routing Claude Code to non-Claude models through a gateway. | [S1] | P0 uses an explicit Claude model; general Copilot `auto` is excluded. |
| Copilot general auto routing is not limited to Claude. | [S9] | Do not confuse it with the Claude coding agent's separate Auto option. |
| Copilot usage is priced in token-based AI credits and can incur additional charges. | [S10] | Disclose costs and account for usage; do not confuse cost accounting with proof of seat-backed model access. |
| GitHub provides a Claude coding agent using the Claude Agent SDK under Copilot entitlement. | [S11] | Include this official alternative without claiming it enables the requested Claude Code app or CLI. |
| Copilot CLI offers ACP for agent integrations. | [S12] | ACP is not an Anthropic Messages endpoint; no reviewed source establishes Claude Code as its client. |
| The October 22, 2025 article describes actual Claude Code using LiteLLM or `copilot-api`. | [S15] | Relevant prior art, not current-version proof. Its GPT auxiliary mapping, broad model aliases, and example credentials do not meet this PRD. |
| Current LiteLLM provider documentation and pinned source implement native Anthropic `/v1/messages` requests through Copilot. | [S16], [S17] | Direct inference is a concrete candidate that can avoid the SDK's second agent loop. Protocol fidelity and entitlement still need a live demonstration. |
| LiteLLM documents device authentication and simulated VS Code headers; its authenticator uses an internal Copilot token endpoint. | [S16], [S18] | Record actual authentication, storage, headers, endpoint dependencies, and support/authorization risks before live use. Library support is not a GitHub API support commitment. |
| `copilot-api` describes itself as reverse-engineered and unsupported by GitHub, and advertises Anthropic-compatible endpoints. | [S19] | Evaluate as an explicitly unofficial candidate, including its credential/debug exposure and lifecycle controls; do not silently adopt its defaults. |
| Claude Desktop documents third-party gateway configuration separately from CLI environment variables. | [S20] | An app path has documented configuration evidence, but project-specific interoperability and client access prerequisites remain unverified. |
| Desktop gateway configuration supports static credentials, a credential helper, or OIDC sign-in, including Entra ID. | [S20] | Authenticate the user to the gateway independently of the linked Copilot account; assess exact app-version and deployment prerequisites. |
| Anthropic's `claude gateway` supports documented Anthropic/cloud-provider upstreams, but does not document a built-in GitHub Copilot upstream. | [S22] | An existing first-party gateway does not remove the Copilot integration requirement; separately billed/provider-entitled inference does not meet the goal. |
| The newly reviewed LiteLLM snapshot has native Copilot Messages dispatch, inherited Anthropic tools/streaming support, beta-header handling, and expiring Copilot-token refresh. | [S24], [S25], [S26], [S27] | Strong evidence for testing a combined gateway/connector before extending custom protocol code; not proof of this account's live tool workflow. |
| That snapshot blocks interactive device login inside proxy/event-loop workers and uses environment-selected token files, not gateway-user-specific Copilot accounts. | [S25] | Bootstrap authorization separately and constrain the initial deployment to the linked developer. Generic proxy authentication does not implement per-seat routing. |

**Locally demonstrated:** actual Claude Code 2.1.220 sends an isolated probe, executes Read/Edit/Bash in a disposable repository, and returns denied-tool results through the retained local harness. The new remote profile also completes an actual-client isolated probe and ordinary configured CLI Read/Edit/Bash workflow through trusted synthetic HTTPS, generated settings, and a real macOS Keychain helper, without a persistent project launcher. These demonstrations use synthetic upstream responses, not LiteLLM or Copilot inference.

**Live demonstrated:** device-authorized account/model binding, public Azure HTTPS and ordinary configured Claude Code 2.1.220 using the real Keychain helper through deployed LiteLLM 1.104.0. The selected `claude-sonnet-5.5` passed its isolated probe and a four-turn Read/Edit/Bash workflow on 2026-10-07, with native model/usage/stop validation and file/shell evidence. The Mac still has no Docker daemon; image execution and installed-package checks run on Azure.

**Not demonstrated:** Desktop interoperability, full managed-device isolation,
cold/refresh fault behavior, comprehensive retry/logging guarantees, longer live
conversations, performance targets or every P0 case. The successful live path
does not upgrade synthetic error/permission/cancellation scenarios into
live-provider evidence.

Native Copilot Messages access has third-party implementation evidence. The reviewed sources do not establish that this is a vendor-supported public integration contract for the standalone Claude Code client. Endpoint existence, library support, applicable authorization, live account entitlement, and end-to-end compatibility are separate questions.

## 4. Alternatives and selection

| Option | Actual Claude Code client? | Anthropic model access from Copilot seat? | Decision |
|---|---|---|---|
| Remotely hosted LiteLLM with its native Copilot Messages provider | Actual CLI route probe and Read/Edit/Bash verified on Azure | Verified for the linked seat's exact claude-sonnet-5.5 | Selected for the current remote alpha, with a small Node admission/control layer. Broader section 4.1 and release obligations remain; defaults are not adopted wholesale. |
| Current local native Messages adapter and launcher | CLI verified against synthetic responses; live route pending | Requires device login and live model proof | Retain for G0 proof, development, and regression tests; not the target config-first deployment. Remote hosting requires a new security/session profile, not a wildcard bind change. |
| Claude directly to Copilot with custom headers and a credential helper | Plausible native Messages route; unverified | Requires reviewed token handling and live proof | Optional no-proxy spike. Static URL/key configuration does not solve token refresh, endpoint selection, or per-request compatibility. |
| `copilot-api` or another community compatibility proxy | Claimed; unverified here | Claimed; account/model access must be demonstrated | Eligible as a remote connector/gateway after explicit unofficial-access and credential review; unsafe defaults are not accepted. |
| Copilot SDK adapter | Intended; unproven | Intended through signed-in-user authentication | Fallback candidate only; requires additional agent-loop/tool-boundary proof. |
| Anthropic's own `claude gateway` with its documented upstreams | Yes, subject to profile/version | No documented built-in Copilot upstream | Not a seat-backed solution as configured. It would still need a separately reviewed Copilot integration. |
| GitHub's Claude coding agent on supported GitHub/VS Code surfaces | Not the requested app/CLI established by that integration | Documented, subject to plan and policy | Explain as an alternative, not a replacement deliverable. |
| Copilot CLI with a Claude model | No | Yes, subject to plan and policy | Does not meet the client requirement. |
| Custom Copilot SDK or ACP terminal client | No | Possible through supported integration | Does not meet the client requirement. |
| Claude Code with Anthropic API, Claude-plan inference, or a cloud-provider/BYOK route | Yes | No | Does not meet the Copilot-seat model-access requirement, regardless of who pays. |

The earlier SDK-first and official-interface-only restrictions were design choices, not user requirements, and are superseded. Unofficial candidates are not automatically excluded or approved. Before any live use, review their authentication/access mechanism, credential handling, applicable terms, and organization policy with the project owner; unresolved authorization is a hold, not permission to bypass controls. Record any internal endpoints or emulated integration headers and their maintenance risks. [S13]

G0 must validate the self-contained broker and isolated LiteLLM connector using
the minimum approved single-user harness for upstream proof. Evidence from the
existing custom adapter does not establish LiteLLM interoperability, or vice
versa. Record the deployment roles, backend, client surface, exact versions,
evidence, limitations, support status, and rejected alternatives, including
direct-helper and SDK candidates. This is not a requirement to build multiple
interchangeable backends or a general proxy framework.

### 4.1 LiteLLM capability and fit assessment

The supplied provider documentation [S16] was reviewed together with source and upstream unit-test definitions at commit `c13746c951811e9235e8bba7e4b078ce6a7c2ad5` on 2026-10-06. This is a source-reviewed snapshot, not a release/image selected or executed by this project. The earlier source pin in [S17]/[S18] remains historical implementation evidence.

**Decision:** LiteLLM is selected for the scoped remote proof of **Claude client
-> remote LiteLLM -> Copilot-provided Claude**, with Caddy ingress and Node
admission controls in the alpha, and as the internal enterprise gateway behind
the public Entra-authorized Container Apps broker. Use its native
`github_copilot/<validated-claude-id>` Messages route, not OpenAI Chat
Completions conversion or a Copilot agent runtime. It removes much of the need
for a custom protocol/authentication connector, but does not establish all of
this PRD's controls by itself.

| Capability | Reviewed evidence | Fit and remaining work |
|---|---|---|
| Native Anthropic Messages | Documentation exposes `/v1/messages`; Copilot configuration builds the native upstream URL. Dispatch tests select the Copilot Messages provider for Claude and not GPT models. [S16], [S24], [S26] | Matches the required inference path without a second coding-agent loop. Expose only explicit Copilot Claude mappings; do not copy the page's mixed GPT/embedding model list. |
| System/messages, tools, and streaming | The inherited Anthropic configuration accepts system content, ordered messages, `tools`/`tool_choice`, and provides the Anthropic response/async streaming path. [S27] | Live Sonnet 5.5 Read/Edit/Bash and validated native streaming now pass. Denied calls, multi-tool batches, cancellation, malformed streams and other cases retain their explicitly synthetic evidence until separately exercised live. |
| Copilot authentication and renewal | Authenticator performs device authorization, stores the login, exchanges it at `copilot_internal/v2/token`, and refreshes expired Copilot tokens. [S25] | Reuses most authentication plumbing. Reviewed access approval, account identity verification, protected storage, safe refresh failures, unlink/revocation, and gateway-principal binding remain project obligations. |
| Hosted login bootstrap | The authenticator at the reviewed commit rejects interactive device-code login inside an event loop or worker such as the proxy; its error directs operators to authorize separately and mount the resulting token file. [S25] | Do not generalize this guard to every release: the separately inspected `v1.104.0` tag lacks it. [S30] Use operator-controlled bootstrap outside request handling, initialize token/endpoint metadata before readiness, and stop services before unlinking. |
| Account and endpoint selection | Token directory/file settings are deployment-level; endpoint metadata comes from the cached Copilot token. Native Messages ignores caller-supplied `api_base`. [S24], [S25] | One dedicated deployment/credential context is suitable for the initial single-user target. A different gateway key does not choose a different Copilot seat. Test cold startup and endpoint changes after refresh; client `ANTHROPIC_BASE_URL` points to LiteLLM, not a replacement upstream `api_base`. |
| Beta and advanced capabilities | Copilot-specific logic preserves beta values rather than applying the provider filter; upstream tests cover context-management/structured-output header injection. The shared transformation also normalizes or removes some reasoning parameters and blocks. [S24], [S26], [S27] | Native format is not a guarantee of byte-for-byte transparency or full Claude feature support. Keep advanced features outside P0 unless separately proven; reject unsupported semantics before lossy adaptation. A passing header test does not prove Copilot accepts the feature. |
| Gateway keys and model restrictions | LiteLLM documents virtual keys, user ownership, model/route permissions, expiry, and usage controls; that documented setup requires PostgreSQL. [S28] | May supply client-facing auth. Use a restricted inference credential, never the master/admin key in Claude. Cost estimates are not Copilot entitlement or authoritative AI-credit accounting; do not assume virtual-key budgets implement our per-grant turn/replay rules. |
| Search and other endpoints | The provider also documents Chat Completions, Responses, and embeddings; native Copilot Messages explicitly reports no native `web_search` execution. [S16], [S24], [S26] | These are not needed for the Claude-only MVP. Disable/reject server-side search interception, MCP execution, and other unverified tool/provider paths; ordinary repository tools stay in Claude Code. |

The provider's file store is not a demonstrated Key Vault/OS-keychain integration: the reviewed code opens token files and creates its directory without itself enforcing this PRD's complete permission, encryption, identity, and revocation policy. Protect mounts/directories and runtime permissions, validate refresh-write/concurrent-read failure behavior, keep cached token metadata writable only by the connector, and never bake credentials into an image or put them in a repository/shared volume. Bootstrap credentials on approved operator-controlled infrastructure; do not copy another application's token cache.

Readiness gaps must be closed by configuration, verified built-in features, or the smallest necessary control layer: principal-to-seat binding; live filtered model metadata; exact primary/auxiliary mapping; pre-content probe admission; cumulative turn budgets across key refresh; branch/replay/restart behavior; logout/expiry; and per-hop request/logging policies. A configured LiteLLM model list is not evidence that the account is currently entitled to every listed model. Debug logging in the shared Messages path can include message content, so production logging must be explicitly constrained and tested. [S25], [S27]

The first authorized experiment should use one exact enabled Claude model, no model/provider fallback, no automatic inference retries, no payload logging or gateway response caching, and a separately bootstrapped Copilot credential. Run the actual client's isolated probe and synthetic coding/tool workflow before remote provisioning, except for the approved infrastructure-only stage in section 4.3; then repeat through the final remote URL with ordinary client launch and gateway-only credentials. Authentication-token refresh retries are distinct from inference retries and must not be miscounted as model turns. Pin a released package/image containing the inspected behavior and retain sanitized evidence. If the gaps require more machinery than the existing connector, record that comparison rather than forcing LiteLLM into the design.

**Assessment status:** documentation/source reviewed; upstream unit-test definitions inspected, not executed as a vendor suite. The project's installed-package checks and actual live route/tool workflow now pass on deployed LiteLLM 1.104.0. This is an experimental, single-account CLI proof, not an accepted P0-complete implementation or a vendor-supported Copilot integration.

### 4.2 Remote alpha implementation decision

Revision 0.6 prepares **TLS ingress -> Node admission gateway -> internal LiteLLM -> Copilot**. The default `ccgc` commands configure remote operation; the original adapter is retained under `ccgc local`. LiteLLM 1.104.0 is pinned in `server/pyproject.toml`; its release source retains native Messages dispatch and ignores caller-selected upstream URLs, but differs from the earlier reviewed commit in authentication-worker behavior. [S29], [S30], [S31] Revision 0.9 adds installed-package and isolated HTTP evidence on Azure (section 4.3); neither the release tag nor these synthetic checks prove live account access.

The custom layer reuses existing Messages/SSE validation and history guards rather than implementing another provider protocol. It holds scoped client tokens, one active probe/admission, cumulative attempt accounting and persistent owner revocation. LiteLLM's master key stays internal; no PostgreSQL-backed virtual-key service or generic multi-backend router is introduced. Operator bootstrap binds a default model, the reviewed enabled-Claude catalog and immutable GitHub account ID to a separate gateway owner key. Metadata verification exchanges a transient Copilot token independently and does not race LiteLLM's mutable cache.

The alpha has a manual operator-to-developer binding, private file/volume state and macOS Keychain client storage, not self-service OIDC linking or an encrypted managed secret-store integration. Its active Azure deployment uses Caddy TLS ingress, one Node replica and one LiteLLM worker; only ingress publishes ports. Image/dependency evidence is recorded, legitimate account authorization and model binding are complete, and real user Claude settings were explicitly configured after a private backup. The route probe and four-turn Read/Edit/Bash workflow passed through the full stack. A reproducible transitive dependency lock, fault-path retry/refresh checks and comprehensive per-hop logging/SSE guarantees remain release work; one successful workflow does not certify them.

### 4.3 Approved infrastructure-only Azure stage

On 2026-10-06, the owner explicitly requested Azure provisioning to resolve the
local package-download and Docker-daemon blockers, selected **Sweden Central**,
and approved generating deployment files, followed by the revised $90.21/month
D-series deployment. This supersedes only the default live-before-hosting
sequence. GitHub account linking and inference still require their own
authorization. That later authorization and scoped live feasibility proof are
now recorded in section 17; broader proof/release gates remain open.

At the owner's subsequent request for a general-purpose D-series instance, the
deployed host is one `Standard_D2as_v5` Ubuntu 24.04 VM (2 vCPU / 8 GiB, AMD x64,
non-burstable) with a 64-GiB Azure-encrypted Standard SSD OS disk, Standard static IPv4,
Trusted Launch and source-restricted Defender JIT SSH. It preserves the existing Compose
topology and private UID 10001 state instead of adapting mutable token files to
a shared PaaS mount. Only Caddy publishes service ports. No ACR, database,
Key Vault or payload telemetry service is added. Disk encryption is not a
managed credential-store integration or backup; single-host availability and
restart invalidation are explicit proof-environment tradeoffs.

The revised live retail estimate is **$90.21/month** at 730 hours, including the existing
subscription Defender for Servers P2 setting, excluding variable traffic/disk
charges, tax and Copilot seat/usage. Regional quota and image availability were
checked, not reserved. Region/SKU changes require approval rather than automatic
fallback. ARM provisioning, cloud-init, verified-SSH source transfer, image build,
seven bootstrap tests and two installed-provider/error-path checks passed.
An isolated model-less proxy returned liveness, rejected unauthenticated model
listing with HTTP 401, and listed zero models with its temporary test key.
This exposed LiteLLM's missing Prisma error-handler dependency; pinning the
library at 0.15.0 fixes that path without adding a database or changing providers.
Both production entrypoints refuse unlinked startup. At the initial provisioning
handoff, the UID 10001 mode-0700 state volume was empty and containers were stopped.
Subsequent approved account binding populated protected state; the full HTTPS
stack is now active and has completed live CLI proof. See
[the Azure runbook](AZURE.md) for exact resource names, custody, activation and
cleanup. New deployments must keep inference inactive until legitimate bootstrap completes.
Sweden-hosted ingress does not establish Sweden-only GitHub/provider processing.

After governance automation removed the original permanent SSH rule, the owner
authorized an administrative-access repair. A separate resource-group Bicep
template now configures Defender JIT for TCP 22 from one public operator `/32`,
with a one-hour maximum; the helper requests 55-minute windows. The full-host
template shares that module and no longer declares permanent SSH ingress.
The policy deployment, first access request and strict SSH login succeeded on
2026-10-06. Existing Defender P2 and governance remain enabled; no VM, disk or
paid Bastion service was deployed by the repair. These access checks do not
establish Copilot authorization or future exemption from governance automation.

## 5. Scope and priorities

**P0:** required before an MVP release. **P1:** considered only after P0 passes and separately scheduled. **Excluded:** not authorized by this PRD. These are target priorities; section 17 distinguishes local evidence from unverified release requirements.

| Capability | Priority | Boundary |
|---|---|---|
| Actual Claude Code app or foreground CLI on macOS arm64 | P0 | At least one verified surface; one developer and their own Copilot seat; official, unmodified client. CLI remains the initial proof candidate. |
| Configuration-first remote HTTPS inference | P0 | Ordinary client launch after explicit setup; no local inference proxy or always-running `ccgc` process. An on-demand credential helper or temporary sign-in callback is allowed. |
| Authenticated remote gateway and Copilot connector | P0 | One operator-controlled deployment for the selected developer. Use the conforming broker and isolated connector; no public anonymous inference or entitlement pooling. |
| Gateway identity, Copilot linking, and credential lifecycle | P0 | Separate credentials; explicit account binding, protected remote storage, refresh/revocation, and session-scoped authorization/admission. |
| App/CLI feasibility and backend selection | P0 | Assess and record both surfaces independently; select one for the MVP. A blocked or untested second surface does not invalidate a working first surface. |
| Text, multi-turn context, streamed and non-streamed Messages responses | P0 | Only the request profile covered by fixtures and the pinned clients. |
| Claude Code read, edit, and shell tool round trips | P0 | Execution and permission UI remain in Claude Code. |
| Multiple tool calls in one model response | P0 | Correlation, results, denial, and retries must not duplicate effects. |
| Explicit Copilot-entitled Claude model selection | P0 | No cross-family substitution, general `auto`, or BYOK fallback. |
| Branch and auxiliary-request isolation | P0 | Supported paths stay isolated; unsupported paths are rejected before upstream submission. |
| Cancellation, errors, bounded resource use, usage visibility | P0 | No fabricated completion or claim of an absolute billing cap. |
| Compaction, subagents, and agent teams | P1 | P0 must disable through supported settings or reject safely; never merge their state into the main conversation. |
| Resume across session expiry or connector restarts | P1 | P0 continues only within an admitted live session; lost transient state fails closed rather than replaying history or resetting budgets. |
| Images, documents, extended thinking, prompt-cache optimization | P1 | P0 launch profile must avoid required unsupported fields; startup failure is a blocker, not permission to strip semantics. |
| Second client surface, Linux, Windows, IDE extensions | P1 | The unselected app/CLI surface can be added after MVP; no support claim until its own acceptance passes. |
| Supervisor-hosted background agents or remote sessions | P1 | Requires independent routing, credentials, and lifecycle design. |
| Local proxy as the required end-user deployment | Excluded from target MVP | Existing local mode remains a development/test harness; it cannot satisfy the remote-experience acceptance gate. |
| Non-Claude models, replacement terminal UI, shared multi-user/SaaS service | Excluded from alpha | Revision 0.17 adds an internal per-user enterprise target design, not implemented multi-user support. Replacement clients, non-Claude routing and seat pooling remain excluded. |

Also excluded: harvesting another client's private credentials, using another person's seat, entitlement pooling, quota/model-policy bypass, unauthorized access, modifying managed policies, and copying proprietary client internals. Candidate-native, user-consented authentication and token exchange/storage may be assessed; this is not permission to scrape unrelated credential stores. Integration-identifying headers and their authorization implications must be disclosed rather than hidden or used to evade restrictions. Repository content must not be sent during research or diagnostics without an explicitly initiated inference operation.

## 6. Intended user experience

The target journey is one-time gateway/account setup, explicit client configuration and route verification, then ordinary `claude` or Desktop use. `ccgc` is optional setup/diagnostic tooling, not a persistent parent of the coding session. The table below describes the target interface; [README](../README.md) documents the narrower shipped alpha. In that alpha the operator selects one model and links the account, `login --gateway ... --accept-unofficial` receives a gateway key on stdin, `configure [--apply]` uses the saved CLI profile, and `doctor --live --accept-unofficial` admits a session. `token` is the on-demand helper; `close` retires admission. Local device login/launch now require the `local` subcommand.

For the target remote profile, obtain the applicable unofficial-access acknowledgement and actual authorization before linking Copilot or invoking it. An acknowledgement is not permission. A saved approval applies only to the reviewed route/profile; material changes require renewed review.

| Command | Behavior | Network and billing |
|---|---|---|
| `ccgc login --gateway <url>` | Authenticate to the selected gateway, then explicitly link the same developer's GitHub account through the connector's reviewed flow. Gateway login alone is not Copilot authorization. | Identity/control-plane traffic; no inference. |
| `ccgc configure --gateway <url> --client <surface> --model <id>` | Preview non-secret routing/model/profile settings and the credential-helper reference or app setup instructions; apply only after explicit consent. Preserve unrelated/managed settings. | No inference; metadata access must be identified. |
| `ccgc doctor` / `ccgc doctor --remote` | Offline checks inspect local configuration and mark remote facts untested or cached. Explicit remote checks verify gateway connectivity, profile, linked identity, and metadata readiness. | Neither performs inference or sends repository content. |
| `ccgc models --gateway <url>` | List only Claude models available to the authenticated user's linked Copilot identity and deployment profile. | Authenticated metadata queries; no model prompt. |
| `ccgc doctor --live --client <surface> --model <id>` | Use the actual configured client for an isolated synthetic route/model probe; establish a bounded admission grant for that profile/account/model. | May consume AI credits; disclose before execution. No repository content. |
| `ccgc gateway-token --profile <id>` | Optional CLI `apiKeyHelper`: obtain/refresh only the current user's gateway credential within its existing admission scope; print only that credential to stdout. | Authentication/control-plane requests only; never silently run a model probe or reset an inference budget. |
| `claude` or the configured Desktop Code surface | Connect directly to the remote gateway using the verified profile and current admission grant. No local model listener or persistent `ccgc start` process. | Inference consumes applicable Copilot allowance; invalid/unverified admission fails closed. |
| `ccgc logout --gateway <url>` | Revoke this gateway access/admission and clear its local gateway credential. Separately offer explicit Copilot unlink/revocation; do not alter unrelated logins. | Control-plane traffic; remote logout failure is reported, not treated as confirmed revocation. |
| `ccgc version` | Report installed client/helper versions and cached deployment-profile provenance. Fetching current remote backend versions requires an explicit remote metadata operation. | Local only by default. |

No model is silently selected on the first run. The user supplies an exact Copilot Claude model ID from authenticated metadata; the saved profile may expose a tested alias but must show the exact mapping. Pin all primary and auxiliary aliases to explicitly approved Copilot Claude models. If a mapping becomes unavailable, stop and require another selection.

The client selector accepts `cli` or `app` but does not promise app support: an unverified surface blocks before inference and must not silently launch a different client. Diagnostics and live probes must target the same selected client profile.

Setup/probe options include `--project <path>` (default: current directory) and `--max-upstream-turns <positive-integer>` (default: 50). Validate them before any live probe and bind the approved limit to the remote admission grant. Client-side flags cannot raise a server-side limit. Ordinary client operation does not imply unrestricted feature support: settings must retain the verified profile, and the server rejects unsupported models, semantics, or admission scopes.

### 6.1 Setup, verification, and ordinary client use

1. Resolve the requested project path, including symlinks, without changing the user's global working-directory configuration.
2. Check the exact client surface, remote gateway/deployment profile, connector, applicable dependencies, and model. An unavailable gateway must not cause a local or alternate-provider fallback.
3. Authenticate the gateway principal and explicitly link the same developer's Copilot account using the reviewed remote flow. Confirm effective identity/model metadata without printing credentials. Neither login alone is entitlement proof.
4. Check effective Claude Code routing, credential, provider, and managed settings. Stop on conflicts or unverifiable precedence.
5. Configure the remote HTTPS endpoint and gateway-only credential source through documented CLI or Desktop settings. Preview and obtain consent for edits; do not start a local inference listener. The connector alone holds Copilot credentials.
6. Run a disclosed synthetic route probe using the same selected client surface and resolved routing configuration as the real session. Suppress repository instructions, automatic context collection, and hooks through documented client controls; a short synthetic prompt alone does not prevent context leakage.
7. Require correlated evidence at the remote gateway and connector, linked Copilot identity/model authorization, and a successful response through that Copilot route before granting repository-content inference. Bind admission to the principal, account binding, deployment/profile revision, client surface, exact model mapping, and session scope. A changed binding/profile or expired grant requires re-verification, not an automatic probe carrying project content.
8. Display the support disclaimer, linked seat identity, exact model mapping, limits, grant expiry, and unsupported features. End setup tooling; the user runs the ordinary client with its normal permissions and the same effective routing.
9. On cancellation or explicit session closure, retire only the affected work. Between requests, use authenticated closure or bounded lease expiry; normal completion of a tool-use response must not destroy continuation state. Closing a client never terminates the remote service.

A plain `curl` request to the bridge is not sufficient evidence for step 6: it does not prove where Claude Code itself will send traffic. The probe mechanism and its equivalence to the selected client session's configuration must be demonstrated at Gate G1.

For the CLI, use documented settings-file `env` values for a remote `ANTHROPIC_BASE_URL`, exact model mappings, and tested ancillary-traffic controls. Obtain the gateway credential through `apiKeyHelper` or a separately supplied `ANTHROPIC_AUTH_TOKEN`; never copy the GitHub token into either. Shell-only configuration is not an adequate persistent routing guarantee. This example is illustrative, not a deployed configuration or a complete compatibility profile:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://ai-gateway.example.com/copilot",
    "ANTHROPIC_MODEL": "<exact-enabled-Copilot-Claude-model-id>",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  },
  "apiKeyHelper": "/path/to/get-gateway-token"
}
```

The helper must exist, be trusted, and return only a gateway credential. Store no real secret in a committed settings file. Setup must also pin the verified auxiliary aliases and remaining compatibility controls. Effective settings precedence still governs the actual route. [S2]

For Desktop, use **Developer -> Configure Third-Party Inference -> Gateway**, or the corresponding managed profile, with `inferenceProvider: gateway`, `inferenceGatewayBaseUrl`, and the chosen gateway credential/`inferenceGatewayOidc` configuration. Its gateway sign-in is separate from Copilot account linking. Assess app access/version prerequisites, model discovery or explicit `inferenceModels`, probe isolation, and session lifecycle independently. CLI environment variables and `settings.json` do not configure this surface. Do not reconfigure or terminate unrelated app sessions. [S20]

If the selected surface cannot isolate probe content while preserving effective routing, block that profile and document the missing capability rather than probing with repository context.

### 6.2 Failure experience

Each failure includes a stable bridge error code, a sanitized reason, retryability, and a specific recovery action. Diagnostics distinguish `ready`, `blocked`, and `not-tested`, including separate authentication, seat/model entitlement, routing, and workflow checks. Successful authentication must never be presented as proof of entitled model access.

## 7. Architecture and ownership

```text
Developer machine
  Actual Claude Code app OR CLI
    | Owns coding UX, file/shell tools, and permissions
    | Configured remote URL + gateway-only credential
    | No local inference proxy or persistent ccgc launcher
    v
  HTTPS Anthropic Messages / SSE
    |
    v
Operator-controlled remote deployment
  AI gateway: optional Azure API Management
    | TLS, gateway authentication, authorization, request limits
    | Immediate SSE relay; no inference retries or response cache
    v
  Copilot connector / combined native Messages gateway
    | Gateway-principal -> explicit GitHub account binding
    | Copilot login/token refresh, endpoint/model validation
    | Session admission, branch isolation, usage, cancellation
    +--> Protected remote credential store (no transcript store)
    |
    v
  GitHub Copilot service under the linked developer's seat
    |
    v
  Explicitly selected, entitled Anthropic/Claude model

Optional ccgc setup/diagnostics and credential helper:
  configure/verify the client and authenticate to the remote service;
  never carry the model request stream or execute repository tools.
```

The model request path now crosses operator-controlled hosting as well as GitHub and its serving provider. Disclose this additional data-processing boundary and region. The developer's tools remain local to their Claude Code session; remote inference is not remote execution of the coding client. In this PRD, "bridge" means the combined compatibility/admission function, not a requirement for a local server.

| Component | Owns | Must not own |
|---|---|---|
| Optional setup/diagnostic tool and credential helper | Explicit configuration changes, profile/route verification, gateway sign-in and credential retrieval | Local inference proxying in normal use, GitHub token harvesting, managed-policy overrides, automatic client installation/upgrade |
| Remote AI gateway | HTTPS ingress, gateway-principal authentication, authorization, bounded traffic and immediate stream relay | Granting Copilot entitlement, pooling seats, hidden caching/retries/fallbacks, repository tools |
| Copilot connector / bridge | Explicit principal/account binding, reviewed Copilot authentication, Messages fidelity, admission/branch state, usage and cancellation | GitHub credentials sent to clients, unauthorized access, invented results, repository execution |
| Protected remote store | Connector credentials, account-binding/revocation metadata, bounded admission accounting | Prompt/tool transcripts, provider credentials in project files or diagnostic logs |
| Claude Code | Conversation UI, user tool permissions, repository operations | GitHub tokens supplied by the bridge |
| Compatibility profile | Client surface, selected backend, support/authorization status, exact versions, model mapping, feature disposition, evidence | A claim that an untested combination works or that community support implies vendor endorsement |

Prefer supported client configuration and an existing conforming remote gateway over unnecessary custom code. Reusing the current TypeScript connector or hosting LiteLLM are candidates, not requirements to support both. Pin actual dependencies at G0 and the deployment/policy revision at G1. If the SDK is selected, distinguish its remote owned runtime from any system `copilot` executable.

On Azure, the public HTTPS Container Apps broker is the only employee ingress
and resolves a protected per-user connector through Key Vault. Entra
tenant/audience/permission validation and assignment-required group membership
authorize profile and admission creation; opaque bounded admissions authorize
model calls. Select the region, compute, ingress authentication, and cost
estimate after G0; section 4.3 permits the owner's separately approved
infrastructure-only stage. Use the native
`/v1/messages`-compatible API. The broker and connector must disable response
caching, body logging, automatic inference retries, and provider fallbacks;
preserve supported Anthropic headers, body semantics, tool blocks, and SSE
pings; reject bypass requests; and never trust caller-supplied identity headers.

A direct Messages backend forwards one inference request at a time and does not require an SDK agent/session. Do not impose SDK-only persistence, history-delta, or pending-RPC machinery on it. Sections 9 and 10 distinguish backend-neutral behavior from SDK-specific implementation obligations.

### 7.1 Non-negotiable invariants

- Only tools declared by the relevant Claude Code request may be returned for execution.
- The bridge never runs a repository tool itself. Claude Code's existing permission policy remains authoritative; the bridge does not force permissive mode.
- Any backend runtime's built-in repository tools, imported MCP tools, unrelated skills, and ambient agents must not independently perform work. Claude Code's own validated caller tools remain its responsibility.
- One HTTP Messages response represents one model response boundary, not an entire Copilot task.
- Completing a response with `stop_reason: "tool_use"` ends that model response, not the conversation. A direct request is finished; an SDK adapter must preserve any pending upstream tool operations.
- No context, pending tool, retry, or cancellation crosses a conversation branch.
- No credential, admission grant, model list, or branch state crosses an authenticated gateway principal or linked Copilot account. A client-supplied account/session header is not authorization.
- Gateway credential refresh does not change the linked seat, create a fresh turn budget, or erase uncertain request state. Remote restart or scale-out cannot silently replay or reopen a lost session.
- No failure changes identity, model, client surface, backend, or Copilot entitlement source automatically. Disable unverified proxy routing, retries, and provider fallbacks.

If the SDK is selected, `mode: "empty"`, explicit tool filtering, and documented system-message controls are candidates for isolation. Their effects, authentication behavior, and interaction with managed controls must be verified together; selecting that mode is not itself proof of isolation. [S6]

## 8. Functional requirements

All requirements in this section are P0. Their acceptance cases are specified in section 13.

### 8.1 Setup, identity, and routing

| ID | Requirement | Acceptance |
|---|---|---|
| ARCH-01 | Validate the self-contained remote native broker with an isolated connector; assess direct-helper and SDK alternatives without requiring their implementation. Record reuse/custom work, authentication, support/authorization, deployment boundaries, costs, and selection evidence. Prove the live upstream before normal remote activation; the section 4.3 infrastructure-only exception cannot waive live evidence. | AT-21, AT-23 |
| DEP-01 | Deliver a remote authenticated HTTPS Messages endpoint reachable by the ordinary selected Claude client without a local inference proxy or persistent launcher. Record host/region, service ownership, deployment revision, tier and cost approval. | AT-23, AT-25 |
| DEP-02 | Apply section 7's ingress/connector controls across every hop: trusted identity, no bypass, immediate SSE, no response cache, body logging, uncontrolled retry, or alternate-provider route. A combined gateway must enforce the same invariants. | AT-07, AT-18, AT-25 |
| SET-01 | Report the actual client surface, remote deployment/backend, required dependencies, OS, architecture, and profile status, distinguishing client from server facts. Include SDK/runtime/Node.js versions only when used. Validate setup/probe options. Unknown versions block supported admission; development overrides may not bypass known incompatibility or policy. | AT-01 |
| SET-02 | Default diagnostics perform no inference and submit no repository content. Live probes use fixed synthetic input and disclose credit consumption. | AT-01, AT-02 |
| SET-03 | Assess app and CLI independently, including client access/login requirements, gateway configuration, isolation, and lifecycle. Require one verified surface for MVP, reject unverified surface selection, and publish separate support status for each. | AT-22 |
| AUTH-01 | Use the selected user's Copilot seat through the chosen backend's reviewed, user-consented authentication flow. Detect credential precedence and fail on ambiguous/different identity. Do not harvest another client's credentials; document any candidate-owned token storage/exchange and validate it before live use. | AT-03, AT-18, AT-21 |
| AUTH-02 | Keep GitHub credentials out of Claude Code's environment/configuration, arguments, client-facing HTTP traffic, project settings, and logs. Only the upstream backend may hold/use them. The bridge credential is unrelated to upstream credentials. | AT-03, AT-18 |
| AUTH-03 | Establish effective Copilot identity, available seat/model authorization, and a successful selected-Claude response through the Copilot route. A login, model label, billing record, or HTTP success alone is insufficient. No separate Anthropic/BYOK model entitlement may supply primary or auxiliary inference. | AT-02, AT-03, AT-05 |
| AUTH-04 | Authenticate the gateway principal separately from Copilot. Bind it explicitly to the same developer's stable GitHub account ID, not a caller header or mutable display name. Validate token issuer/audience/expiry or equivalent per-user credential controls; reject absent, wrong, expired, revoked, or ambiguous bindings. | AT-03, AT-24 |
| AUTH-05 | Keep Copilot credentials in a protected remote connector store with least-privilege access, documented refresh/unlink/revocation, and no client/log exposure. Gateway logout and Copilot unlink are distinct operations. | AT-18, AT-24, AT-28 |
| CFG-01 | Evaluate effective Claude settings and managed restrictions. Reject conflicting/unverifiable routing; preview and require explicit consent for scoped non-secret configuration edits, preserving unrelated values. Never silently rewrite global settings, store provider secrets there, or relax managed controls. | AT-04, AT-23 |
| CFG-02 | Separate setup/helper, selected Claude surface, gateway, and upstream connector configuration/credentials. Reject unintended BYOK/provider routes and incompatible sources before inference. Do not forward the client's gateway credential to Copilot. | AT-03, AT-04, AT-24 |
| CFG-03 | Prove Claude Code-to-bridge-to-selected-Copilot routing with a content-isolated synthetic probe before repository-content inference. Require the expected bridge observation and effective provider/account evidence, not just HTTP 200. Block if probe instructions/context cannot be isolated without changing routing. | AT-02, AT-04 |
| CFG-04 | Disable or reject supervisor-hosted/background workflows outside the tested client profile. Selecting an app does not implicitly authorize remote/background execution. An unenforceable setting blocks that profile, not all other client candidates. | AT-04, AT-12, AT-22 |
| CFG-05 | Use supported persistent CLI gateway settings or Desktop's independent third-party inference configuration. An optional helper returns only gateway credentials and exits; no local model listener or persistent wrapper is required. Pin primary/auxiliary model mappings and publish exact surface/version prerequisites. | AT-22, AT-23 |
| CFG-06 | Gate repository-content inference on a content-isolated actual-client probe bound to the authenticated principal, Copilot binding, deployment/profile, model mapping, and session admission scope. Expiry, loss of state, or material routing/binding change invalidates admission; credential refresh alone never bypasses the gate. | AT-02, AT-04, AT-26 |

### 8.2 Models and protocol

| ID | Requirement | Acceptance |
|---|---|---|
| MOD-01 | Require an explicitly selected, currently entitled Claude model. General Copilot `auto`, non-Claude IDs, unknown aliases, and model substitutions are rejected. | AT-05 |
| MOD-02 | Map each accepted Claude Code model ID to an exact Copilot Claude model ID and a tested capability profile. Display requested and effective IDs; validate any auxiliary model separately. | AT-05 |
| MOD-03 | Use the validated effective context/output limits and capability assumptions, not a guessed 200K/1M window. Fail before unsupported context or output requests; never fabricate model capabilities. | AT-05, AT-13 |
| API-01 | Serve the endpoint and request/response contract in section 11, validating authentication and limits before invoking Copilot. Match URL paths independently of query parameters. | AT-06 |
| API-02 | Preserve accepted system content, message roles/order, text blocks, tool schemas, tool inputs/results, model parameters, and stop semantics. Never flatten a transcript into one user prompt. | AT-06, AT-10 |
| API-03 | Give every observed request field and beta capability an explicit pass-through, translation, documented hint-only omission, or rejection rule in the profile. Unknown semantic features fail clearly. | AT-06, AT-13 |
| API-04 | Stream ordered, nonduplicated Anthropic events as data becomes available. Handle non-streamed requests with the same model-response/tool boundary, not whole-task output. | AT-06, AT-07, AT-25 |
| API-05 | Report real available usage and stop information. Distinguish upstream/backend-reported usage from local estimates and authoritative Copilot accounting; do not use fabricated zero usage to satisfy required protocol fields. | AT-07, AT-17 |
| API-06 | Expose authenticated, account-filtered gateway model metadata for setup. Translate the upstream `/models` catalog to the selected gateway/client schema; do not expose raw token metadata or unrelated users' models. Assess Desktop discovery versus explicit model configuration separately. | AT-05, AT-23, AT-24 |

### 8.3 Tools and conversation state

| ID | Requirement | Acceptance |
|---|---|---|
| TOOL-01 | Forward only the caller's validated tool declarations; no gateway/backend repository handlers. If an agent runtime is used, disable its unrelated tools, MCP servers, skills, and agent behavior. | AT-08, AT-09 |
| TOOL-02 | Implement section 9's client-owned tool round trip. Preserve native tool IDs for direct requests; correlate SDK pending-call IDs only when that backend is used. Accept each new result for continuation at most once. | AT-08, AT-11 |
| TOOL-03 | Preserve Claude Code approval, denial, and tool-error behavior. Forward negative results honestly; never fabricate a successful result to advance inference. | AT-09 |
| TOOL-04 | Support the full tool-call batch for a single model response, including multiple tools and results. Do not resume inference with an incomplete batch or execute denied calls elsewhere. | AT-09, AT-11 |
| SES-01 | Isolate authenticated gateway principal, Copilot binding, admission grant, project, session, agent, request class, and transcript lineage as described in section 10. Never key solely on client-supplied identifiers. | AT-12, AT-24 |
| SES-02 | Preserve complete role-ordered transcripts on direct Messages requests. Only stateful SDK adapters reconcile prefixes and submit new input or pending results instead of replaying full history into an agent session. Reject unsupported lineage or semantic changes; never flatten or duplicate history. | AT-10, AT-13 |
| SES-03 | Serialize generation within each branch, bound global concurrency, and keep retries distinct from new turns. An ambiguous delivery cannot trigger automatic replay or tool-result resubmission. | AT-11, AT-12 |
| SES-04 | Handle cancellation differently from successful tool handoff. Cancel only the affected branch, retire pending mappings, and reject stale results. | AT-14 |
| SES-05 | Keep gateway transcripts and transient request/tool state in memory; do not add an unnecessary conversation store to a direct backend. Verify the selected backend's persistence, including SDK state only when used, and disclose its credential storage and Claude Code's separate history behavior. | AT-18 |
| SES-06 | Prevent replay, budget reset, or state mixing on connector restart, credential rotation, and misrouted replica requests. P0 may use one state-owning replica and invalidate lost sessions; durable metadata may preserve admission/revocation counters, never transcripts. | AT-11, AT-17, AT-26 |

### 8.4 Usage, errors, and lifecycle

| ID | Requirement | Acceptance |
|---|---|---|
| COST-01 | Display that token-based AI credits and overages may apply. Record the effective identity, provider, and model without copying credentials; never claim one HTTP request equals one billable action or require a billing statement as proof of entitlement. | AT-03, AT-17 |
| COST-02 | Enforce a remote per-admission upstream-turn limit including probes, continuations, retries, and auxiliary calls. Refresh/reconnection cannot reset it. Disclose in-flight usage, reporting gaps, and separate gateway hosting charges. | AT-17, AT-26 |
| ERR-01 | Use stable error categories and protocol-valid failure signaling before and after streaming starts. Preserve upstream retry advice when available without inventing entitlement diagnoses. | AT-15 |
| LIFE-01 | Operate the remote service independently of clients. Cancel/close only the affected session and use bounded expiry when no explicit close signal exists; normal tool handoff is not cancellation. Drain/invalidate sessions on deployment shutdown without replay or unrelated client termination. | AT-14, AT-16, AT-22, AT-27 |
| LIFE-02 | Implement gateway token/grant expiry, refresh, logout, and explicit Copilot unlink with the published section 12 bounds. Revoke affected admission and pending work without changing unrelated credentials or silently treating a failed remote logout as successful. | AT-24, AT-28 |
| VER-01 | Publish exact tested version tuples, model mappings, capability dispositions, and known limitations. Pin dependencies; re-run the acceptance suite before changing supported tuples. | AT-01, AT-19 |

## 9. Tool-call transaction contract

### 9.1 Backend-specific mechanisms

**Direct/native Messages candidate:** forward the validated request, including tool declarations and ordered transcript, to the selected Copilot inference route. Return the actual model's `tool_use` blocks to Claude Code. The upstream HTTP response completes normally; there is no waiting SDK agent. A later request with `tool_result` is a new Messages inference request containing the complete conversation. Preserve existing result blocks as history without treating them as newly executed tools. LiteLLM's native route is implementation evidence for this candidate, not a verified project integration. [S16], [S17]

**SDK adapter candidate only:** investigate declaration-only tools, `external_tool.requested`, and `session.rpc.tools.handlePendingToolCall`. The official example demonstrates externally supplying a tool result; it does not prove Anthropic HTTP compatibility or complete batch/stream fidelity. Retain pending runtime operations between Claude Code requests and resolve them through the validated SDK mechanism, not by creating a second ordinary user turn. [S7]

Any chosen mechanism must preserve the same client-visible contract. Do not invent results, execute tools inside the backend, or relax permissions to make the demonstration appear successful. Use documented runtime methods for an SDK adapter; review any direct endpoint dependencies under section 4 rather than treating them as SDK methods.

### 9.2 Required round trip

1. Claude Code sends request A with its system prompt, transcript, model, and tool schemas.
2. The bridge validates the request and selects the isolated branch. A direct backend forwards the complete Messages payload; an SDK adapter maps new input and registers declaration-only tools with verified runtime isolation.
3. Copilot generates one model response using the selected entitled Claude model. The bridge streams text and the complete tool batch, preserving native `tool_use` IDs or a tested reversible mapping.
4. The bridge ends response A with the correct tool blocks, `stop_reason: "tool_use"`, usage, and completion events. Direct inference is complete for A. An SDK adapter leaves its runtime waiting for external results and must not wait for `session.idle`.
5. Claude Code presents its normal permission controls, executes allowed tools, and sends request B containing corresponding `tool_result` blocks.
6. The bridge verifies lineage, caller identity, tool IDs, batch completeness, and result status, distinguishing newly supplied results from historical ones.
7. The direct backend submits B's complete valid transcript once as a new inference request. An SDK adapter instead resolves each existing pending runtime call once and binds the continuation output to B. Both return the next actual model response without duplicate input or independent tool execution.
8. The cycle repeats until a real final model response ends the turn, or an explicit error/cancellation retires the branch.

Text-only success does not prove this transaction for any backend. If the SDK is used, the bridge must distinguish an individual model response from an SDK run; `sendAndWait` or an idle event alone cannot implement that distinction.

### 9.3 State transitions

| Current state | Input/event | Next state | Required action |
|---|---|---|---|
| Idle | Valid new user turn | Generating | Submit the complete native transcript, or only verified new input to a stateful SDK session. |
| Generating | Complete model tool batch | Awaiting tool results | Finish HTTP response; retain required tool/lineage correlation, plus pending runtime operations only for SDK. |
| Awaiting tool results | Valid complete result batch | Generating | Admit one direct continuation request or resolve SDK pending calls once; bind output to the continuation response. |
| Generating | Final text/stop response | Idle | Complete HTTP response; retain only the in-memory state needed by the selected profile. |
| Any active state | Explicit cancellation or generation transport failure | Cancelled | Abort affected work; retire unresolved IDs; do not replay. |
| Any active state | Protocol, policy, or upstream failure | Failed | Surface failure and prevent further mutation until an explicit safe recovery. |
| Awaiting tool results | Approval/result wait expires | Cancelled | Retire pending work without a synthetic result. |

These are logical gateway states, not a requirement to keep an upstream connection or agent session open for a direct backend. Successful closure of response A is not a transport failure. Ending the designated client session while waiting for approval is cancellation. These cases must have separate tests.

### 9.4 Batch, permissions, and side-effect rules

- Establish the complete tool batch before declaring that model response finished. If the selected backend does not expose a reliable boundary, record a G0 blocker for that candidate.
- Validate tool schemas, names, input JSON, and identifiers. If names require aliasing, keep a reversible per-branch map and return Claude Code's original names.
- If the SDK is used, any permission acknowledgement must authorize only a declaration-only handoff. It must not grant local filesystem or shell execution.
- Forward Claude Code's denied/error result using a validated negative-result mapping. Missing results remain pending until timeout, never success.
- Deduplicate new continuations by branch, request/tool-use IDs, result fingerprint, and SDK request ID only when applicable. Identical retries are not submitted as new work; conflicting repeats fail. A native full transcript may legitimately contain earlier results; preserve that history rather than suppressing it as a duplicate continuation.
- No blanket exactly-once claim is possible across arbitrary process crashes or client tool retries. P0 guarantees at-most-once bridge submission within a live admitted session and stops on uncertain or lost state.

## 10. Conversation isolation and continuation

### 10.1 Identity model

Maintain the request/branch identity needed for correlation, concurrency, cancellation, and replay protection. Do not create an artificial upstream agent session for a direct Messages backend. Derive branch identity from:

```text
authenticated gateway principal
  + linked GitHub account ID and binding revision
  + admission grant and deployment/profile revision
  + project context identifier
  + Claude Code session ID
  + agent ID (explicit main-agent sentinel when absent)
  + request class
  + transcript lineage
```

Authenticate the principal and resolve the Copilot binding before looking up any branch. Namespace all state by that trusted identity; never use a request header to select somebody else's account. The client-side setup resolves canonical project identity; use an opaque project context identifier for correlation rather than logging local paths. The identifier is not a filesystem sandbox or authorization proof.

`x-claude-code-session-id` groups related requests; it is neither authentication nor sufficient conversation identity. Use `x-claude-code-agent-id`, parent-agent metadata, and documented request-class hints where supported. A pinned profile may enable `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` after validation. Do not assume a newer documented header exists in the pinned client. [S3]

Header presence and classification differ by version. If identity or lineage cannot be established reliably, return an explicit unsupported-context error rather than guessing that the request belongs to the main conversation.

### 10.2 State rules

| Situation | Required behavior |
|---|---|
| Next user turn repeats the full transcript | Direct: validate and forward the full role-ordered transcript once. Stateful SDK: verify the accepted prefix and append only new input; never replay the full transcript into an existing agent run. |
| A tool-result continuation arrives | Direct: submit the complete transcript, preserving historical and new results in order. SDK: resolve existing pending calls rather than appending a duplicate transcript or starting a separate run. |
| Auxiliary/title/classifier request | Use an independent supported context or return its documented unsupported response. Never append it to the main branch. |
| Parallel subagent or team request | Isolate fully if separately supported; otherwise reject before upstream submission. |
| Compaction rewrites history | Preserve the rewritten native payload or faithfully import SDK state only under a separately verified profile. P0 rejects unsupported rewrites; direct forwarding does not by itself establish compaction support. |
| `/resume` or history from an expired/lost admission scope | Explain the P0 limitation and reject; do not convert previous assistant messages into user text or recreate lost state automatically. |
| System prompt, tools, model, or reasoning semantics change | Apply a verified safe reconfiguration or reject before changing the branch. |
| Request is retried after uncertain delivery | Reuse an unambiguous recorded result if safe and tested; otherwise stop with a non-replayed failure. |
| Two continuations target one branch concurrently | Serialize verified duplicates or reject conflicting requests; do not interleave generation. |
| Gateway credential rotates within the same valid grant | Retain the account binding, branch identity, expiry, and consumed turn budget; do not treat rotation as a new conversation. |
| Copilot account binding, model mapping, deployment/profile, or gateway route changes | Invalidate the affected admission; require explicit re-verification before repository-content inference. |
| Connector restarts or a request reaches a replica without its branch state | Reject the continuation and invalidate lost admission; never create a fresh branch from the submitted transcript or reset its budget. |

Do not hash a flattened string transcript. Canonicalization must preserve roles, ordered blocks, tool IDs/results, model mapping, and semantic parameters. Keep fingerprints and any replay buffers in memory and bounded by the admission limits.

For a direct backend, keep only the cross-request state necessary for these controls; do not duplicate full transcripts into a persistent agent/history store. SDK adapters may need additional in-memory history reconciliation and must document it.

P0 may run one state-owning connector replica and invalidate all affected grants on restart. Sticky routing alone is not a durability guarantee. Scale-out is not required, but must not be enabled until loss/misrouting behavior passes AT-26. Bounded credential-binding, revocation, verification, expiry, and admission-counter metadata may be persisted independently of transcripts; record the exact fields and retention. Lost accounting state must fail closed, not create a new allowance.

Optional features may be rejected only if the pinned client's main workflow remains usable. If normal startup or ordinary coding requires an unsupported branch, the profile fails the gate; the project must not hide that limitation behind a broad "unsupported features" disclaimer.

## 11. HTTP and compatibility contract

### 11.1 Endpoints

Paths below are relative to the configured broker base URL. Preserve query
parameters without adding or removing a `/v1` prefix.

| Endpoint | P0 behavior |
|---|---|
| `POST /v1/messages` | Authenticated inference; accept the validated streaming and non-streaming request profile. |
| `POST /v1/messages?beta=true` | Same handler, with validated beta/header semantics; query parameters must not cause a routing miss. |
| `GET /v1/models` | Authenticated gateway-schema catalog restricted to the principal's linked account and allowed Claude mappings; no inference or raw upstream credential metadata. Client auto-discovery is enabled only for a verified version; explicit app model configuration remains an option. |
| `POST /v1/messages/count_tokens` | Optional. Until accurate support exists, return a documented unsupported response and verify Claude Code's fallback. Never return made-up counts. |
| `HEAD /api/hello` | Empty connection-warming response with no inference or sensitive metadata. |
| `GET /healthz` | Minimal process liveness only; not proof of authentication, entitlement, or inference. |
| Other routes/methods | Explicit unsupported route/method response; never forward arbitrary URLs. |

Authentication, account linking, admission, and logout form a separate control plane. Specify its chosen endpoints or identity-provider integration at G1, authorize each operation explicitly, and keep them out of generic inference forwarding. Do not expose a Copilot token retrieval/debug API to clients. For gateway credentials, consume `Authorization`/`x-api-key` at the appropriate trust boundary and replace them with connector-held Copilot authentication upstream.

### 11.2 Compatibility profile contents

The profile must identify the client surface, exact backend/version tuple, and vendor-support/authorization status, and classify every observed capability as `verified`, `partial-with-explicit-limit`, `disabled`, `rejected`, or `untested`. It must include:

- actual app/CLI distribution and version, client sign-in/access requirements, persistent configuration/helper mechanism, and independent remote surface-routing evidence;
- remote URL/prefix, hosting region, deployment/policy revision, trusted-ingress mechanism, stream timeouts/buffering behavior, and per-hop observation boundaries;
- gateway authentication/issuer/audience or per-user key policy, stable Copilot account binding, control-plane authorization, probe-admission binding, token/lease lifetimes, revocation, and restart/replica behavior;
- effective Copilot identity/entitlement evidence, authentication/token lifecycle, reviewed endpoint/header dependencies, and disabled fallback/retry paths;
- incoming/effective model IDs, context/output limits, and all primary/auxiliary model aliases;
- system text and ordered text-block support; user/assistant roles; tool schemas, choice, inputs, results, and error flags;
- `max_tokens`, stop behavior, supported sampling parameters, and streaming/non-streaming behavior;
- `anthropic-version`, observed `anthropic-beta` values, and unknown-field handling;
- thinking/signature blocks, images, context management, and any other feature disabled for P0;
- prompt-cache hints: translate only if supported; an explicitly documented performance-only omission must not produce fictitious cached usage;
- exact usage provenance and the client's behavior when optional token counting is unavailable;
- configuration switches used, their scope/precedence, and their interaction with organizational controls.

If a required field cannot be faithfully passed through or represented by the selected backend, that is a compatibility failure for that profile. Prompting the model to "act like" the missing protocol feature is not an implementation.

### 11.3 Response rules

For streaming, preserve the appropriate `message_start`, indexed `content_block_start`/`content_block_delta`/`content_block_stop`, `message_delta`, and `message_stop` sequence. Translate text and tool input JSON without missing, duplicated, or reordered data. Do not emit both incremental text and its full final copy.

Heartbeats must keep transport alive without pretending that model progress occurred. Stop reasons must reflect the real model response: a requested tool is not `end_turn`, and a failed stream is not a normal completed message.

Before sending headers, fail using a protocol-valid HTTP error. After streaming begins, use the pinned client's accepted SSE error behavior and terminate without success completion. Backend/runtime-reported cumulative usage must not be reported as fresh per-request usage; if protocol-required usage cannot be represented faithfully, the profile fails. Missing billing reconciliation alone is not such a protocol failure.

### 11.4 Error categories

These bridge codes are internal diagnostic labels. The compatibility profile must map them to Anthropic-compatible envelopes and tested client behavior, rather than introducing arbitrary API error types.

| Bridge code | Condition | Default recovery |
|---|---|---|
| `VERSION_UNSUPPORTED` | Untested or incompatible required client/backend capability | Select a tested version; no automatic downgrade. |
| `CLIENT_UNSUPPORTED` | App/CLI surface lacks a verified compatible route or required client access | Explain the blocker and available verified surfaces; never switch silently. |
| `GATEWAY_AUTH_REQUIRED` | Missing, expired, invalid, or revoked gateway credential | Sign in to the configured gateway; do not use a Claude subscription or another user's credential. |
| `GATEWAY_UNAVAILABLE` | Remote DNS, TLS, connection, or verified service-readiness failure | Restore the approved endpoint; never disable certificate validation or switch to a local/provider fallback. |
| `AUTH_REQUIRED` | No usable Copilot login for the selected backend | Sign in using the reviewed user-consented flow; do not harvest another client's credentials. |
| `COPILOT_LINK_REQUIRED` | Gateway principal has no valid explicitly authorized Copilot account binding | Complete reviewed account linking; gateway/Entra sign-in alone does not establish a seat. |
| `ADMISSION_REQUIRED` | Route proof/grant expired, changed, revoked, or lost with server state | Run explicit isolated verification to establish a new scope; no automatic repository-bearing probe or replay. |
| `ACCESS_UNVERIFIED` | Seat/model access or authorization of the selected integration is unestablished | Resolve the missing evidence or approval before content inference; do not substitute another provider. |
| `IDENTITY_CONFLICT` | Effective identity or credential source differs from the intended one | Resolve the conflict before retrying. |
| `ROUTING_CONFLICT` | Settings, provider configuration, or managed policy prevent verified routing | Correct allowed configuration; do not bypass policy. |
| `MODEL_UNAVAILABLE` | Selected Claude model is missing, disallowed, or not entitled | Select another explicitly permitted Claude model. |
| `FEATURE_UNSUPPORTED` | Request semantics cannot be preserved | Use the documented profile or stop the unsupported workflow. |
| `CONTEXT_CONFLICT` | Wrong lineage, stale tool result, changed transcript, or concurrent conflicting turn | Stop affected branch; start clean or use a validated recovery. |
| `LIMIT_REACHED` | Gateway admission limit, upstream quota, or usage allowance blocks work | Explain which limit; never reset the grant or switch accounts/providers. |
| `UPSTREAM_FAILURE` | Known upstream failure with no more specific verified diagnosis | Surface sanitized details and retryability. |
| `CANCELLED_OR_TIMEOUT` | Cancellation, generation inactivity, or tool-result wait expiry | Retire affected work; do not replay automatically. |

Gateway authentication, Copilot authentication, model policy denial, and quota exhaustion must not be conflated or inferred from a generic error alone. Invalid gateway authentication, malformed JSON, oversized input, and unsupported methods must fail before any upstream model invocation.

## 12. Security, privacy, usage, and quality

### 12.1 Security boundaries

**Remote ingress:** require HTTPS with certificate/hostname verification and an explicitly configured gateway origin. Do not permit plaintext remote inference, arbitrary upstream URLs, redirects to unreviewed origins, anonymous model/catalog access, or permissive CORS. Use the private enterprise broker through approved corporate connectivity. Container listeners may bind inside their deployment network, but the Copilot connector must not become an independently usable endpoint.

**Gateway identity:** use verified per-user gateway credentials. For OIDC, validate the expected issuer, audience, expiry, and tenant where applicable, using an immutable principal claim rather than email. For opaque credentials, use cryptographically random values with at least 256 bits of entropy and equivalent owner/expiry/revocation checks. Never trust raw client identity/account headers; broker-to-connector identity must be protected by the authenticated internal hop.

**Copilot linking and storage:** the remote connector owns its reviewed GitHub device/OAuth flow and resulting credentials. Bind each link transaction to the authenticated principal, expire it, prevent replay/session mix-ups, and require confirmation of the actual GitHub account before activation. Use a protected encrypted remote store with least-privilege access, such as Key Vault with managed identity on Azure; do not distribute Copilot credentials to Claude or the local helper. Managed identity to storage does not substitute for the user's Copilot authorization. Document refresh, logout/unlink, upstream revocation limitations, and deletion. Never pool accounts, copy another client's tokens, or store secrets under the project or a synchronized/shared directory.

**Client credential handling:** the CLI helper or app credential/SSO facility obtains only gateway credentials. Persist renewal material, if needed, in a protected OS credential store, not committed settings, shell profiles, arguments, or helper logs. Persist non-secret URL/model/profile settings only with explicit consent. The helper must print only its credential to stdout and sanitized errors to stderr. Same-user privileged processes can inspect client credentials; this is not a sandbox against a compromised developer account.

**Admission and revocation:** a successful isolated route probe authorizes only its bounded principal/account/profile/model scope. Proposed P0 bounds are access-token validity of at most one hour, admission-grant lifetime of at most eight hours, and no extension/reset of a grant by credential refresh. Deny new requests and initiate affected-work cancellation within 60 seconds of acknowledged logout/unlink/revocation; generation cancellation then meets the 15-second shutdown bound. Expired or lost admission requires explicit re-verification. Invalidate the old binding's grants before linking a different account. Credentials, authorization metadata, and transcripts have distinct retention policies.

**Local development only:** the retained harness continues to bind `127.0.0.1` on an OS-assigned port with a 256-bit per-launch credential, strict Host/Origin checks, and its protected user-local Copilot store. Those localhost assumptions do not authorize exposing the current process remotely. Its process-owned cleanup remains a local-harness obligation, not the remote service lifecycle.

Disable token-display/debug routes and credential-bearing logs at every hop. Do not change unrelated client login state, managed policy, or other users' sessions during setup or cleanup.

Preserve Claude Code's normal workspace trust and permission behavior. Resolve symlinks for project identity, but do not claim that a working-directory string alone enforces a filesystem sandbox. Cross-project/out-of-root actions remain subject to Claude Code's native policy.

### 12.2 Retention and telemetry

Gateway, connector, ingress, and helper diagnostics contain only severity, generated correlation IDs, opaque access-controlled principal/binding references, lifecycle/permission-result categories, version/profile IDs, latency, and usage counters. Do not log prompt text, source content, tool arguments/results, full upstream bodies, credentials, local paths, or unnecessary identifying metadata. Verbose mode still redacts secrets.

The bridge has no durable transcript store in P0. Disable response/semantic caching, payload capture, and request/response body logging in the broker, connector, ingress, and attached telemetry. Provider prompt-cache hints are a distinct protocol feature and must not be confused with gateway response caching. If the SDK is used, include effects of custom session IDs and session-store settings. Credential and bounded authorization/admission metadata persistence follow sections 10 and 12.1; clearing bridge memory does not clear another product's data. [S14]

Record the operator, hosting region, credential-store access policy, metadata fields and retention/deletion schedule before remote use. Do not add organizational observability or content-safety services that receive source payloads without a separate documented data-processing decision. Remote operation adds an operator-controlled data boundary; it does not establish vendor zero-retention.

Claude Code's own local history and GitHub/provider retention are separate product behaviors and must be disclosed. This project promises neither zero provider retention nor that all Claude Code network traffic follows `ANTHROPIC_BASE_URL`; ancillary traffic must be documented and controlled only through supported settings.

### 12.3 Usage safeguards and admission control

These safeguards are operational requirements, not the product's success definition. Establish Copilot-seat model access through AUTH-03 and the coding workflow, not through a monetary charge or billing-dashboard entry. Missing or delayed billing records must not be mislabeled as missing entitlement.

Current published pricing converts token usage into AI credits; the reviewed rate is 1 AI credit = USD 0.01. Prices, plan allowances, pooled organizational allowances, and overage controls can change. Link to current pricing rather than embedding a model price catalog. [S10]

For each admission grant/session, record available input, output, and cache usage by effective model and request class. Separate provider-reported usage, runtime-reported usage, and gateway estimates. Display unavailable measurements as unknown, not zero. Gateway/compute/storage/network costs are separate from Copilot model usage and need their own approved hosting estimate.

Enforce a finite server-side upstream-turn admission limit, proposed default 50 per grant across its permitted session scopes. Count the successful route probe and any preceding attempts used to establish that grant; issuing the content-enabled credential must not erase them. A turn is a newly initiated model-generation attempt: include native continuations, retries, auxiliary calls, and SDK resumptions that trigger inference; authentication and model metadata are not model turns. Check admission atomically before every turn-producing operation. Token refresh, reconnect, changed client session IDs, and restart cannot reset the grant; lost counters invalidate admission.

The spike must prove that all such paths can be gated. Disable or instrument any proxy-internal retries, model fallbacks, or SDK additional turns. If the selected backend can initiate uncontrolled inference, the limit cannot be advertised as enforced and its G1 profile fails.

A user-supplied AI-credit threshold may provide a secondary stop based on reported usage, but is not a guaranteed service-side spending cap: in-flight work and delayed accounting can exceed it. Warn about that limitation and direct users to GitHub's account/organization spending controls. Never change those controls automatically.

### 12.4 Resource and performance targets

These are proposed engineering targets, not measured results. Freeze or explicitly revise them at G1 using a recorded macOS arm64 client, hosting region/tier/replica size, network measurement boundary, and exact client/backend/deployment versions.

| Measure | P0 target | Measurement |
|---|---|---|
| Request body | Maximum 8 MiB | Reject larger input before parsing/submitting upstream. |
| Active upstream work | Maximum 4 branches for the single-user deployment; one generation per branch | Enforce at the connector across all grants; excess work receives an explicit limit error, not an unbounded queue. |
| SSE heartbeat | Every 15 seconds during otherwise silent generation | Must not reset the separate model-inactivity deadline. |
| Model inactivity deadline | 5 minutes without meaningful upstream progress | Abort affected generation; report timeout. |
| Pending tool-result deadline | 15 minutes | Excludes normal model latency; expiry retires the branch without a result. |
| Idle/abandoned branch lease | At most 15 minutes without an active request or accepted continuation | Without an authenticated close signal, release transient state at expiry; no assumption that a closed HTTP response means the app exited. |
| Remote readiness check | p95 under 2 seconds | 30 authenticated warm metadata/liveness checks from the reference client; exclude interactive login, cold deployment and model inference, reporting them separately. |
| Connector event forwarding overhead | p95 under 50 ms | At least 1,000 synthetic events; measure upstream receipt to connector HTTP write. Also report end-to-end arrival/heartbeat timing through broker ingress; do not attribute network latency to this process-only target. |
| Connector/gateway idle memory | Under 200 MiB RSS per warm self-hosted replica | Includes the selected self-hosted process set and excludes Claude. Report runtime and managed-service boundaries separately. |
| Active-work cancellation | Complete within 15 seconds of detecting cancellation, connection failure, or service shutdown | Abort only affected upstream work, invalidate uncertain state, and prevent automatic replay. |
| Gateway credential and admission expiry | At most 1 hour and 8 hours respectively | Refresh must retain the grant's original expiry, identity, and budget; an expired grant cannot admit inference. |
| Revocation enforcement | Deny new work and initiate affected cancellation within 60 seconds of acknowledgement | Cover logout, Copilot unlink, account rebinding and operator revocation; report unavailable remote revocation explicitly. |

G1 must select gateway/ingress idle and response timeout settings consistent with these bounds and demonstrate end-to-end pings without buffering. Connection warming alone is not evidence of acceptable remote streaming.

Use typed protocol validation, dependency locking, unit/integration tests, and secret scanning before release. The local harness retains its own 30-cycle listener/process-cleanup regression. No remote performance, live inference, or release-gate completion is implied by that evidence.

## 13. Acceptance suite

Every case must record the client-surface/deployment/backend/version/profile/model tuple, authenticated principal/account-binding scope, fixture ID, expected versus observed result, and sanitized evidence. Mock tests prove deterministic behavior; live tests prove selected backend interoperability and Copilot-entitled model access. A local or mock success does not replace the remote live tool round trip required for MVP.

All backend-neutral P0 cases apply to the selected MVP surface/backend. Mark SDK-only subchecks not applicable, with a reason, when using a direct backend; never require a pending SDK RPC on a native Messages path. Both client surfaces must have an assessment record, but the unselected surface may remain blocked or untested without failing the MVP. Every advertised surface must pass the applicable suite.

| ID | Scenario | Pass condition | Evidence |
|---|---|---|---|
| AT-01 | Missing/unknown versions, invalid setup options, offline and explicit remote diagnostics | Accurate ready/blocked/not-tested/cached status; selected surface/deployment/backend identified; invalid options rejected; zero inference and zero network for offline mode. | Setup/helper tests, intercepted network/model-call counts |
| AT-02 | Disclosed actual-client live probe with repository-instruction canaries | Same effective client route reaches the remote bridge and an available Claude model through the linked Copilot seat; synthetic input only; no project instructions/context/hooks. Evidence binds content admission to that principal/account/profile/model scope. | Sanitized client/gateway/connector trace, canaries, binding/model authorization and response metadata; no billing receipt required |
| AT-03 | Gateway login, linked identity, ambient token conflict, expired Copilot login, absent seat, disabled model, BYOK environment | Intended linked account/model access is established or admission blocks; gateway/Entra login alone is not success; no hidden provider fallback or GitHub credential in Claude. | Isolated identity/configuration fixtures and entitlement evidence; unsafe live account changes simulated |
| AT-04 | Settings override, managed restriction, wrong URL/profile, unverified background launch, config edit refusal | Block before repository-content inference; no unapproved global edits, unrelated changes, or managed-policy weakening; correctly configured selected surface succeeds. | Configuration fixtures, preview/consent and file-difference checks, remote route trace |
| AT-05 | Exact Claude model, unknown ID, non-Claude ID, general auto, context-limit mismatch | Only validated entitled mapping proceeds; accurate IDs/limits; no automatic substitution. | Model metadata fixtures and one live permitted model |
| AT-06 | Text blocks, role ordering, query string, malformed input, oversized body, optional routes | Contract-valid responses; no upstream call for rejected input; token-count fallback confirmed in the actual client. | Request fixtures, non-streaming and client integration tests |
| AT-07 | Text/JSON deltas, full final event, tool stop, truncation, usage, SSE failure | No duplication or invalid block order; honest stop/usage semantics; errors never end as success. | Golden event streams and actual-client decoding |
| AT-08 | Full read-tool transaction | At least 3 live rounds: response A finishes at tool use; actual Claude Code executes; B submits the native continuation or resolves SDK pending work; final answer reflects the real result. Inference uses the selected Copilot-entitled Claude model; no backend repository execution. | Live synthetic repository run, client/backend route evidence, instrumented execution counts |
| AT-09 | Approved edit, approved test command, denied edit, denied shell, tool error, multi-tool batch | Approved operations execute once; denied operations execute zero times; negative results remain negative; batches do not resume early. | File hashes, command sentinel, native tool-ID/result or applicable SDK pending-call traces |
| AT-10 | Ten consecutive main-conversation turns | No duplicated user/assistant history; correct references to earlier facts and tool results; roles remain intact. | Native transcript or SDK reconciliation fixtures plus live smoke run |
| AT-11 | Repeated request/result, historical result in a later transcript, conflicting duplicate, disconnect after tool-use delivery | At-most-once submission of each new continuation; legitimate native transcript history preserved; no unintended inference or side effect; ambiguous state fails visibly. | Deterministic fault injection for selected backend |
| AT-12 | Two agents/branches or synthetic principals sharing a session ID; auxiliary request during main generation | Trusted principal/binding/grant namespacing and branch isolation; explicit pre-submission rejection for unsupported work; no mixed results, budgets, or cancellation. | Concurrent fixtures and applicable client traces; synthetic second principal does not imply multi-user product support |
| AT-13 | Changed system/tools, compaction, previous-launch resume, unsupported thinking/beta | Verified reconfiguration or clear rejection before mutation; no flattened history or silently stripped semantic fields. | Versioned request corpus |
| AT-14 | Cancel during generation, normal tool-handoff close, cancel while awaiting approval | Explicit cancellation/transport failure aborts affected work; completed tool-use response leaves valid continuation state and SDK pending work only if applicable; stale results fail. | State-machine and actual-client tests |
| AT-15 | Policy/model denial, quota limit, rate limit, upstream timeout, partial stream failure | Correct verified category and retry advice; no provider fallback, false entitlement diagnosis, or success response. | Mocked upstream errors and safe live checks where available |
| AT-16 | Repeated ordinary-client open/close, helper exit, connector crash, explicit session closure | 30 client cycles with no local model listener/persistent wrapper; remote service remains available, affected state is retired within bounds, and unrelated sessions/settings are unchanged. Local harness cleanup is tested separately. | Remote session/lease checks, local process/listener and file-state observations |
| AT-17 | Probe, turns, continuations, retries, auxiliary calls, refresh/reconnect, admission boundary | Every attempt counted against its server grant, including pre-admission probe attempts; no new turn after the limit and no budget reset by refresh/session ID changes; usage/hosting estimates distinguished from authoritative accounting. | Intercepted attempts and grant counters; GitHub reconciliation when available, not required as entitlement proof |
| AT-18 | Remote auth/origin attacks, secrets/logging, persistence, token/debug endpoints | Unauthorized requests cause zero inference; no payloads/secrets in any broker/ingress/connector/helper diagnostics or durable transcripts; remote credential access is least-privilege and retention matches the profile. | Synthetic secret/payload canaries, policy and store-access checks, token-lifecycle tests |
| AT-19 | Client/backend upgrade regression | All applicable P0 cases pass for each advertised surface/backend tuple; unknown/broken tuples are not marked supported. | CI matrix and published compatibility evidence |
| AT-20 | Performance/resource thresholds | Each section 12.4 target met using its stated sample and measurement boundary. | Reproducible benchmark output |
| AT-21 | Remote-gateway/connector reuse and access/deployment review | Validate the broker plus isolated connector and record direct-helper/SDK alternatives. Require source-pinned support/authentication/endpoints/headers and approval evidence; live G0 proof precedes normal remote activation. Any infrastructure-only sequencing exception must be explicit, cost-approved and separate from inference authorization, as in section 4.3. | Selection record, applicable access approval, hosting estimate and deployment decision |
| AT-22 | Independent app and CLI assessment and selected-surface routing/lifecycle | Both assessed; one official surface passes all applicable remote P0 cases. Desktop uses its actual third-party inference configuration, not inferred CLI inheritance; client-access prerequisites and unsupported features disclosed. | Per-surface configuration/access evidence, actual-client remote route and lifecycle fixtures, separate support statuses |
| AT-23 | Configuration-first ordinary client use and gateway model metadata | After approved setup, end `ccgc` and use ordinary Claude on the remote URL with no local inference proxy; helper exits after credential retrieval. Primary/auxiliary mappings remain seat-backed, model metadata is authenticated, and secrets are absent from committed settings. | Actual-client remote tool workflow, process/listener inventory, effective settings, helper stdout/stderr and model-catalog fixtures |
| AT-24 | Gateway/Copilot identity separation and credential boundary | Wrong issuer/audience, expired/revoked credentials, forged identity headers, absent/mismatched link, and account-link replay fail before inference. Another synthetic principal cannot access a binding/catalog/session. Copilot tokens stay server-side; gateway tokens never reach Copilot. | Auth/linking fixtures, synthetic credential canaries, ingress-bypass tests and scoped store-access evidence |
| AT-25 | Full remote broker and connector data path | Validate TLS, URL-prefix/query mapping, unbuffered SSE/pings/tool blocks, and errors. Connector bypass fails; body logging/cache/retry/fallback configuration cannot alter the route. Network failure never switches to localhost or another provider. | Deployment/policy snapshot, invalid-certificate fixtures, first-event timing, streaming trace and captured outbound-attempt counts |
| AT-26 | Grant/profile change, restart, credential rotation, unknown replica, uncertain delivery | Rotation preserves binding/budget; stale or materially changed admission blocks; restart/lost state invalidates grants rather than replaying or resetting counts. No client-supplied session/account ID can create fresh allowance. | Fault injection with grant/counter assertions and zero unexpected upstream submissions |
| AT-27 | Disconnect during streaming, normal tool handoff, abandoned app, remote shutdown | Active-work cancellation meets the 15-second bound; normal completed tool-use response permits continuation; abandoned state expires within 15 minutes. Shutdown/drain causes explicit failure without replay or unrelated client termination. | Timed remote lifecycle tests with client and upstream cancellation observations |
| AT-28 | Gateway logout, Copilot unlink/rebind, token/grant expiry, unavailable revocation service | Token/grant lifetimes meet one/eight-hour bounds; acknowledged revocation denies new work and initiates cancellation within 60 seconds; failed remote revocation is reported. Unlink/rebind invalidates old admission without altering unrelated logins. | Controlled-clock expiry tests, timed revocation fixtures, protected-store deletion/access checks and distinct gateway/Copilot statuses |

For AT-08 through AT-10, use a disposable synthetic repository containing a known text value, a small editable source file, and a test command. No personal/company repository content or production credentials belong in recorded fixtures.

Unavailable live failure scenarios, such as revoking a real seat, must be simulated rather than changing an organization. Clearly label simulated versus observed evidence.

## 14. Delivery gates and ownership

### 14.1 Stage plan

Effort windows below are planning estimates for one engineer, not delivery promises. A blocked gate does not authorize bypassing it.

| Gate | Dependency | Work and exit evidence | Proposed timebox | Accountable role |
|---|---|---|---|---|
| G0: candidate selection and seat-backed feasibility | Read-only assessment, approved test account/access mechanism | Compare remote deployment candidates and alternatives (AT-21); assess app/CLI independently. Use the minimum approved harness, including the current local alpha, to prove Copilot/Claude access and live AT-08 with faithful tools/history and no backend execution. Infrastructure-only work under section 4.3 does not pass this gate. | 2 engineering days excluding authorization wait; report unresolved blockers | Implementer; project owner accepts access mechanism and evidence |
| G1: configuration-first remote proof | G0 passes; owner approves hosting/cost/data boundary; section 4.3 may prepare infrastructure earlier, not declare proof | Deploy and activate the selected minimal remote stack. Establish gateway/Copilot identity separation, protected credentials, plain-client configuration, equivalent isolated probe/admission, SSE, model mapping, session/revocation/restart controls. Freeze the surface/deployment profile and performance/expiry bounds; exercise AT-02 through AT-05 and AT-23 through AT-28. | Estimate after G0 and deployment selection; no inherited local-only estimate | Implementer; project owner approves deployment and account binding |
| G2: remote single-user MVP | G1 passes | All P0 requirements and applicable AT-01 through AT-28 pass on one pinned macOS arm64 client/remote deployment/backend tuple. No local inference proxy/persistent launcher; second surface has explicit status; setup, account linking, revocation, costs, limits, and troubleshooting documented. | Estimate after G1 | Project owner |
| G3: distribution/beta | G2 passes | Security and applicable terms/branding review; regression suite on a second available patch release of the selected client surface with a compatible pinned backend; supply-chain and release checks. | Estimate after G2 | Project owner and designated reviewers |

G0 starts with source/configuration review; authentication or inference requires the access review and approved test account. A local harness can prove upstream feasibility but cannot satisfy the remote MVP. Scaffolding and this PRD revision do not approve Azure resource creation or changes to the user's Claude configuration. Subsequent deployment requires its own approved topology, cost estimate, identity/data-processing decision, and execution request; section 4.3 changes ordering only. Avoid a general proxy framework, mandatory multi-backend abstraction, replacement UI, multi-platform packaging, or custom tool engine.

The working assumption is a CLI proof using native Messages, followed by configuration-first remote operation; an app path is equally eligible if its evidence is stronger. Choosing a direct-helper/no-gateway alternative or SDK backend requires a recorded product/architecture decision and fresh evidence for the applicable controls, not an automatic fallback or a claim that the remote profile already passed.

If a second client patch is not available for G3, retain a single-version experimental support claim; do not invent compatibility or delay the initial G0 proof waiting for a future release.

### 14.2 Decisions at each gate

- **Go:** required evidence passes; the project owner approves the next stage.
- **Hold:** a specific client/backend version, client access prerequisite, policy, quota, authorization question, or missing capability blocks progress; record the affected candidate and unblock condition.
- **No-go:** no evaluated candidate can provide the real Claude Code workflow, Copilot-seat access to Anthropic models, faithful tool/history semantics, or required controls within project constraints. A failed SDK adapter or app path alone is not a product-wide no-go.

The blocker report must identify the failing requirement/test, surface/backend and versions, sanitized reproduction, attempts made, candidate access paths considered, and missing capability. Preserve the product goal. Another gateway/proxy/SDK approach or the other actual Claude Code surface remains within scope after candidate review and proof; replacing Claude Code or using model entitlement from another provider requires a separately approved scope.

## 15. Risks and unresolved decisions

| ID | Risk/question | Required resolution | Gate |
|---|---|---|---|
| R-01 | Selected backend cannot expose a complete model/tool boundary | Direct: validate native tool blocks and completion. SDK only: demonstrate external pending calls and required response fields; final agent text is insufficient. | G0 |
| R-02 | Backend cannot preserve Claude Code system/transcript semantics | Validate faithful native pass-through or SDK mapping; reject lossy reconstruction and mandatory unsupported behavior. | G0/G1 |
| R-03 | Authentication, integration-identifying headers, or optional SDK isolation conflict with policy | Review the exact access mechanism and test permitted combinations without harvesting credentials or weakening controls. | Before live use/G1 |
| R-04 | Probe and selected client session resolve different settings | Demonstrate routing equivalence for that surface; do not infer app configuration from CLI behavior. | G1 |
| R-05 | Auxiliary requests or model aliases are required by ordinary startup | Capture synthetic startup traffic; support faithfully or fail the profile, rather than hiding failures. | G1 |
| R-06 | Missing per-response usage/stop details or hidden proxy retries/SDK turns | Validate response fidelity and admission control against the pinned backend; separate protocol-required usage from optional billing reconciliation. | G1 |
| R-07 | Memory-only bridge still leaves ingress/proxy/SDK/client artifacts | Verify per-hop body logging/cache/persistence, protected remote credentials and token/debug routes; disclose separate client/provider behavior. | G1/G2 |
| R-08 | Upstream releases break protocol, models, or credentials | Pin supported tuples; regression-test upgrades; fail clearly without automatic fallback. | G2/G3 |
| R-09 | Terms, organization policy, or product naming prevent use/distribution | Obtain applicable approval; neither official SDK licensing nor an unofficial working proxy alone establishes authorization. | Before affected use/distribution |
| R-10 | Native Messages access relies on internal endpoints or unstable client-identifying conventions | Pin implementation evidence, disclose vendor-support status, assess maintenance and permitted use, and fail visibly when the route changes. | G0/G3 |
| R-11 | App has distinct sign-in, gateway, background-host, or session-lifecycle constraints | Assess the actual app independently; retain a verified CLI path if the app is blocked. Do not claim a Copilot seat unlocks the app itself. | G0/G2 |
| R-12 | Successful login or a Claude label is mistaken for Copilot-seat model access | Correlate authenticated identity/model authorization with an actual Copilot-routed response and coding tool round trip; block unknown or alternative-provider routes. | G0/G1 |
| R-13 | Gateway/Entra authentication is confused with Copilot authorization, or one account becomes a shared upstream | Explicit immutable principal/account binding, reviewed link flow, wrong-principal tests, per-user grants, and no seat pooling. Remote MVP serves one developer only. | G1 |
| R-14 | Broker ingress buffers SSE, logs payloads, caches replies, or retries inference | Verify event timing, error propagation, body-log absence, and actual submission counts at every hop. | G1/G2 |
| R-15 | Remote restarts/replicas/credential refresh lose state or reopen turn budgets | One state-owning replica is acceptable; invalidate lost sessions/grants, preserve or fail closed on accounting, and reject unknown-state continuation. | G1 |
| R-16 | Configuration-first operation lacks a persistent launcher to gate routing or detect app exit | Bind probe evidence to remote admission, enforce server-side expiry/revocation, and use explicit closure or bounded idle leases. Re-test each surface's persistent configuration and isolated probe. | G1/G2 |
| R-17 | Hosting introduces cost, secret custody, public exposure, or an unapproved data region | Approve topology/cost/region and operator responsibilities; protect remote secrets, disable anonymous/bypass paths and payload telemetry, and document deletion/retention. | Before remote deployment |
| R-18 | Newly documented gateway/SSO features are assumed present in the old client profile | Verify exact CLI/Desktop versions independently; do not silently upgrade or claim 2.1.220 supports every current documented feature. | G1/G3 |

These are investigation questions, not already-solved implementation details. No release may label a required capability supported while its associated gate remains blocked.

## 16. Sources

[S1]: https://code.claude.com/docs/en/llm-gateway
[S2]: https://code.claude.com/docs/en/llm-gateway-connect
[S3]: https://code.claude.com/docs/en/llm-gateway-protocol
[S4]: https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate
[S5]: https://github.com/github/copilot-sdk
[S6]: https://github.com/github/copilot-sdk/blob/main/nodejs/README.md
[S7]: https://github.com/github/copilot-sdk/blob/main/nodejs/samples/manual-tool-resume.ts
[S8]: https://github.com/github/copilot-sdk/blob/main/docs/features/agent-loop.md
[S9]: https://docs.github.com/en/copilot/concepts/models/auto-model-selection
[S10]: https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
[S11]: https://docs.github.com/en/copilot/concepts/agents/anthropic-claude
[S12]: https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server
[S13]: https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot
[S14]: https://github.com/github/copilot-sdk/blob/main/docs/features/session-persistence.md
[S15]: https://dev.to/allentcm/using-claude-code-with-github-copilot-subscription-2obj
[S16]: https://docs.litellm.ai/docs/providers/github_copilot
[S17]: https://github.com/BerriAI/litellm/blob/461a58c40a76d62cf402609f46921d7aa8a9998b/litellm/llms/github_copilot/messages/transformation.py
[S18]: https://github.com/BerriAI/litellm/blob/461a58c40a76d62cf402609f46921d7aa8a9998b/litellm/llms/github_copilot/authenticator.py
[S19]: https://github.com/ericc-ch/copilot-api
[S20]: https://claude.com/docs/third-party/claude-desktop/gateway
[S22]: https://code.claude.com/docs/en/claude-apps-gateway
[S24]: https://github.com/BerriAI/litellm/blob/c13746c951811e9235e8bba7e4b078ce6a7c2ad5/litellm/llms/github_copilot/messages/transformation.py
[S25]: https://github.com/BerriAI/litellm/blob/c13746c951811e9235e8bba7e4b078ce6a7c2ad5/litellm/llms/github_copilot/authenticator.py
[S26]: https://github.com/BerriAI/litellm/blob/c13746c951811e9235e8bba7e4b078ce6a7c2ad5/tests/unit/llms/github_copilot/messages/test_github_copilot_messages_transformation.py
[S27]: https://github.com/BerriAI/litellm/blob/c13746c951811e9235e8bba7e4b078ce6a7c2ad5/litellm/llms/anthropic/pass_through/messages/transformation.py
[S28]: https://docs.litellm.ai/docs/proxy/virtual_keys
[S29]: https://github.com/BerriAI/litellm/blob/v1.104.0/litellm/llms/github_copilot/messages/transformation.py
[S30]: https://github.com/BerriAI/litellm/blob/v1.104.0/litellm/llms/github_copilot/authenticator.py
[S31]: https://pypi.org/pypi/litellm/1.104.0/json
[S32]: https://platform.claude.com/docs/en/build-with-claude/effort
[S33]: https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages

| Reference | Publisher and subject |
|---|---|
| [S1] | Anthropic: gateway support and non-Claude model limitation |
| [S2] | Anthropic: gateway configuration, precedence, verification, and background-session limitations |
| [S3] | Anthropic: endpoints, headers, model capabilities, streaming, and request identity |
| [S4] | GitHub: supported Copilot SDK authentication |
| [S5] | GitHub: Copilot SDK architecture, default tools, billing pointers, and SDK licensing |
| [S6] | GitHub: Node.js SDK options, runtime modes, tools, and session configuration |
| [S7] | GitHub: declaration-only tools and manual pending-tool result completion |
| [S8] | GitHub: agent-loop events and model-turn versus task completion |
| [S9] | GitHub: general Copilot auto model selection |
| [S10] | GitHub: current token pricing, AI credits, allowances, and additional usage |
| [S11] | GitHub: official Claude coding agent using the Claude Agent SDK |
| [S12] | GitHub: Copilot CLI ACP integration |
| [S13] | GitHub: applicable Copilot terms and purchasing-channel distinctions |
| [S14] | GitHub: SDK session persistence and resume |
| [S15] | DEV Community / Allen TCM: October 22, 2025 Claude Code proxy walkthrough; historical recipe, not current compatibility proof |
| [S16] | LiteLLM: GitHub Copilot provider, native Anthropic Messages support, authentication, and integration headers |
| [S17] | LiteLLM pinned source: native Copilot `/v1/messages` transformation at commit `461a58c40a76d62cf402609f46921d7aa8a9998b` |
| [S18] | LiteLLM pinned source: device authentication, internal token exchange, and credential storage at the same commit |
| [S19] | `copilot-api`: Anthropic-compatible proxy, explicit reverse-engineering/vendor-support warning, and credential/debug features |
| [S20] | Anthropic: Claude Desktop third-party inference through an Anthropic Messages gateway |
| [S22] | Anthropic: first-party Claude apps gateway and its documented Anthropic/cloud-provider upstreams |
| [S24] | LiteLLM newly reviewed source pin: native Copilot Messages routing, header handling, provider identity, and non-native web search |
| [S25] | LiteLLM same source pin: device-login bootstrap restriction, file-backed Copilot credentials, token refresh, and endpoint metadata |
| [S26] | LiteLLM same source pin: upstream unit-test definitions for native Claude dispatch, header behavior, endpoint selection, and capability flags; inspected, not executed |
| [S27] | LiteLLM same source pin: inherited Anthropic request/tool parameters, streaming interface, semantic normalization, and debug-message logging |
| [S28] | LiteLLM: virtual-key PostgreSQL setup, ownership, model/route permissions, expiry, and usage controls; not proof of per-user Copilot-seat routing |
| [S29] | LiteLLM `v1.104.0` release-tag native Messages source, source-inspected; Git blob `142df6a5a0c92b4de1d5ccfd3ab33e52d7e7438f` |
| [S30] | LiteLLM `v1.104.0` release-tag authenticator, source-inspected; Git blob `80fd4f755e789600070e0c475d68c4c5b789b332`; lacks the newer worker-login guard |
| [S31] | Official PyPI metadata for the selected 1.104.0 package; initial local download failed, later Azure installation and execution succeeded |
| [S32] | Anthropic: native output effort; used to review the actual Sonnet 5.5 client's `output_config.effort` request |
| [S33] | Anthropic: native mid-conversation system messages; only persistent text messages are enabled here, not turn-scoped instructions or inline tool changes |

Implementation evidence must pin repository references to the tested release or commit rather than relying only on moving documentation links. The earlier LiteLLM commits were source-reviewed; release 1.104.0 is now installed, deployed and exercised on the Azure proof host, with its current image recorded in the Azure runbook. The article's historical model IDs, non-Claude auxiliary mapping, wildcard/local-listener examples, and dummy credentials are not an approved configuration.

## 17. Revision record and disclaimer

Revision 0.2 addressed the seven initial review findings: preserved actual Claude Code rather than a replacement; specified the SDK external-tool lifecycle; isolated conversation branches; required effective routing; restricted inference to explicit Claude models; updated AI-credit accounting; and compared the official Claude coding agent alternative.

Revision 0.3 incorporates the project owner's clarification: the real Claude Code app or CLI must use Anthropic models supplied through a GitHub Copilot seat/license. This is an entitlement/model-access goal, not billing redirection. The revision removes SDK-first and blanket official-interface-only selection constraints, adds direct-proxy evidence and candidate review, makes SDK-specific mechanics conditional, assesses app/CLI independently, and aligns requirements, acceptance cases, gates, and risks with that goal. Usage safeguards and access/policy boundaries remain in force.

Revision 0.4 records the initial implementation: a dependency-light TypeScript/Node native Messages adapter, dedicated device authentication and protected credential store, local HTTP/SSE gateway, and a launcher pinned to Claude Code 2.1.220 in safe/manual mode. Existing full proxies were not adopted because their extra routes, retry/logging behavior, and credential handling would require additional control layers. No Azure resources were needed.

Revision 0.5 makes remote, configuration-first inference the primary target. It replaces mandatory localhost/per-launcher operation with ordinary CLI or Desktop gateway configuration, separates gateway identity from the linked Copilot seat, and defines remote credential/admission/revocation, streaming, deployment, restart, and acceptance requirements. A direct-helper approach is an unverified alternative, not a delivered feature. The local alpha remains a development harness. No application code, client settings, credentials, or Azure resources are changed by this documentation revision.

The same revision incorporates the project owner's LiteLLM capability-review request: section 4.1 selects its native Copilot Messages provider as the first candidate to test, records a newer source pin, and distinguishes existing protocol/authentication capabilities from bootstrap, credential isolation, semantic adaptation, admission, and operational gaps. This changes the evaluation order, not the unverified live status or P0 requirements.

Revision 0.6 implements the remote CLI profile, Keychain helper, explicit settings merge, isolated probe/admission, remote Node controls, internal LiteLLM transport, operator bootstrap and TLS/container assets. Synthetic actual-client testing exposed and fixed configured-environment precedence over the probe output cap, the pinned client's date-context envelope, and OS Keychain selection with an isolated HOME. Normal configured CLI operation is tested separately from the safe-mode local launcher. LiteLLM package execution, container rollout and live entitlement remain explicitly unverified; no P0 gate is waived.

Revision 0.7 records the explicit hosting-first investigation, the owner's Sweden
Central choice, and approved infrastructure scaffolding. Bicep, host setup,
guarded deployment commands and an allowlisted source archive prepare the
Azure-hosted build without changing application routing or account safeguards.
At that stage, separate deployment approval and legitimate Copilot bootstrap
were still pending.

Revision 0.8 implements the owner's D-series change in the Sweden Central
templates, parameters and operator tooling. `Standard_D2as_v5` replaces the
burstable B-series choice; SKU/family quota and regional pricing were rechecked.
The revised $90.21/month estimate required a new deployment approval. A regression
check keeps both templates, the parameter file and helper on the same D-series SKU.

Revision 0.9 records the separately approved Azure deployment, executed image
build, offline provider/bootstrap checks, and isolated model-less HTTP evidence.
It adds the pinned Prisma dependency and an installed-package regression for
LiteLLM's authentication-error path. Host/runtime preparation is complete; no
GitHub account was linked, no production HTTPS gateway was activated, and no
live inference or actual-client/Copilot workflow was performed.

Revision 0.10 replaces permanent administrative SSH intent with the source-bound
Defender JIT policy, adds guarded access-only preview/configuration/request
commands, and records an actual successful strict-SSH connection. It also
documents the three post-provisioning stages. Account linking still awaits
model selection and browser authorization; production inference stays inactive.

Revision 0.11 adds operator-only `authorize` to discover eligible Claude models
after legitimate device authorization, before choosing an exact deployment model.
It shares the existing metadata checks, creates no gateway keys, rejects
existing/revoked state, and never falls back to another model. Operator container
logging is disabled so device codes stay in the attached terminal rather than
Docker logs. The updated Azure image passed thirteen bootstrap checks and two
installed-package checks. At that handoff, browser authorization and model
selection still blocked gateway activation and client/live proof.

Revision 0.12 records successful browser authorization, independent account/model
binding, public TLS activation, Keychain enrollment and consented user-settings
configuration. The initial exact-ID rejection was resolved by using
`claude-sonnet-5.5`, without reauthorizing or changing the intended account/model.
Actual client requests required native effort and persistent text system-message
support ([S32], [S33]). Stream parsing now accepts a transport-only `[DONE]`
suffix only after a complete validated `message_stop`, rejecting incomplete,
duplicate and post-terminal data. No semantic role conversion or provider/model
fallback was introduced.

On 2026-10-07 the normal CLI route probe passed, followed by an isolated,
ordinary configured Claude Read/Edit/Bash workflow with real tool results and
file/shell sentinels. Five internal native Messages requests returned HTTP 200,
using `github_copilot/claude-sonnet-5.5` at the verified Copilot enterprise
endpoint. The test admission was closed and the synthetic workspace removed.
The VM had required a start and explicit service restart after deallocation;
its shutdown actor remains unknown, and governance/Defender controls were not
disabled. The installed-provider regression now supplies explicit synthetic
capabilities and rejects any attempted authentication/network access.

| Evidence/status | Current result |
|---|---|
| Local protocol and controls | Type checking and deterministic regression coverage for HTTP/SSE, tool batches, replay/history, identity/model constraints, credential storage, cancellation, usage counters, and listener cleanup. |
| Actual-client interoperability | Real Claude Code 2.1.220: synthetic local permission/cancellation checks; ordinary configured fake-HTTPS/Keychain workflows for Sonnet 4.5 and 5.5; and an actual Copilot-backed Sonnet 5.5 route probe plus four-turn Read/Edit/Bash workflow. |
| Live Copilot seat/model access | Verified for the linked account's exact `claude-sonnet-5.5` through the native Copilot enterprise endpoint. Read, Edit and Bash each executed successfully; `alpha` became `beta`, shell verification passed, and Claude returned `CCGC_WORKFLOW_OK`. No real repository content was used. |
| Client scope | CLI-only experimental profile; upstream Desktop gateway configuration is documented, but app interoperability is not implemented. |
| Remote gateway/config-first mode | Active Azure HTTPS route, actual Keychain helper and user settings verified by live ordinary CLI use; test admission explicitly closed afterward. Deterministic checks cover separate owner/access credentials, renewal, expiry/revocation, account/model checks and restart invalidation. Entra/OIDC remains unimplemented. |
| LiteLLM and deployment | Release 1.104.0 plus Prisma 0.15.0 runs on Azure. Thirteen bootstrap and three installed-package checks passed; the latter assert zero network/authentication attempts. Five native Messages requests succeeded for the live probe/workflow. Current runtime image, route descriptor and sanitized evidence are recorded in the Azure runbook. Fault-path retries/refresh and reproducible transitive locking remain open. |
| Azure infrastructure stage | Sweden Central Standard_D2as_v5 VM, 64-GiB encrypted Standard SSD and named network resources provisioned. TLS, authenticated control boundary and source-restricted JIT administration verified. Protected state is populated; all three services are running. Compose requires explicit restart after VM stop/start. |
| Architecture artifact | Separate `docs/diagrams/ccgc-enterprise-runtime.html` and `ccgc-enterprise-provisioning.html` show the proposed enterprise target, with GPT-image posters. `ccgc-automated-solution.html` retains current single-user evidence; `docs/architecture.html` retains the older local alpha. No enterprise deployment is claimed. |
| Release gates | G0 technical live feasibility is demonstrated for this one CLI/model tuple. Formal broader G1/G2/G3 completion is not declared: fault-path retry/refresh, managed-policy coverage, full process cleanup/upgrade matrices, longer live conversations, exact input-token enforcement and performance targets remain incomplete. |

The code is now a remote alpha with scoped live evidence, not a P0-complete remote MVP. Remote mode uses explicit configuration and ordinary `claude`; the separate `ccgc local start` harness retains its stricter launcher. The revised requirements remain targets, not blanket shipped support. See [README](../README.md) for exact commands, bounds, authorization steps and unresolved runtime/managed-policy/storage gates. The live proof establishes the observed seat/model path, not vendor endorsement, a general organizational-policy determination or compatibility with other client/model versions.

### 2026-11-08 direct-key and Desktop evidence update

The current enterprise pilot uses per-user LiteLLM virtual keys and each
user's own LiteLLM GitHub Copilot OAuth connection. The TypeScript client
exports secret-free Desktop configuration through `desktop-config`, using
the documented Gateway mode and a Keychain credential helper. This is
independent of the CLI settings file; earlier shared-settings checks must
not be treated as Desktop routing evidence.

Claude Code CLI 2.1.319 and Desktop 4.23118.0 Code each completed an isolated
Read-tool workflow on Sonnet 5.5. Desktop requests were recorded under the
intended LiteLLM user on `github_copilot/claude-sonnet-5.5`. Sonnet 5, Haiku
5.5, and Haiku 4.5 also passed Messages API inference and actual CLI Read
workflows with exact model selection. The configured Opus
5.5 route returned GitHub `model_not_supported`, with no fallback. Model
discovery reflects configured allowlists, not a guarantee of upstream
availability. Desktop Chat/Cowork workflows, other client/model combinations,
and the remaining production gates are not established by this evidence.

The project is an independent compatibility experiment, not affiliated with, endorsed by, or supported by GitHub or Anthropic. Their product names remain their respective trademarks. Technical feasibility, SDK licensing, service entitlement, organizational authorization, and vendor support are distinct questions.
