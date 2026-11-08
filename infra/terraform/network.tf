resource "azapi_resource" "nat_public_ip" {
  type      = "Microsoft.Network/publicIPAddresses@2024-07-01"
  parent_id = azapi_resource.group.id
  name      = "pip-${var.prefix}-egress"
  location  = var.location
  tags      = local.tags

  body = {
    sku = {
      name = "Standard"
    }
    properties = {
      publicIPAllocationMethod = "Static"
      publicIPAddressVersion   = "IPv4"
    }
  }

  response_export_values = ["properties.ipAddress"]
}

resource "azapi_resource" "nat_gateway" {
  type      = "Microsoft.Network/natGateways@2024-07-01"
  parent_id = azapi_resource.group.id
  name      = "ng-${var.prefix}-enterprise"
  location  = var.location
  tags      = local.tags

  body = {
    sku = {
      name = "Standard"
    }
    properties = {
      idleTimeoutInMinutes = 10
      publicIpAddresses = [
        {
          id = azapi_resource.nat_public_ip.id
        },
      ]
    }
  }
}

resource "azapi_resource" "workload_nsg" {
  type      = "Microsoft.Network/networkSecurityGroups@2024-07-01"
  parent_id = azapi_resource.group.id
  name      = "nsg-${var.prefix}-workload"
  location  = var.location
  tags      = local.tags

  body = {
    properties = {
      securityRules = [
        {
          name = "allow-vnet-inbound"
          properties = {
            access                   = "Allow"
            direction                = "Inbound"
            priority                 = 100
            protocol                 = "*"
            sourceAddressPrefix      = "VirtualNetwork"
            sourcePortRange          = "*"
            destinationAddressPrefix = "VirtualNetwork"
            destinationPortRange     = "*"
          }
        },
        {
          name = "deny-internet-inbound"
          properties = {
            access                   = "Deny"
            direction                = "Inbound"
            priority                 = 4096
            protocol                 = "*"
            sourceAddressPrefix      = "Internet"
            sourcePortRange          = "*"
            destinationAddressPrefix = "*"
            destinationPortRange     = "*"
          }
        },
      ]
    }
  }
}

resource "azapi_resource" "vnet" {
  type      = "Microsoft.Network/virtualNetworks@2024-07-01"
  parent_id = azapi_resource.group.id
  name      = local.vnet_name
  location  = var.location
  tags      = local.tags

  body = {
    properties = {
      addressSpace = {
        addressPrefixes = [local.settings.network.addressSpace]
      }
      subnets = [
        {
          name = "snet-container-apps"
          properties = {
            addressPrefix = local.settings.network.containerAppsSubnet
            delegations = [
              {
                name = "container-apps"
                properties = {
                  serviceName = "Microsoft.App/environments"
                }
              },
            ]
            natGateway = {
              id = azapi_resource.nat_gateway.id
            }
            networkSecurityGroup = {
              id = azapi_resource.workload_nsg.id
            }
            privateEndpointNetworkPolicies = "Disabled"
          }
        },
        {
          name = "snet-postgres"
          properties = {
            addressPrefix = local.settings.network.postgresSubnet
            delegations = [
              {
                name = "postgres"
                properties = {
                  serviceName = "Microsoft.DBforPostgreSQL/flexibleServers"
                }
              },
            ]
            networkSecurityGroup = {
              id = azapi_resource.workload_nsg.id
            }
            serviceEndpoints = [
              {
                service = "Microsoft.Storage"
              },
            ]
          }
        },
        {
          name = "snet-private-endpoints"
          properties = {
            addressPrefix = local.settings.network.privateEndpointSubnet
            networkSecurityGroup = {
              id = azapi_resource.workload_nsg.id
            }
            privateEndpointNetworkPolicies = "Disabled"
          }
        },
      ]
    }
  }
}

locals {
  container_apps_subnet_id    = "${azapi_resource.vnet.id}/subnets/snet-container-apps"
  postgres_subnet_id          = "${azapi_resource.vnet.id}/subnets/snet-postgres"
  private_endpoints_subnet_id = "${azapi_resource.vnet.id}/subnets/snet-private-endpoints"
}
