// An internal Container Apps environment has no public DNS. This zone resolves its app
// names to the environment's private IP for the VNet and for networks that use the
// VNet's DNS. It is a separate module because the zone is named after the environment's
// default domain, which Azure assigns only when the environment is created.
param defaultDomain string
param staticIp string
param vnetId string
param vnetName string
param tags object

resource environmentDns 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: defaultDomain
  location: 'global'
  tags: tags
}

resource environmentDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: environmentDns
  name: 'link-${vnetName}'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnetId
    }
  }
}

resource environmentDnsWildcard 'Microsoft.Network/privateDnsZones/A@2024-06-01' = {
  parent: environmentDns
  name: '*'
  properties: {
    ttl: 300
    aRecords: [
      {
        ipv4Address: staticIp
      }
    ]
  }
}
