locals {
  tags = {
    project         = "claude-code-with-github-copilot"
    ccgc-deployment = var.deployment_name
    created-at      = var.created_at
    managed-by      = "ccgc-terraform"
  }
}

resource "azapi_resource" "group" {
  type      = "Microsoft.Resources/resourceGroups@2023-07-01"
  name      = "rg-${var.deployment_name}"
  parent_id = "/subscriptions/${var.subscription_id}"
  location  = var.location
  tags      = local.tags
  body      = {}

  lifecycle {
    prevent_destroy = true
  }
}

resource "azapi_resource" "public_ip" {
  type      = "Microsoft.Network/publicIPAddresses@2025-03-01"
  name      = "pip-${var.deployment_name}"
  parent_id = azapi_resource.group.id
  location  = var.location
  tags      = local.tags
  body = {
    sku = { name = "Standard", tier = "Regional" }
    properties = {
      publicIPAllocationMethod = "Static"
      publicIPAddressVersion   = "IPv4"
      dnsSettings              = { domainNameLabel = var.deployment_name }
    }
  }
  response_export_values = ["properties.ipAddress", "properties.dnsSettings.fqdn"]
}

resource "azapi_resource" "network_security" {
  type      = "Microsoft.Network/networkSecurityGroups@2025-03-01"
  name      = "nsg-${var.deployment_name}"
  parent_id = azapi_resource.group.id
  location  = var.location
  tags      = local.tags
  body = {
    properties = {
      securityRules = [
        for rule in [
          { name = "allow-http-public", priority = 1000, port = "80", access = "Allow", protocol = "Tcp", source = "Internet" },
          { name = "allow-https-public", priority = 1001, port = "443", access = "Allow", protocol = "Tcp", source = "Internet" },
          { name = "deny-all-other-inbound", priority = 4095, port = "*", access = "Deny", protocol = "*", source = "*" },
          ] : {
          name = rule.name
          properties = {
            access                   = rule.access
            direction                = "Inbound"
            priority                 = rule.priority
            protocol                 = rule.protocol
            sourceAddressPrefix      = rule.source
            sourcePortRange          = "*"
            destinationAddressPrefix = "*"
            destinationPortRange     = rule.port
          }
        }
      ]
    }
  }

  # Defender owns additional JIT rules after initial provisioning.
  lifecycle {
    ignore_changes = [body.properties.securityRules]
  }
}

resource "azapi_resource" "network" {
  type      = "Microsoft.Network/virtualNetworks@2025-03-01"
  name      = "vnet-${var.deployment_name}"
  parent_id = azapi_resource.group.id
  location  = var.location
  tags      = local.tags
  body = {
    properties = {
      addressSpace = { addressPrefixes = ["10.42.0.0/24"] }
      subnets = [{
        name = "subnet-${var.deployment_name}"
        properties = {
          addressPrefix        = "10.42.0.0/24"
          networkSecurityGroup = { id = azapi_resource.network_security.id }
        }
      }]
    }
  }
}

resource "azapi_resource" "interface" {
  type      = "Microsoft.Network/networkInterfaces@2025-03-01"
  name      = "nic-${var.deployment_name}"
  parent_id = azapi_resource.group.id
  location  = var.location
  tags      = local.tags
  body = {
    properties = {
      ipConfigurations = [{
        name = "ipconfig"
        properties = {
          privateIPAllocationMethod = "Dynamic"
          publicIPAddress           = { id = azapi_resource.public_ip.id }
          subnet                    = { id = "${azapi_resource.network.id}/subnets/subnet-${var.deployment_name}" }
        }
      }]
    }
  }
}

resource "azapi_resource" "host" {
  type      = "Microsoft.Compute/virtualMachines@2026-03-01"
  name      = "vm-${var.deployment_name}"
  parent_id = azapi_resource.group.id
  location  = var.location
  tags      = local.tags
  body = {
    properties = {
      hardwareProfile = { vmSize = "Standard_D2as_v5" }
      securityProfile = {
        securityType     = "TrustedLaunch"
        encryptionAtHost = true
        uefiSettings     = { secureBootEnabled = true, vTpmEnabled = true }
      }
      storageProfile = {
        imageReference = {
          publisher = "Canonical"
          offer     = "ubuntu-24_04-lts"
          sku       = "server"
          version   = "24.04.202609040"
        }
        osDisk = {
          name         = "osdisk-${var.deployment_name}"
          caching      = "ReadWrite"
          createOption = "FromImage"
          diskSizeGB   = 64
          deleteOption = "Detach"
          managedDisk  = { storageAccountType = "StandardSSD_LRS" }
        }
      }
      osProfile = {
        computerName  = "vm-${var.deployment_name}"
        adminUsername = "ccgcadmin"
        customData    = filebase64("${path.module}/../cloud-init.yaml")
        linuxConfiguration = {
          disablePasswordAuthentication = true
          provisionVMAgent              = true
          ssh = { publicKeys = [{
            path    = "/home/ccgcadmin/.ssh/authorized_keys"
            keyData = var.ssh_public_key
          }] }
        }
      }
      networkProfile = {
        networkInterfaces = [{ id = azapi_resource.interface.id, properties = { primary = true } }]
      }
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "azapi_resource" "ssh_access" {
  type      = "Microsoft.Security/locations/jitNetworkAccessPolicies@2020-01-01"
  name      = "ccgc-ssh"
  parent_id = "${azapi_resource.group.id}/providers/Microsoft.Security/locations/${var.location}"
  body = {
    kind = "Basic"
    properties = {
      virtualMachines = [{
        id = azapi_resource.host.id
        ports = [{
          number                     = 22
          protocol                   = "TCP"
          allowedSourceAddressPrefix = "${var.operator_ipv4_address}/32"
          maxRequestAccessDuration   = "PT1H"
        }]
      }]
    }
  }
}
