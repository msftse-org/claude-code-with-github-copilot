# Error Journal

Durable record of failed actions, errors, fixes, and prevention guidance for agents working in this repository. Newest entries appear first.

## Entries

### 2026-11-26 - Database deletion failed while PostgreSQL was stopped

- **Status:** Workaround
- **Context:** AzAPI deletion of `Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01`.
- **Failed action:** Terraform destroy of the application database while its parent server was `Stopped`.
- **Error:** Azure asynchronous deletion returned `status: Failed` after approximately 13 minutes without a detailed error code.
- **Cause:** Unknown; the parent server was stopped during the failed request.
- **Resolution:** With explicit approval for temporary compute cost, started the existing server, verified `Ready`, and generated a fresh live-refreshed plan containing only the nine remaining approved deletions. Terraform then deleted the child database and proceeded to delete its parent server.
- **Prevention:** Check the server state before child-database teardown. If deletion fails while stopped, obtain approval to start it temporarily and retry Terraform; do not silently forget the database.
- **Related:** No replacement environment is authorized.

### 2026-11-26 - Azure connectivity interrupted Terraform destruction

- **Status:** Workaround
- **Context:** Terraform Azure backend and AzAPI deletion during pilot teardown.
- **Failed action:** Applying the reviewed destroy plan.
- **Error:** `NameResolutionError` for `login.microsoftonline.com`; failed state persistence and lock release; subsequent backend access returned network security perimeter HTTP 403.
- **Cause:** Azure authentication connectivity failed during apply. The existing deployer perimeter rule no longer admitted the current public address.
- **Resolution:** Restored connectivity, refreshed only the existing deployer's inbound `/32` rule, verified the failed apply had exited, released its matching abandoned lock, and pushed its private recovery state without forcing a lineage or serial override. Subsequent Terraform destruction completed; empty state and a final no-change destroy plan were verified.
- **Prevention:** Keep the backend until teardown verification completes. Preserve `errored.tfstate` privately and reconcile it before retrying; never unlock an active writer.
- **Related:** Key Vault secret deletion limitation below.

### 2026-11-26 - ARM cannot delete individual Key Vault secrets

- **Status:** Workaround
- **Context:** `infra/terraform/key_vault.tf`, AzAPI 2.13.0, `Microsoft.KeyVault/vaults/secrets@2024-11-01`.
- **Failed action:** Terraform destroy of the three ARM-managed secrets.
- **Error:** HTTP 405 `DeleteNotSupported`: `The resource type does not support delete operation.`
- **Cause:** The ARM child-resource endpoint used to write secrets does not support DELETE.
- **Resolution:** With explicit approval, removed only the three secret bindings from state so Terraform could delete their entire parent vault. Terraform reported vault destruction complete and Azure Activity Log confirmed `Microsoft.KeyVault/vaults/delete` succeeded. Purge protection remains enabled.
- **Prevention:** For full teardown, explicitly approve and document child-state repair, then verify parent-vault deletion. Removing bindings alone is not destruction.
- **Related:** Repository lifecycle safeguards remain unchanged.
