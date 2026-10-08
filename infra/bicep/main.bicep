targetScope = 'subscription'

@description('Unique deployment name. Use a new name for each independently managed host.')
@minLength(3)
@maxLength(32)
param deploymentName string

@description('Reviewed region; changing regions requires a new compatibility and cost review.')
@allowed(['swedencentral'])
param location string = 'swedencentral'

@description('Public operator IPv4 address without a suffix. SSH is JIT-only, /32, maximum one hour.')
param operatorIpv4Address string

@description('Public SSH key only. Private keys and provider credentials never enter IaC.')
param sshPublicKey string

@description('Stable creation timestamp supplied by the deployment coordinator.')
param createdAt string

var tags = {
  project: 'claude-code-with-github-copilot'
  'ccgc-deployment': deploymentName
  'created-at': createdAt
  'managed-by': 'ccgc-bicep'
}

resource group 'Microsoft.Resources/resourceGroups@2023-07-01' = {
  name: 'rg-${deploymentName}'
  location: location
  tags: tags
}

module host '../vm.bicep' = {
  name: '${deploymentName}-host'
  scope: group
  params: {
    location: location
    sessionTags: tags
    vmName: 'vm-${deploymentName}'
    osDiskName: 'osdisk-${deploymentName}'
    publicIpName: 'pip-${deploymentName}'
    dnsLabel: deploymentName
    vnetName: 'vnet-${deploymentName}'
    subnetName: 'subnet-${deploymentName}'
    nsgName: 'nsg-${deploymentName}'
    nicName: 'nic-${deploymentName}'
    ipConfigurationName: 'ipconfig'
    vmSize: 'Standard_D2as_v5'
    adminUsername: 'ccgcadmin'
    operatorIpv4Address: operatorIpv4Address
    sshPublicKey: sshPublicKey
  }
}

output resourceGroupName string = group.name
output vmName string = host.outputs.vmName
output vmId string = host.outputs.vmId
output publicIpAddress string = host.outputs.publicIpAddress
output publicFqdn string = host.outputs.publicFqdn
output gatewayUrl string = host.outputs.gatewayUrl
output adminUsername string = host.outputs.adminUsername
output sshAccessPolicyId string = host.outputs.sshAccessPolicyId
