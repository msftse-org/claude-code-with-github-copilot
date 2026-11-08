resource "azapi_resource" "group" {
  type      = "Microsoft.Resources/resourceGroups@2024-11-01"
  parent_id = "/subscriptions/${local.subscription_id}"
  name      = "rg-${var.prefix}-enterprise"
  location  = var.location
  tags      = local.tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "azapi_resource" "identity" {
  type      = "Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30"
  parent_id = azapi_resource.group.id
  name      = "id-${var.prefix}-litellm"
  location  = var.location
  tags      = local.tags

  response_export_values = ["properties.principalId"]
}

resource "azapi_resource" "workspace" {
  type      = "Microsoft.OperationalInsights/workspaces@2023-09-01"
  parent_id = azapi_resource.group.id
  name      = "log-${var.prefix}-enterprise"
  location  = var.location
  tags      = local.tags

  body = {
    properties = {
      retentionInDays = local.settings.logRetentionDays
      sku = {
        name = "PerGB2018"
      }
    }
  }
}
