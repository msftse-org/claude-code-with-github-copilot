targetScope = 'subscription'

@description('Short name for every resource, for example ccgc-pilot. The resource group is rg-<prefix>-enterprise.')
@minLength(3)
@maxLength(16)
param prefix string = 'ccgc-pilot'

@description('Azure region for every resource.')
param location string = 'swedencentral'

@description('Deployment size from solution.json: poc (Consumption, General Purpose PostgreSQL without HA, no NAT) or enterprise (zone-redundant, NAT egress).')
@allowed([
  'enterprise'
  'poc'
])
param size string = 'poc'

@description('Seed for globally unique names. Change it only to rebuild while a deleted Key Vault name is still reserved by purge protection.')
@minLength(1)
@maxLength(16)
param nameSeed string = 'litellm2'

@secure()
@minLength(16)
param postgresAdminPassword string

@secure()
@minLength(19)
param litellmMasterKey string

@secure()
@minLength(16)
param litellmSaltKey string

// Shared with infra/terraform so both deployments create the same solution.
var settings = loadJsonContent('solution.json')

resource group 'Microsoft.Resources/resourceGroups@2024-11-01' = {
  name: 'rg-${prefix}-enterprise'
  location: location
  tags: union(settings.tags, { environment: size })
}

module litellm 'modules/litellm.bicep' = {
  name: '${prefix}-litellm'
  scope: group
  params: {
    prefix: prefix
    location: location
    size: size
    nameSeed: nameSeed
    postgresAdminPassword: postgresAdminPassword
    litellmMasterKey: litellmMasterKey
    litellmSaltKey: litellmSaltKey
  }
}

output resourceGroupName string = group.name
output litellmUrl string = litellm.outputs.litellmUrl
output keyVaultName string = litellm.outputs.keyVaultName
output egressIp string = litellm.outputs.egressIp
