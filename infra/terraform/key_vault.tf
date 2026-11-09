resource "azapi_resource" "vault" {
  type      = "Microsoft.KeyVault/vaults@2024-11-01"
  parent_id = azapi_resource.group.id
  name      = local.vault_name
  location  = var.location
  tags      = local.tags

  body = {
    properties = {
      tenantId                  = var.tenant_id
      enablePurgeProtection     = true
      enableRbacAuthorization   = true
      enableSoftDelete          = true
      softDeleteRetentionInDays = 90
      publicNetworkAccess       = "Disabled"
      networkAcls = {
        bypass        = "None"
        defaultAction = "Deny"
      }
      sku = {
        family = "A"
        name   = "standard"
      }
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

# Secret values are write-only: Terraform sends them to Azure but never stores
# them in state or plans. The vault is private, so secrets are written through
# the Azure Resource Manager control plane, as the Bicep deployment does.
resource "azapi_resource" "database_url_secret" {
  type      = "Microsoft.KeyVault/vaults/secrets@2024-11-01"
  parent_id = azapi_resource.vault.id
  name      = "litellm-database-url"

  body = {
    properties = {
      contentType = "application/vnd.ccgc.litellm-database-url"
    }
  }
  sensitive_body = {
    properties = {
      value = "postgresql://${local.settings.postgres.adminLogin}:${urlencode(var.postgres_admin_password)}@${azapi_resource.postgres.output.properties.fullyQualifiedDomainName}:5432/${azapi_resource.database.name}?sslmode=require"
    }
  }

  response_export_values = ["properties.secretUriWithVersion"]
}

resource "azapi_resource" "master_key_secret" {
  type      = "Microsoft.KeyVault/vaults/secrets@2024-11-01"
  parent_id = azapi_resource.vault.id
  name      = "litellm-master-key"

  body = {
    properties = {
      contentType = "application/vnd.ccgc.litellm-master-key"
    }
  }
  sensitive_body = {
    properties = {
      value = var.litellm_master_key
    }
  }

  response_export_values = ["properties.secretUriWithVersion"]
}

resource "azapi_resource" "salt_key_secret" {
  type      = "Microsoft.KeyVault/vaults/secrets@2024-11-01"
  parent_id = azapi_resource.vault.id
  name      = "litellm-salt-key"

  body = {
    properties = {
      contentType = "application/vnd.ccgc.litellm-salt-key"
    }
  }
  sensitive_body = {
    properties = {
      value = var.litellm_salt_key
    }
  }

  response_export_values = ["properties.secretUriWithVersion"]
}

resource "azapi_resource" "vault_diagnostics" {
  type      = "Microsoft.Insights/diagnosticSettings@2021-05-01-preview"
  parent_id = azapi_resource.vault.id
  name      = "send-to-workspace"

  body = {
    properties = {
      workspaceId = azapi_resource.workspace.id
      # Azure returns every category group in this order; listing the disabled one keeps plans clean.
      logs = [
        {
          categoryGroup = "audit"
          enabled       = true
        },
        {
          categoryGroup = "allLogs"
          enabled       = false
        },
      ]
    }
  }
}

resource "azapi_resource" "vault_dns" {
  type      = "Microsoft.Network/privateDnsZones@2024-06-01"
  parent_id = azapi_resource.group.id
  name      = "privatelink.vaultcore.azure.net"
  location  = "global"
  tags      = local.tags
}

resource "azapi_resource" "vault_dns_link" {
  type      = "Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01"
  parent_id = azapi_resource.vault_dns.id
  name      = "link-${local.vnet_name}"
  location  = "global"

  body = {
    properties = {
      registrationEnabled = false
      virtualNetwork = {
        id = azapi_resource.vnet.id
      }
    }
  }
}

resource "azapi_resource" "vault_endpoint" {
  type      = "Microsoft.Network/privateEndpoints@2024-07-01"
  parent_id = azapi_resource.group.id
  name      = "pe-${var.prefix}-kv"
  location  = var.location
  tags      = local.tags

  body = {
    properties = {
      subnet = {
        id = local.private_endpoints_subnet_id
      }
      privateLinkServiceConnections = [
        {
          name = "connection"
          properties = {
            privateLinkServiceId = azapi_resource.vault.id
            groupIds             = ["vault"]
          }
        },
      ]
    }
  }

  depends_on = [azapi_resource.vault_dns_link]
}

resource "azapi_resource" "vault_dns_group" {
  type      = "Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-07-01"
  parent_id = azapi_resource.vault_endpoint.id
  name      = "default"

  body = {
    properties = {
      privateDnsZoneConfigs = [
        {
          name = "vault"
          properties = {
            privateDnsZoneId = azapi_resource.vault_dns.id
          }
        },
      ]
    }
  }
}

resource "azapi_resource" "litellm_key_vault_access" {
  type      = "Microsoft.Authorization/roleAssignments@2022-04-01"
  parent_id = azapi_resource.vault.id
  # Same name as Bicep's guid(vault.id, identity.id, 'Key Vault Secrets User').
  name = uuidv5(local.arm_guid_namespace, "${azapi_resource.vault.id}-${azapi_resource.identity.id}-Key Vault Secrets User")

  body = {
    properties = {
      principalId      = azapi_resource.identity.output.properties.principalId
      principalType    = "ServicePrincipal"
      roleDefinitionId = "/subscriptions/${local.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/${local.key_vault_secrets_user}"
    }
  }
}
