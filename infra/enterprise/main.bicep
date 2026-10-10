targetScope = 'subscription'

@minLength(3)
@maxLength(18)
@description('Lowercase deployment prefix used for globally unique enterprise resource names.')
param prefix string

@allowed(['swedencentral'])
param location string = 'swedencentral'

@description('Microsoft Entra tenant accepted by the broker.')
param tenantId string

@description('Application ID URI or client ID expected in broker access tokens.')
param entraAudience string

@description('Object ID of the separately governed PostgreSQL Entra administrator.')
param postgresAdminObjectId string

@description('Display name of the PostgreSQL Entra administrator.')
param postgresAdminName string

@description('Immutable broker container image, preferably an ACR digest.')
param brokerImage string

@description('Optional APIM adds centralized private API governance. LiteLLM remains the Copilot protocol connector.')
param enableApim bool = false

@description('APIM publisher contact, required only when enableApim is true.')
param apimPublisherEmail string = ''

var resourceGroupName = 'rg-${prefix}-enterprise'

resource resourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: {
    project: 'claude-code-with-github-copilot'
    environment: 'enterprise'
    managedBy: 'bicep'
  }
}

module platform 'modules/platform.bicep' = {
  name: '${prefix}-enterprise-platform'
  scope: resourceGroup
  params: {
    prefix: prefix
    location: location
    tenantId: tenantId
    entraAudience: entraAudience
    postgresAdminObjectId: postgresAdminObjectId
    postgresAdminName: postgresAdminName
    brokerImage: brokerImage
    enableApim: enableApim
    apimPublisherEmail: apimPublisherEmail
  }
}

output resourceGroupName string = resourceGroup.name
output brokerInternalFqdn string = platform.outputs.brokerInternalFqdn
output apimGatewayUrl string = platform.outputs.apimGatewayUrl
output keyVaultName string = platform.outputs.keyVaultName
output postgresHost string = platform.outputs.postgresHost
output registryName string = platform.outputs.registryName
