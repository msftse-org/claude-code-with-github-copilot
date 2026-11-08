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

@description('Deploy the single-tenant control plane, bootstrap job, and CCGC-enabled LiteLLM after immutable images have been published.')
param deployRuntime bool = true

@description('Immutable broker container image, preferably an ACR digest.')
param brokerImage string = ''

@description('Deprecated legacy worker image retained only for explicit migration rollbacks.')
param workerImage string = ''

@description('Deploy the deprecated worker path during a controlled migration rollback.')
param deployLegacyWorker bool = false

@description('Immutable LiteLLM Gateway container image built from server/Dockerfile.enterprise-litellm, preferably an ACR digest.')
param litellmImage string = ''

@allowed([
  'managed'
  'existing'
])
@description('Use the fully managed LiteLLM deployment or attach CCGC to an existing customer LiteLLM.')
param litellmMode string = 'managed'

@description('Existing customer LiteLLM HTTPS origin. Required only when litellmMode is existing.')
param existingLiteLLMUrl string = ''

@description('Workload identity object ID used by the existing LiteLLM deployment.')
param existingLiteLLMPrincipalId string = ''

@description('Microsoft Entra principal name used by the existing LiteLLM workload when connecting to CCGC PostgreSQL.')
param existingLiteLLMDatabasePrincipalName string = ''

@minValue(0)
@maxValue(10)
@description('Number of private ACR task agents. Use zero at rest and scale to one while publishing images.')
param buildAgentPoolCount int = 0

@description('Password administrator login for the shared managed PostgreSQL server. Required only when litellmMode is managed.')
param managedPostgresAdminLogin string = 'ccgcadmin'

@secure()
@description('Password administrator credential used by managed LiteLLM on the shared PostgreSQL server. Required only when litellmMode is managed.')
param managedPostgresAdminPassword string = ''

@secure()
@minLength(32)
@description('LiteLLM master key used only for gateway administration.')
param litellmMasterKey string

@secure()
@description('Stable LiteLLM encryption salt for database-backed credentials.')
param litellmSaltKey string = ''

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
param modelsJson string = '{"models":[{"id":"claude-sonnet-5.5","name":"Claude Sonnet 5.5","responseIds":["claude-sonnet-5.5","claude-sonnet-5-5"],"context":1000000,"output":128000},{"id":"claude-sonnet-5","name":"Claude Sonnet 5","responseIds":["claude-sonnet-5"],"context":1000000,"output":16384},{"id":"claude-opus-5.5","name":"Claude Opus 5.5","responseIds":["claude-opus-5.5","claude-opus-5-5"],"context":1000000,"output":16384},{"id":"claude-haiku-5.5","name":"Claude Haiku 5.5","responseIds":["claude-haiku-5.5","claude-haiku-5-5"],"context":1000000,"output":16384},{"id":"claude-haiku-4.5","name":"Claude Haiku 4.5","responseIds":["claude-haiku-4.5","claude-haiku-4-5","claude-haiku-4-5-20251001"],"context":200000,"output":16384}]}'

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
    deployRuntime: deployRuntime
    brokerImage: brokerImage
    workerImage: workerImage
    deployLegacyWorker: deployLegacyWorker
    litellmImage: litellmImage
    litellmMode: litellmMode
    existingLiteLLMUrl: existingLiteLLMUrl
    existingLiteLLMPrincipalId: existingLiteLLMPrincipalId
    existingLiteLLMDatabasePrincipalName: existingLiteLLMDatabasePrincipalName
    buildAgentPoolCount: buildAgentPoolCount
    managedPostgresAdminLogin: managedPostgresAdminLogin
    managedPostgresAdminPassword: managedPostgresAdminPassword
    litellmMasterKey: litellmMasterKey
    litellmSaltKey: litellmSaltKey
    dispatchSigningSecret: dispatchSigningSecret
    checkpointEncryptionKey: checkpointEncryptionKey
    cryptographicSecretExpiration: cryptographicSecretExpiration
    modelsJson: modelsJson
  }
}

output resourceGroupName string = resourceGroup.name
output brokerPublicFqdn string = platform.outputs.brokerPublicFqdn
output litellmPublicFqdn string = platform.outputs.litellmPublicFqdn
output litellmGatewayUrl string = platform.outputs.litellmGatewayUrl
output bootstrapJobName string = platform.outputs.bootstrapJobName
output workerInternalFqdn string = platform.outputs.workerInternalFqdn
output litellmInternalFqdn string = platform.outputs.litellmInternalFqdn
output keyVaultName string = platform.outputs.keyVaultName
output postgresHost string = platform.outputs.postgresHost
output registryName string = platform.outputs.registryName
output registryLoginServer string = platform.outputs.registryLoginServer
output buildAgentPoolName string = platform.outputs.buildAgentPoolName
output checkpointStorageName string = platform.outputs.checkpointStorageName
