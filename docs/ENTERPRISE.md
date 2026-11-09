# Enterprise runbook

This runbook deploys and operates the central LiteLLM gateway that lets
employees use Claude Code with their own GitHub Copilot seats. See the
[README](../README.md) for the architecture and current evidence.

## What gets deployed

Terraform ([`infra/terraform`](../infra/terraform), the default) and Bicep
([`infra/main.bicep`](../infra/main.bicep)) are two equivalent definitions of
the same platform. Both read their settings from
[`infra/solution.json`](../infra/solution.json) and create resource group
`rg-<prefix>-enterprise` (default prefix `ccgc-pilot`) in Sweden Central with:

| Resource | Configuration |
|---|---|
| Container Apps environment `cae-<prefix>-enterprise` | VNet-integrated, external ingress, zone-redundant, dedicated `D4` workload profile (2-6 nodes) |
| Container app `ca-<prefix>-litellm` | Official `ghcr.io/berriai/litellm:v1.108.3` pinned by digest, 2 CPU / 4 GiB, 2-10 replicas, health probes |
| PostgreSQL Flexible Server 16 | `Standard_D2ads_v5`, zone-redundant HA, 128 GiB with autogrow, 14-day backups, VNet-only, no public access |
| Key Vault | RBAC, purge protection, public access disabled, private endpoint; holds the master key, salt key, and database URL |
| NAT gateway and static public IP | Single egress IP for GitHub organization IP allow lists |
| VNet, NSG, private DNS zones | Container Apps, PostgreSQL, and private endpoint subnets |
| Log Analytics `log-<prefix>-enterprise` | Container Apps and Key Vault audit logs, 30-day retention |
| Managed identity `id-<prefix>-litellm` | Key Vault Secrets User for the app's secret references |

Terraform keeps its state in resource group `rg-<prefix>-tfstate`: a
zone-redundant storage account that accepts only Microsoft Entra ID
authentication (shared keys disabled), with blob versioning and 30-day soft
delete. Secrets are write-only arguments, so Terraform state and plans never
contain them.

The state account has no open public endpoint. Network security perimeter
`nsp-<prefix>-tfstate` enforces access to it, and its `terraform-state`
profile holds one inbound rule per deployer (`deployer-<object-id>`) with
that person's current public IPv4 address. `deploy.mjs` refreshes your rule
on every Terraform run. The perimeter also satisfies Azure Policy that
disables public network access on storage accounts without one, such as
Microsoft's SFI-NS2.2.1 policy. Delete a former deployer's rule in the
portal, under the perimeter's **Profiles**.

There is no container registry, broker, or custom authentication. LiteLLM
stores its models in PostgreSQL (`STORE_MODEL_IN_DB=True`). The per-user
Copilot provider needs a placeholder token file to start. It is mounted from a
Container Apps secret and is never used for inference.

The main cost drivers are the zone-redundant PostgreSQL server, which bills
for two compute nodes, and at least two `D4` workload profile nodes.

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
  employee-access workflow

## Deploy or update

Preview first. The solution does not change without `--confirm-deploy`.

```bash
node scripts/deploy.mjs --subscription <subscription-id>
node scripts/deploy.mjs --subscription <subscription-id> --confirm-deploy
```

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

The preview runs `terraform plan` (or `az deployment sub what-if` with
`--engine bicep`). Before anything is deployed, it plans against empty local
state and creates nothing, not even the state storage. Once the state exists,
its only write is refreshing your inbound rule in the state perimeter, and it
plans without taking the state lock.

Re-running is safe and is how you apply template or model changes. Useful
options: `--engine bicep`, `--prefix`, `--location`,
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
  against the names Azure assigned to a Bicep deployment.

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

## Enroll and revoke employees

Run **Actions > CCGC employee access** from `main`, or use the CLI:

```bash
gh workflow run ccgc-employee-access.yml -f action=enroll -f github_username=<login>
gh workflow run ccgc-employee-access.yml -f action=revoke -f github_username=<login>
```

- **Enroll** creates or reuses the LiteLLM user that matches the GitHub
  account ID and issues a 90-day key. The key covers the Claude models
  LiteLLM currently advertises and is limited to inference, model-info, and
  own-connection routes. The run summary shows the key and the setup command.
  Send both to the employee privately; anyone who can read the run can use
  the key.
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

