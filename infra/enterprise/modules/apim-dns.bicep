param apimName string
param privateIp string
param vnetId string
param vnetName string
param tags object

resource zone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: 'azure-api.net'
  location: 'global'
  tags: tags
}

resource link 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: zone
  name: 'link-${vnetName}'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnetId
    }
  }
}

resource gateway 'Microsoft.Network/privateDnsZones/A@2024-06-01' = {
  parent: zone
  name: apimName
  properties: {
    ttl: 60
    aRecords: [
      {
        ipv4Address: privateIp
      }
    ]
  }
}
