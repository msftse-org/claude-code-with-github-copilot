locals {
  # Shared with infra/main.bicep so both deployments create the same solution.
  settings = jsondecode(file("${path.module}/../solution.json"))
  size     = local.settings.sizes[var.size]
  tags     = merge(local.settings.tags, { environment = var.size })

  subscription_id   = lower(var.subscription_id)
  resource_group_id = "/subscriptions/${local.subscription_id}/resourceGroups/rg-${var.prefix}-enterprise"
  compact_prefix    = replace(var.prefix, "-", "")

  # Same value as Bicep's uniqueString(subscription().id, resourceGroup().id, prefix, nameSeed).
  unique_suffix = lower(provider::azapi::unique_string([
    "/subscriptions/${local.subscription_id}",
    local.resource_group_id,
    var.prefix,
    var.name_seed,
  ]))

  vnet_name     = "vnet-${var.prefix}-enterprise"
  postgres_name = substr("psql-${local.compact_prefix}-${local.unique_suffix}", 0, 63)
  vault_name    = substr("kv-${local.compact_prefix}-${local.unique_suffix}", 0, 24)
  litellm_name  = "ca-${var.prefix}-litellm"

  copilot_token_dir      = "/var/run/ccgc/github-copilot"
  key_vault_secrets_user = "4633458b-17de-408a-b874-0445c86b69e6"

  # Namespace that makes uuidv5 equal to the ARM guid() template function.
  arm_guid_namespace = "11fb06fb-712d-4ddd-98c7-e71bbd588830"
}
