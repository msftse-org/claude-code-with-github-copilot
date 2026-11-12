# Enterprise runbook

This runbook deploys and operates the central LiteLLM gateway that lets
employees use Claude Code with their own GitHub Copilot seats. See the
[README](../README.md) for the architecture and compatibility guidance.

## What gets deployed

Terraform ([`infra/terraform`](../infra/terraform), the default) and Bicep
([`infra/main.bicep`](../infra/main.bicep)) are two equivalent definitions of
the same platform. Both read their settings from
[`infra/solution.json`](../infra/solution.json) and create resource group
`rg-<prefix>-enterprise` in the selected Azure region. Defaults are prefix
`ccgc-pilot` and region `swedencentral`; override them with `--prefix` and
`--location`.

### Azure resources

Names use `<prefix>`, `<compact-prefix>` (the prefix without dashes), and
`<suffix>`, a unique string derived from the subscription, resource group,
prefix, and name seed. Settings come from `infra/solution.json`. Sizes and
SKUs shown are for the optional `enterprise` size; see
[Deployment sizes](#deployment-sizes) for the default, smaller `poc` size.

Resource group `rg-<prefix>-enterprise`:

| Resource | Name | Configuration |
|---|---|---|
| Managed identity | `id-<prefix>-litellm` | User-assigned; the app reads Key Vault secrets with it |
| Log Analytics workspace | `log-<prefix>-enterprise` | Pay-as-you-go, 30-day retention |
| Virtual network | `vnet-<prefix>-enterprise` | `10.80.0.0/16` with subnets `snet-container-apps` (`/23`), `snet-postgres` (`/27`), and `snet-private-endpoints` (`/27`) |
| Network security group | `nsg-<prefix>-workload` | On all three subnets; allows VNet traffic, denies inbound internet traffic |
| NAT gateway | `ng-<prefix>-enterprise` | `enterprise` size only. Standard; carries all outbound traffic from Container Apps |
| Public IP address | `pip-<prefix>-egress` | `enterprise` size only. Standard, static; the single egress IP for GitHub organization IP allow lists |
| PostgreSQL flexible server | `psql-<compact-prefix>-<suffix>` | PostgreSQL 16, `Standard_D2ads_v5` General Purpose, zone-redundant HA, 128 GiB (P10) with autogrow, 14-day backups, VNet-only; database `litellm` |
| Private DNS zone | `<compact-prefix>.postgres.database.azure.com` | Linked to the VNet; resolves the PostgreSQL server |
| Key Vault | `kv-<compact-prefix>-<suffix>` | Standard, RBAC, purge protection, public access disabled; secrets `litellm-master-key`, `litellm-salt-key`, and `litellm-database-url`; audit logs go to Log Analytics |
| Private endpoint | `pe-<prefix>-kv` | Key Vault access from the VNet; Azure adds its network interface |
| Private DNS zone | `privatelink.vaultcore.azure.net` | Linked to the VNet; resolves the Key Vault private endpoint |
| Role assignment | Key Vault Secrets User | The managed identity, on the vault |
| Container Apps environment | `cae-<prefix>-enterprise` | VNet-integrated and internal (a private IP in `snet-container-apps`, no public ingress), zone-redundant; Consumption profile plus a dedicated `D4` profile (4 vCPU and 16 GiB per node, 2-6 nodes) that runs LiteLLM; logs and metrics go to Log Analytics |
| Private DNS zone | The environment's default domain, `<unique-name>.<region>.azurecontainerapps.io` | Linked to the VNet; a wildcard `*` A record resolves every app, including the gateway URL, to the environment's private IP |
| Container app | `ca-<prefix>-litellm` | Official `ghcr.io/berriai/litellm:v1.108.3` pinned by digest, 2 CPU / 4 GiB, 2-10 replicas (scales out at 32 concurrent requests), HTTPS ingress, Key Vault secret references, health probes |

Azure Container Apps creates and manages one more resource group,
`ME_cae-<prefix>-enterprise_rg-<prefix>-enterprise_<region>`, with the
environment's load balancer.

The environment is internal, so the gateway URL has no public DNS or public
ingress. Only the VNet and networks connected to it (VPN, peering, or a
zero-trust connector in the VNet) can resolve and reach it. Clients outside
the VNet need DNS for the environment's default domain that answers with its
private IP. GitHub-hosted runners cannot reach the gateway: `deploy.mjs` and
`npm run access` must run from a connected machine, and the employee-access
workflow needs a self-hosted runner in a connected network.

The Terraform engine keeps its state in resource group `rg-<prefix>-tfstate`,
which `deploy.mjs` creates before the first run:

| Resource | Name | Configuration |
|---|---|---|
| Storage account | `sttf<compact-prefix>` plus a hash, 24 characters | StorageV2, Standard ZRS, Microsoft Entra ID authentication only (shared keys disabled), blob versioning, 30-day soft delete; container `tfstate`, blob `<prefix>.tfstate` |
| Role assignment | Storage Blob Data Contributor | Each deployer, on the storage account |
| Network security perimeter | `nsp-<prefix>-tfstate` | Controls network access to the storage account (see below) |

Secrets are write-only arguments, so Terraform state and plans never contain
them.

The state account has no open public endpoint. Network security perimeter
`nsp-<prefix>-tfstate` enforces access to it, and its `terraform-state`
profile holds one inbound rule per deployer (`deployer-<object-id>`) with
that person's current public IPv4 address. `deploy.mjs` refreshes your rule
on every Terraform run. The perimeter also satisfies Azure Policy that
disables public network access on storage accounts without one, such as
Microsoft's SFI-NS2.2.1 policy. Delete a former deployer's rule in the
portal, under the perimeter's **Profiles**.

### GitHub and LiteLLM objects

- **GitHub:** environment `ccgc-admin`, restricted to `main`, with variable
  `LITELLM_URL` and secret `LITELLM_MASTER_KEY` (skipped with
  `--skip-github`).
- **LiteLLM database:** credential `github-copilot-user` (per-user OAuth) and
  one route per Claude model. Enrolling an employee adds an internal user
  with a 90-day key. The employee's GitHub connection is stored encrypted
  with the salt key.

There is no container registry, broker, or custom authentication. LiteLLM
stores its models in PostgreSQL (`STORE_MODEL_IN_DB=True`). The per-user
Copilot provider needs a placeholder token file to start. It is mounted from a
Container Apps secret and is never used for inference.

### Deployment sizes

Choose a size with `--size` on the first deployment; omitting it selects
`poc`. Both sizes keep the same private design: VNet, private PostgreSQL,
private Key Vault, internal LiteLLM, and Log Analytics. `poc` removes redundancy and the static
egress IP.

| Setting | `enterprise` | `poc` (default) |
|---|---|---|
| Intended use | Production: zone redundancy, autoscaling, static egress IP | Proof of concept for a few users, such as four |
| Container Apps environment | Zone-redundant; dedicated `D4` workload profile, 2-6 nodes | Consumption profile only; not zone-redundant |
| LiteLLM container app | 2 CPU / 4 GiB, 2-10 replicas | 1 CPU / 2 GiB, 1-2 replicas |
| PostgreSQL 16 | `Standard_D2ads_v5` General Purpose, zone-redundant HA, 128 GiB (P10), 14-day backups | `Standard_D2ads_v5` General Purpose, no HA, 32 GiB (P4), 7-day backups; autogrow on |
| NAT gateway and static public IP | Yes | No; outbound traffic uses the Container Apps environment's own address, which is not guaranteed to stay the same |
| Estimated monthly cost | About $900 | About $195-250 |

Estimated `poc` monthly cost, at Sweden Central pay-as-you-go list prices in
USD (Azure Retail Prices API, November 2026, 730 hours):

| Item | Estimate |
|---|---|
| Container Apps Consumption: one 1 CPU / 2 GiB replica always running, after the monthly free grant | $22-73 (idle vs. active rate) |
| PostgreSQL `Standard_D2ads_v5` compute | $136.51 |
| PostgreSQL storage, 32 GiB | $4.38 |
| Azure-managed ingress load balancer and public IP of the VNet-integrated environment | $21.90 |
| Key Vault private endpoint | $7.30 |
| Three private DNS zones | $1.50 |
| Log Analytics, Key Vault operations, Terraform state storage, HTTP requests for a few users | Usually $0-5 |

Backups within the provisioned storage size have no extra charge. The
estimates exclude GitHub Copilot seats, taxes, and subscription-level
Microsoft Defender plans. They assume one replica and the Container Apps
free grant is still available in the subscription. Scaling to two replicas,
additional outbound data transfer, or heavy logging increases the bill; this
is not a spending cap. LiteLLM background activity can keep the replica at
the active rate, so budget toward the upper end.

`poc` uses General Purpose `Standard_D2ads_v5` rather than Burstable
`Standard_B2s`: in November 2026, Sweden Central rejected `Standard_B2s` with
`SkuNotAvailable` although `az postgres flexible-server list-skus` listed it.

The `poc` size has not been load-tested. Its trade-offs: one minimum replica
and a server without HA, so maintenance and platform failures can interrupt
service; and an organization IP allow list cannot rely on the egress address.

The size is fixed for a deployment. Azure cannot change environment zone
redundancy or shrink PostgreSQL storage in place, so `deploy.mjs` records the
size in the resource group's `environment` tag and refuses a different
`--size` for an existing deployment. To switch, deploy the other size with a
new `--prefix` and enroll employees again; their users, keys, and GitHub
connections live in the old database.

### Estimated `enterprise` cost

For four employees, the `enterprise` size costs about **$900 a month**,
roughly $225 per employee. The estimate uses pay-as-you-go list prices for
`swedencentral` from the
[Azure Retail Prices API](https://learn.microsoft.com/rest/api/cost-management/retail-prices/azure-retail-prices)
in November 2026 and 730 hours a month, before taxes and discounts. The
charges in Cost Management for a pilot deployment matched these rates.

| Item | Price | USD per month |
|---|---|---:|
| Container Apps, two `D4` nodes (the `enterprise` minimum) | 8 vCPU × $0.057077/h + 32 GiB × $0.004978/h | 449.62 |
| Container Apps dedicated plan management | $0.10/h | 73.00 |
| PostgreSQL compute, primary and HA standby | 2 × `Standard_D2ads_v5` at $0.187/h | 273.02 |
| PostgreSQL storage, 128 GiB on each server | 256 GB × $0.1369 | 35.05 |
| NAT gateway | $0.045/h | 32.85 |
| Container Apps load balancer | $0.025/h | 18.25 |
| Two Standard public IPs, egress and ingress | 2 × $0.005/h | 7.30 |
| Key Vault private endpoint | $0.01/h | 7.30 |
| Three private DNS zones | 3 × $0.50 | 1.50 |
| Usage by four employees | Log Analytics ingestion, NAT and load balancer data, Key Vault operations | 0-5 |
| **Total** | | **≈ 900** |

- Almost all of it is fixed. The cost doesn't depend on the number of
  employees until LiteLLM needs a third `D4` node, at $224.81 a month each.
- A healthy gateway sends under 1 GB of logs a month. The first 5 GB per
  billing account each month are free, then $2.99/GB. Backups up to the
  provisioned storage size, the first 100 GB of internet egress, Terraform
  state storage, and the network security perimeter cost nothing or almost
  nothing.
- Not included: GitHub Copilot seats and any Microsoft Defender for Cloud
  plans enabled on the subscription.

For a proof of concept, deploy the default `poc` size instead (see
[Deployment sizes](#deployment-sizes)). For a middle ground, change
`sizes.enterprise` in `infra/solution.json`. Storage can only grow, so set its
size before the first deployment.

| Change | Saves per month | Trade-off |
|---|---:|---|
| `postgres.highAvailability`: `Disabled` | $154.03 | No standby server in another zone |
| PostgreSQL `Standard_B2s`: `skuTier` `Burstable`, `highAvailability` `Disabled`, `storageSizeGB` `32`, `storageTier` `P4` | $274.64 | Burstable CPU and no HA; Burstable may be rejected in some regions (see `poc`) |
| `minimumCount` of the `D4` workload profile: `1`, and `litellm.minReplicas`: `1` | $224.81 | One gateway replica and no zone redundancy |

The last two changes together bring the total to about $400 a month.

## Prerequisites

- Azure CLI signed in with Owner, or Contributor plus User Access
  Administrator, on the subscription (the deployment assigns a Key Vault role,
  and the Terraform engine grants you Storage Blob Data Contributor on its
  state storage account)
- Terraform `1.11` or newer for the default engine, or Bicep CLI `0.48.1` or
  newer (`az bicep install --version v0.48.1`) for `--engine bicep`
- For Terraform, outbound HTTPS to `https://api.ipify.org`, which reports the
  public IPv4 address that the state perimeter admits. Without it, pass the
  address with `--state-client-ip`.
- Node.js 24 and a checkout of this repository
- GitHub CLI signed in as an administrator of the repository that runs the
  employee-access workflow (`npm run access` needs it only to read
  `LITELLM_URL` when you don't pass `--gateway`)

## Deploy or update

Preview first. The solution does not change without `--confirm-deploy`.

```bash
node scripts/deploy.mjs --subscription <subscription-id>
node scripts/deploy.mjs --subscription <subscription-id> --confirm-deploy
```

These commands default to `poc`. For enterprise sizing, add `--size enterprise`
to both commands. Existing enterprise deployments also require
`--size enterprise`; omitting it fails the size guard rather than resizing
resources. Use a new `--prefix`, such as `ccgc-poc`, to create a separate deployment.

The confirmed run:

1. Creates a private secrets file at
   `~/.config/ccgc/<subscription-id>/<prefix>.json` (mode `0600`) with the
   LiteLLM master key, salt key, and PostgreSQL password. Back it up in your
   password manager. **The salt key encrypts every stored GitHub connection
   and must never change for an existing database.** The script refuses to
   create new secrets for an existing resource group.
2. With Terraform, creates the state storage if needed, admits your public IP
   through the state perimeter, and runs `terraform apply` in a temporary copy
   of `infra/terraform`. With `--engine bicep`, runs
   `az deployment sub create` instead. Either way, the secrets are passed in a
   temporary `0600` file, never on the command line.
3. Waits for `/health/readiness` to report the database connected.
4. Registers the per-user credential `github-copilot-user` and the Claude
   model routes, then waits until every replica advertises them.
5. Sets `LITELLM_URL` and the `LITELLM_MASTER_KEY` secret in the `ccgc-admin`
   GitHub environment, creating the environment restricted to `main` if
   needed. Use `--skip-github` to configure it yourself, or `--github-repo
   owner/repo` to target another repository.
6. Writes the [employee setup file](#employee-setup-file)
   `dist/ccgc-enterprise-setup.command` with this deployment's LiteLLM URL
   built in, and prints its path and SHA-256. Use `--installer <path>` to
   write it elsewhere.

The preview runs `terraform plan` (or `az deployment sub what-if` with
`--engine bicep`). Before anything is deployed, it plans against empty local
state and creates nothing, not even the state storage. Once the state exists,
its only write is refreshing your inbound rule in the state perimeter, and it
plans without taking the state lock.

Re-running is safe and is how you apply template or model changes. Useful
options: `--engine bicep`, `--size`, `--prefix`, `--location`,
`--models claude-sonnet-5.5,...`, `--secrets-file`, `--name-seed`, and
`--state-client-ip <ipv4>` when a VPN or proxy makes Azure see a different
address than `https://api.ipify.org` reports.

On a first deployment, the app's Key Vault references can fail while the new
role assignment propagates. Run the same command again.

## Terraform and Bicep

Both definitions deploy the same resources, names, and settings:

- Values that change, such as the LiteLLM image, sizes, and network ranges,
  live only in `infra/solution.json`. Change a resource in both definitions
  in the same commit.
- Terraform uses only the `azapi` provider, with the same ARM resource types
  and API versions as Bicep. Generated names (Bicep `uniqueString`,
  Terraform `provider::azapi::unique_string`) and the Key Vault role
  assignment name are identical.
- `npm test` fails if resource types, API versions, defaults, or outputs
  drift (`test/iac-parity.test.ts`). `terraform test` checks Terraform's names
  against Bicep's own `uniqueString()` and `guid()` results for a synthetic
  subscription.

Use one engine per deployment. Terraform refuses a resource group that exists
without Terraform state, for example one deployed with Bicep: keep using
`--engine bicep` for it, or import its resources into Terraform state first.

Terraform protects the resource group, PostgreSQL server, and Key Vault with
`prevent_destroy`. If creating one of them fails, Terraform marks it tainted
and the next apply stops with `Instance cannot be destroyed` instead of
replacing it. Inspect the resource, then untaint it, using the state location
that `deploy.mjs` prints. Run a preview first so the state perimeter admits
your current IP:

```bash
export TF_DATA_DIR="$(mktemp -d)"
terraform -chdir=infra/terraform init -backend-config=storage_account_name=<state-account> \
  -backend-config=container_name=tfstate -backend-config=key=<prefix>.tfstate \
  -backend-config=tenant_id=<tenant-id>
terraform -chdir=infra/terraform untaint azapi_resource.postgres
```

## Request and response logging

Use `--store-prompts-in-spend-logs true|false` during deployment, or change an
existing gateway with `npm run logging --`. Omission during deployment preserves
the current policy; new gateways default to off. See [commands, verification,
and retention](LOGGING.md).

## Employee setup file

The repository's `scripts/ccgc-enterprise-macos.sh` has no gateway built in.
Without `--gateway`, it stops before asking for a key. Employees instead run
`ccgc-enterprise-setup.command`: the same script with your LiteLLM URL written
into its `DEFAULT_GATEWAY` line. It contains no secrets. Get it in one of
these ways:

- The confirmed `deploy.mjs` run writes it to `dist/` (step 6 above).
- `npm run installer` rebuilds it from the `LITELLM_URL` variable of the
  `ccgc-admin` GitHub environment. Pass `--gateway https://<litellm-host>`
  to skip GitHub, `--github-repo owner/repo` to read another repository, or
  `--output <path>` to write it elsewhere.
- Each enroll run of the employee-access workflow attaches it as the
  `ccgc-enterprise-setup` artifact, built from `main` and kept for 30 days.

Every build prints the file's SHA-256. Publish it so employees can check the
file with `shasum -a 256`. Employees run the file with
`bash "$HOME/Downloads/ccgc-enterprise-setup.command"`, which works without
the executable bit that the zipped artifact drops.

Rebuild the file after updating the repository so new enrollments get the
current script. Enrolled Macs keep the gateway they enrolled with. If the
LiteLLM URL changes, issue new keys and have employees enroll again with the
rebuilt file.

## Enroll and revoke employees

Every enrollment includes GitHub MCP web search. See [MCP setup and existing-key
migration](GITHUB-MCP.md) before updating previously enrolled employees.

Run **Actions > CCGC employee access** from `main`, or use the CLI:

```bash
gh workflow run ccgc-employee-access.yml -f action=enroll -f github_username=<login>
gh workflow run ccgc-employee-access.yml -f action=revoke -f github_username=<login>
```

### From your computer

`npm run access` does the same from a checkout of this repository, without
GitHub Actions:

```bash
npm run access -- enroll <login>
npm run access -- revoke <login>
```

It reads the master key from the secrets file that `deploy.mjs` wrote
(`~/.config/ccgc/<subscription-id>/<prefix>.json`) and the gateway from the
`ccgc-admin` `LITELLM_URL` variable. Enroll prints the key in your terminal
and writes the employee setup file to `dist/`. Options:

- `--prefix`, `--subscription`, or `--secrets-file` choose the secrets file
  when you have several deployments.
- `--gateway https://<litellm-host>` skips GitHub.
- `--installer <path>` writes the setup file elsewhere.

Another administrator needs a copy of the secrets file from your password
manager, saved with mode `0600`. Local runs leave no Actions run history, but
the users and keys appear in the LiteLLM UI as usual.

### What enroll and revoke do

- **Enroll** creates or reuses the LiteLLM user that matches the GitHub
  account ID and issues a 90-day key. The key covers the Claude models
  LiteLLM currently advertises and is limited to inference, model-info, and
  own-connection routes. The run summary, or your terminal for local runs,
  shows the key and the employee's setup command, along with the setup file
  built for your gateway. Send the key and the file to the employee
  privately. Anyone who can read the run or your terminal output can use the
  key.
- **Renew** by enrolling again. Earlier keys stay valid until they expire or
  are deleted on the LiteLLM UI's **Virtual Keys** page.
- **Revoke** disconnects the employee's GitHub connection and deletes the
  LiteLLM user with all of their keys.
- Keys keep the model list they were issued with. Enroll again after adding
  models.

Consider adding required reviewers to the `ccgc-admin` environment.

## Monitor users and usage

Open `<LITELLM_URL>/ui/`. Sign in as `admin` with the `litellmMasterKey` value
from the secrets file.

- **Internal Users** lists employees. The alias is the GitHub login, and the
  metadata holds the immutable GitHub account ID.
- **Virtual Keys**, **Usage**, and **Logs** show keys, per-user spend, and
  requests. LiteLLM calls Copilot with the key owner's own GitHub token, so
  GitHub records the Copilot usage against that employee's account.
- Each employee's GitHub connection belongs to that employee. The macOS
  `doctor` command checks it with the employee's own key.

## Rotate secrets

- **Master key:** replace `litellmMasterKey` in the secrets file with a new
  `sk-` value and re-run the confirmed deploy. This updates Key Vault, rolls
  a new revision, and updates the GitHub secret. Employee keys are unaffected.
- **Salt key:** never rotate it in place. Rotation requires a new database,
  and every employee must enroll again.

## Rebuild from scratch

1. Revoke employees if needed, then delete the resource group:

   ```bash
   az group delete --name rg-<prefix>-enterprise --yes
   ```

   Terraform's `prevent_destroy` blocks `terraform destroy` on purpose. Keep
   `rg-<prefix>-tfstate`: the next Terraform run drops the deleted resources
   from its state. Azure Monitor keeps the `send-to-workspace` diagnostic
   settings after their resources are deleted and attaches them to the new
   resources. When that makes the apply fail with `already exists`, the deploy
   imports those settings into state and retries the apply once.
2. The Key Vault stays soft-deleted for 90 days with purge protection, which
   reserves its name. Deploy with a new `--name-seed` to get new Key Vault and
   PostgreSQL names.
3. Every employee must enroll again because their users and connections lived
   in the deleted database. The LiteLLM URL changes too, so send the setup
   file that the new deployment writes. The egress IP also changes, so update
   GitHub organization IP allow lists (`enterprise` size).

## Troubleshooting

| Symptom | Check |
|---|---|
| Readiness never reports the database connected, or every request times out (Claude Desktop: "Couldn't load your organization's model list") | `az postgres flexible-server show` must report `Ready`. Subscription automation, such as a nightly cost-control job, can stop the server: start it with `az postgres flexible-server start` and exempt it from the job. LiteLLM reconnects by itself. While the database is down, LiteLLM logs reconnect errors continuously, about 0.8 GB a day in Log Analytics. Otherwise check `az containerapp logs show -n ca-<prefix>-litellm -g rg-<prefix>-enterprise`. |
| Revision fails with a Key Vault reference error | The role assignment was still propagating. Re-run the deploy. |
| Terraform reports that a resource `already exists` and must be imported | The resource exists outside Terraform state, for example from a Bicep deployment. Use `--engine bicep` or import it. The deploy already imports leftover diagnostic settings and retries. If a `diagnosticSettings` ID still fails, delete it with `az monitor diagnostic-settings delete --name <name> --resource <resource-id>` and re-run. |
| Terraform reports `Instance cannot be destroyed` | A protected resource is tainted after a failed create. See [Terraform and Bicep](#terraform-and-bicep). |
| `Cannot read Terraform state` | Your Storage Blob Data Contributor role on the state account has not propagated yet, or you lack it. Wait and re-run. If Azure sees you at a different address than the one in the message (VPN, proxy, split tunnel), re-run with `--state-client-ip <ipv4>`. |
| `Could not detect this machine's public IPv4 address` | `https://api.ipify.org` is blocked or returned something else. Re-run with `--state-client-ip <ipv4>`. |
| Storage reports `publicNetworkAccess: Disabled` on the state account | Azure Policy reset it after a write that did not keep `SecuredByPerimeter`. Re-run the preview or deploy; it restores the setting and the perimeter association. |
| Enrollment or inference fails with a GitHub error | Confirm the employee has a Copilot seat and that any GitHub organization IP allow list includes the egress IP. The `poc` size has no static egress IP; use `enterprise` with IP allow lists. |
| Deploy refuses with `was deployed with size` | The existing deployment uses another size. Pass that `--size`, or deploy the new size with a new `--prefix`. |
| `model_not_supported` from GitHub | The model is not enabled for that Copilot account. There is no fallback. |
| Employee setup reports a settings conflict | The script backs up Claude settings and replaces only the managed keys after explicit confirmation. |
