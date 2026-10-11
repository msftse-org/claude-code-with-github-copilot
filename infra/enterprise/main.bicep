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

@description('Immutable shared multi-user worker container image, preferably an ACR digest.')
param workerImage string

@description('Immutable LiteLLM Gateway container image built from server/Dockerfile.enterprise-litellm, preferably an ACR digest.')
param litellmImage string

@description('Administrator login for the private LiteLLM PostgreSQL server.')
param litellmPostgresAdminLogin string = 'litellmadmin'

@secure()
@minLength(16)
@description('Administrator password for the private LiteLLM PostgreSQL server.')
param litellmPostgresAdminPassword string

@secure()
@minLength(32)
@description('LiteLLM master key used only for gateway administration.')
param litellmMasterKey string

@secure()
@minLength(32)
@description('Stable LiteLLM encryption salt for database-backed credentials.')
param litellmSaltKey string

@secure()
@minLength(32)
@description('Shared HMAC secret used only for short-lived broker-to-worker dispatch assertions.')
param dispatchSigningSecret string

@secure()
@description('Base64-encoded 32-byte key used for client-side encryption of durable worker checkpoints.')
param checkpointEncryptionKey string

@description('Unix epoch expiration applied to broker/worker cryptographic secrets; rotate before this time.')
param cryptographicSecretExpiration int

@description('Reviewed Claude model catalog consumed by the shared worker.')
param modelsJson string = '{"models":[{"id":"claude-sonnet-5.5","responseIds":["claude-sonnet-5-5"],"contextWindow":200000,"maxOutput":16384}]}'

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
    workerImage: workerImage
    litellmImage: litellmImage
    litellmPostgresAdminLogin: litellmPostgresAdminLogin
    litellmPostgresAdminPassword: litellmPostgresAdminPassword
    litellmMasterKey: litellmMasterKey
    litellmSaltKey: litellmSaltKey
    dispatchSigningSecret: dispatchSigningSecret
    checkpointEncryptionKey: checkpointEncryptionKey
    cryptographicSecretExpiration: cryptographicSecretExpiration
    modelsJson: modelsJson
  }
}

output resourceGroupName string = resourceGroup.name
output brokerInternalFqdn string = platform.outputs.brokerInternalFqdn
output workerInternalFqdn string = platform.outputs.workerInternalFqdn
output litellmInternalFqdn string = platform.outputs.litellmInternalFqdn
output keyVaultName string = platform.outputs.keyVaultName
output postgresHost string = platform.outputs.postgresHost
output litellmPostgresHost string = platform.outputs.litellmPostgresHost
output registryName string = platform.outputs.registryName
output checkpointStorageName string = platform.outputs.checkpointStorageName