1. Revoke employees if needed. Delete the `send-to-workspace` diagnostic
   settings first: Azure Monitor keeps them after their resource is deleted
   and attaches them to a new resource with the same ID, which makes
   Terraform fail with `already exists`.

   ```bash
   rg=rg-<prefix>-enterprise
   for id in $(az resource list -g "$rg" --query "[?type=='Microsoft.App/managedEnvironments' || type=='Microsoft.KeyVault/vaults'].id" -o tsv); do
     az monitor diagnostic-settings delete --name send-to-workspace --resource "$id"
   done
   az group delete --name "$rg" --yes
   ```

   Terraform's `prevent_destroy` blocks `terraform destroy` on purpose. Keep
   `rg-<prefix>-tfstate`: the next Terraform run drops the deleted resources
   from its state.
2. The Key Vault stays soft-deleted for 90 days with purge protection, which
   reserves its name. Deploy with a new `--name-seed` to get new Key Vault and
   PostgreSQL names.
3. Every employee must enroll again because their users and connections lived
   in the deleted database. The egress IP also changes, so update GitHub
   organization IP allow lists.

## Troubleshooting

| Symptom | Check |
|---|---|
| Readiness never reports the database connected | `az postgres flexible-server show` must report `Ready`; external automation can stop the server (`az postgres flexible-server start`). Then check `az containerapp logs show -n ca-<prefix>-litellm -g rg-<prefix>-enterprise`. |
| Revision fails with a Key Vault reference error | The role assignment was still propagating. Re-run the deploy. |
| Terraform reports that a resource `already exists` and must be imported | The resource exists outside Terraform state, for example from a Bicep deployment. Use `--engine bicep` or import it. A `diagnosticSettings/send-to-workspace` ID is a leftover from a deleted resource with the same ID: delete it with `az monitor diagnostic-settings delete --name send-to-workspace --resource <resource-id>` and re-run. |
| Terraform reports `Instance cannot be destroyed` | A protected resource is tainted after a failed create. See [Terraform and Bicep](#terraform-and-bicep). |
| `Cannot read Terraform state` | Your Storage Blob Data Contributor role on the state account has not propagated yet, or you lack it. Wait and re-run. If Azure sees you at a different address than the one in the message (VPN, proxy, split tunnel), re-run with `--state-client-ip <ipv4>`. |
| `Could not detect this machine's public IPv4 address` | `https://api.ipify.org` is blocked or returned something else. Re-run with `--state-client-ip <ipv4>`. |
| Storage reports `publicNetworkAccess: Disabled` on the state account | Azure Policy reset it after a write that did not keep `SecuredByPerimeter`. Re-run the preview or deploy; it restores the setting and the perimeter association. |
| Enrollment or inference fails with a GitHub error | Confirm the employee has a Copilot seat and that any GitHub organization IP allow list includes the egress IP. |
| `model_not_supported` from GitHub | The model is not enabled for that Copilot account. There is no fallback. |
| Employee setup reports a settings conflict | The script backs up Claude settings and replaces only the managed keys after explicit confirmation. |

## Current deployment

Rebuilt from scratch with Terraform on 2026-11-09 (name seed `litellm2`).

| Item | Value |
|---|---|
| LiteLLM | https://ca-ccgc-pilot-litellm.victorioussea-313182e6.swedencentral.azurecontainerapps.io |
| Admin UI | https://ca-ccgc-pilot-litellm.victorioussea-313182e6.swedencentral.azurecontainerapps.io/ui/ |
| Image | `ghcr.io/berriai/litellm:v1.108.3@sha256:f14d0a035d84d1a8bc98538faf5999e456641fd4cfa191822fd4be1934c1f4f6` |
| Resource group | `rg-ccgc-pilot-enterprise` in `swedencentral` |
| Egress IP | `4.223.110.167` |
| Terraform state | `sttfccgcpilot9f38753bbf7/tfstate/ccgc-pilot.tfstate` in `rg-ccgc-pilot-tfstate`, behind `nsp-ccgc-pilot-tfstate` |

Verified after deployment:

- A Terraform plan reports no changes.
- Readiness reports `healthy` with the database connected, and requests
  without a key return 401.
- `/v1/models` lists `claude-sonnet-5.5`, `claude-sonnet-5`, `claude-opus-5.5`,
  `claude-haiku-5.5`, and `claude-haiku-4.5`. Each routes to
  `github_copilot/<model>` through the per-user `github-copilot-user`
  credential.
- The `ccgc-admin` environment holds the new `LITELLM_URL` and
  `LITELLM_MASTER_KEY`.
- The LiteLLM identity holds only Key Vault Secrets User on its vault.

Employees have not enrolled yet, so the live Claude Code results in the
[README](../README.md#evidence) must be re-established.
