targetScope = 'resourceGroup'

@description('Approved Azure region.')
param location string

@description('All five AppOnboard session tags.')
param sessionTags object

@description('Exact VM name approved by the prepare plan.')
param vmName string

@description('Exact managed OS disk name approved by the prepare plan.')
param osDiskName string

@description('Exact public IP resource name approved by the prepare plan.')
param publicIpName string

@description('Exact Azure DNS label approved by the prepare plan.')
param dnsLabel string

@description('Exact virtual network name approved by the prepare plan.')
param vnetName string

@description('Subnet name for the single-host virtual network.')
param subnetName string

@description('Exact network security group name approved by the prepare plan.')
param nsgName string

@description('Exact network interface name approved by the prepare plan.')
param nicName string

@description('NIC IP configuration name. Preserve the original name for the historical deployment.')
param ipConfigurationName string = 'ipconfig-ccgc-dev-87b7'

@description('The only approved VM size for this scaffold.')
@allowed([
  'Standard_D2as_v5'
])
param vmSize string

@description('The only approved administrator account for the host.')
param adminUsername string

@description('Mandatory operator IPv4 address for just-in-time SSH. No permanent SSH allow rule is created.')
@minLength(7)
@maxLength(15)
param operatorIpv4Address string

@description('SSH public key material for the administrator account.')
@minLength(1)
param sshPublicKey string

// 2025-03-01 is the newest live GA Network API version with a schema in Bicep 0.48.1.
// The live provider's 2026-05-01 version was verified but emitted BCP081.
resource publicIp 'Microsoft.Network/publicIPAddresses@2025-03-01' = {
  name: publicIpName
  location: location
  sku: {
    name: 'Standard'
    tier: 'Regional'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
    dnsSettings: {
      domainNameLabel: dnsLabel
    }
  }
  tags: sessionTags
}

resource nsg 'Microsoft.Network/networkSecurityGroups@2025-03-01' = {
  name: nsgName
  location: location
  properties: {
    // Reserve Defender's JIT priority ranges; use access.bicep for access-only updates.
    securityRules: [
      {
        name: 'allow-http-public'
        properties: {
          access: 'Allow'
          direction: 'Inbound'
          priority: 1000
          protocol: 'Tcp'
          sourceAddressPrefix: 'Internet'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '80'
        }
      }
      {
        name: 'allow-https-public'
        properties: {
          access: 'Allow'
          direction: 'Inbound'
          priority: 1001
          protocol: 'Tcp'
          sourceAddressPrefix: 'Internet'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '443'
        }
      }
      {
        name: 'deny-all-other-inbound'
        properties: {
          access: 'Deny'
          direction: 'Inbound'
          priority: 4095
          protocol: '*'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
  tags: sessionTags
}

resource vnet 'Microsoft.Network/virtualNetworks@2025-03-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.42.0.0/24'
      ]
    }
    subnets: [
      {
        name: subnetName
        properties: {
          addressPrefix: '10.42.0.0/24'
          networkSecurityGroup: {
            id: nsg.id
          }
        }
      }
    ]
  }
  tags: sessionTags
}

resource nic 'Microsoft.Network/networkInterfaces@2025-03-01' = {
  name: nicName
  location: location
  properties: {
    ipConfigurations: [
      {
        name: ipConfigurationName
        properties: {
          privateIPAllocationMethod: 'Dynamic'
          publicIPAddress: {
            id: publicIp.id
          }
          subnet: {
            id: vnet.properties.subnets[0].id
          }
        }
      }
    ]
  }
  tags: sessionTags
}

resource osDisk 'Microsoft.Compute/disks@2026-03-02' existing = {
  name: osDiskName
}

resource vm 'Microsoft.Compute/virtualMachines@2026-04-01' = {
  // checkov:skip=CKV_AZURE_50:Defender governance and authenticated Azure Run Command require the VM agent/extension channel.
  name: vmName
  location: location
  properties: {
    hardwareProfile: {
      vmSize: vmSize
    }
    securityProfile: {
      securityType: 'TrustedLaunch'
      encryptionAtHost: true
      uefiSettings: {
        secureBootEnabled: true
        vTpmEnabled: true
      }
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: 'ubuntu-24_04-lts'
        sku: 'server'
        version: '24.04.202609040'
      }
      osDisk: {
        name: osDiskName
        caching: 'ReadWrite'
        createOption: 'FromImage'
        diskSizeGB: 64
        deleteOption: 'Detach'
        managedDisk: {
          storageAccountType: 'StandardSSD_LRS'
        }
      }
    }
    osProfile: {
      computerName: vmName
      adminUsername: adminUsername
      linuxConfiguration: {
        disablePasswordAuthentication: true
        provisionVMAgent: true
        ssh: {
          publicKeys: [
            {
              path: '/home/${adminUsername}/.ssh/authorized_keys'
              keyData: sshPublicKey
            }
          ]
        }
      }
      customData: base64(loadTextContent('cloud-init.yaml'))
    }
    networkProfile: {
      networkInterfaces: [
        {
          id: nic.id
          properties: {
            primary: true
          }
        }
      ]
    }
  }
  tags: sessionTags
}

output resourceGroupName string = resourceGroup().name
output vmName string = vm.name
output vmId string = vm.id
output osDiskId string = osDisk.id
output publicIpAddress string = publicIp.properties.ipAddress
output publicFqdn string = publicIp.properties.dnsSettings.fqdn
output gatewayUrl string = 'https://${publicIp.properties.dnsSettings.fqdn}'
output adminUsername string = adminUsername

module sshAccess './access.bicep' = {
  name: 'vm-access'
  params: {
    location: location
    vmName: vm.name
    operatorIpv4Address: operatorIpv4Address
  }
}

output sshAccessPolicyId string = sshAccess.outputs.policyId
