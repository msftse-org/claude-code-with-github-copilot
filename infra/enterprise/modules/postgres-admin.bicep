param serverName string
param tenantId string
param principalObjectId string
param principalName string

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' existing = {
  name: serverName
}

resource administrator 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = {
  parent: server
  name: principalObjectId
  properties: {
    principalName: principalName
    principalType: 'ServicePrincipal'
    tenantId: tenantId
  }
}
