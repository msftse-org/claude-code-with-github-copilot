resource "azapi_resource" "postgres_dns" {
  type      = "Microsoft.Network/privateDnsZones@2024-06-01"
  parent_id = azapi_resource.group.id
  name      = "${local.compact_prefix}.postgres.database.azure.com"
  location  = "global"
  tags      = local.tags
}

resource "azapi_resource" "postgres_dns_link" {
  type      = "Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01"
  parent_id = azapi_resource.postgres_dns.id
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

resource "azapi_resource" "postgres" {
  type      = "Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01"
  parent_id = azapi_resource.group.id
  name      = local.postgres_name
  location  = var.location
  tags      = local.tags

  body = {
    sku = {
      name = local.settings.postgres.skuName
      tier = local.settings.postgres.skuTier
    }
    properties = {
      version            = local.settings.postgres.version
      administratorLogin = local.settings.postgres.adminLogin
      authConfig = {
        activeDirectoryAuth = "Disabled"
        passwordAuth        = "Enabled"
      }
      backup = {
        backupRetentionDays = local.settings.postgres.backupRetentionDays
        geoRedundantBackup  = "Disabled"
      }
      dataEncryption = {
        type = "SystemManaged"
      }
      highAvailability = {
        mode = local.settings.postgres.highAvailability
      }
      network = {
        delegatedSubnetResourceId   = local.postgres_subnet_id
        privateDnsZoneArmResourceId = azapi_resource.postgres_dns.id
        publicNetworkAccess         = "Disabled"
      }
      storage = {
        storageSizeGB = local.settings.postgres.storageSizeGB
        autoGrow      = "Enabled"
        tier          = local.settings.postgres.storageTier
      }
    }
  }
  sensitive_body = {
    properties = {
      administratorLoginPassword = var.postgres_admin_password
    }
  }

  response_export_values = ["properties.fullyQualifiedDomainName"]

  timeouts {
    create = "90m"
    update = "90m"
    delete = "60m"
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [azapi_resource.postgres_dns_link]
}

resource "azapi_resource" "database" {
  type      = "Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01"
  parent_id = azapi_resource.postgres.id
  name      = "litellm"

  body = {
    properties = {
      charset   = "UTF8"
      collation = "en_US.utf8"
    }
  }
}
