targetScope = 'subscription'

@description('Short name for every resource, for example ccgc-pilot. The resource group is rg-<prefix>-enterprise.')
@minLength(3)
@maxLength(16)
param prefix string = 'ccgc-pilot'

@description('Azure region for every resource.')
param location string = 'swedencentral'

@description('Seed for globally unique names. Change it only to rebuild while a deleted Key Vault name is still reserved by purge protection.')
@minLength(1)
@maxLength(16)
param nameSeed string = 'litellm'

@description('Official LiteLLM image, pinned by digest.')
param litellmImage string = 'ghcr.io/berriai/litellm:v1.108.3@sha256:f14d0a035d84d1a8bc98538faf5999e456641fd4cfa191822fd4be1934c1f4f6'

@description('PostgreSQL administrator login used only by LiteLLM.')
param postgresAdminLogin string = 'litellmadmin'

@secure()
@minLength(16)
param postgresAdminPassword string

@secure()
@minLength(19)
param litellmMasterKey string

@secure()
@minLength(16)
param litellmSaltKey string

var tags = {
  project: 'claude-code-with-github-copilot'
  environment: 'enterprise'
  managedBy: 'bicep'
}

resource group 'Microsoft.Resources/resourceGroups@2024-11-01' = {
  name: 'rg-${prefix}-enterprise'
  location: location
  tags: tags
}

module litellm 'modules/litellm.bicep' = {
  name: '${prefix}-litellm'
  scope: group
  params: {
    prefix: prefix
    location: location
    nameSeed: nameSeed
    tags: tags
    litellmImage: litellmImage
    postgresAdminLogin: postgresAdminLogin
    postgresAdminPassword: postgresAdminPassword
    litellmMasterKey: litellmMasterKey
    litellmSaltKey: litellmSaltKey
  }
}

output resourceGroupName string = group.name
output litellmUrl string = litellm.outputs.litellmUrl
output keyVaultName string = litellm.outputs.keyVaultName
output egressIp string = litellm.outputs.egressIp
