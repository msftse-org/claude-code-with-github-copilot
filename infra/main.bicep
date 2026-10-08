targetScope = 'subscription'

@description('Approved deployment environment name.')
@minLength(1)
@maxLength(64)
param environmentName string

@description('Approved Azure region. This deployment is intentionally pinned to Sweden Central.')
@allowed([
  'swedencentral'
])
param location string

@description('Onboarding session identifier used in resource tags.')
param sessionId string

@description('Deployment attribution used in resource tags.')
param deployedBy string

@description('ISO 8601 creation timestamp used in resource tags.')
param createdAt string

@description('Exact resource group name approved by the prepare plan.')
param resourceGroupName string = 'rg-ccgc-dev-87b7'

@description('Exact virtual machine name approved by the prepare plan.')
param vmName string = 'vm-ccgc-dev-87b7'

@description('Exact managed OS disk name approved by the prepare plan.')
param osDiskName string = 'osdisk-ccgc-dev-87b7'

@description('Exact public IP resource name approved by the prepare plan.')
param publicIpName string = 'pip-ccgc-dev-87b7'

@description('Exact virtual network name approved by the prepare plan.')
param vnetName string = 'vnet-ccgc-dev-87b7'

@description('Exact network security group name approved by the prepare plan.')
param nsgName string = 'nsg-ccgc-dev-87b7'

@description('Exact network interface name approved by the prepare plan.')
param nicName string = 'nic-ccgc-dev-87b7'

@description('Subnet name for the single-host virtual network.')
param subnetName string = 'subnet-ccgc-dev-87b7'

@description('Exact public Azure DNS label approved by the prepare plan.')
param dnsLabel string = 'ccgc-dev-87b7'

@description('The only approved VM size for this scaffold.')
@allowed([
  'Standard_D2as_v5'
])
param vmSize string = 'Standard_D2as_v5'

@description('The only approved administrator account for the host.')
@allowed([
  'ccgcadmin'
])
param adminUsername string = 'ccgcadmin'

@description('Mandatory operator IPv4 address, without a CIDR suffix. Defender JIT limits SSH to /32 for at most one hour; the helper verifies public routability.')
@minLength(7)
@maxLength(15)
param operatorIpv4Address string

@description('SSH public key material for the approved administrator account. This is public material, not a secret.')
@minLength(1)
param sshPublicKey string

var tags = {
  'app-onboard-skill': 'true'
  'app-onboard-session-id': sessionId
  'created-at': createdAt
  environment: environmentName
  'deployed-by': deployedBy
}

resource rg 'Microsoft.Resources/resourceGroups@2023-07-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

module vmHost './vm.bicep' = {
  name: 'vm-host'
  scope: rg
  params: {
    adminUsername: adminUsername
    dnsLabel: dnsLabel
    location: location
    nicName: nicName
    nsgName: nsgName
    operatorIpv4Address: operatorIpv4Address
    osDiskName: osDiskName
    publicIpName: publicIpName
    sessionTags: tags
    subnetName: subnetName
    sshPublicKey: sshPublicKey
    vmName: vmName
    vmSize: vmSize
    vnetName: vnetName
  }
}

output resourceGroupName string = rg.name
output vmName string = vmHost.outputs.vmName
output vmId string = vmHost.outputs.vmId
output osDiskId string = vmHost.outputs.osDiskId
output publicIpAddress string = vmHost.outputs.publicIpAddress
output publicFqdn string = vmHost.outputs.publicFqdn
output gatewayUrl string = vmHost.outputs.gatewayUrl
output adminUsername string = vmHost.outputs.adminUsername
output sshAccessPolicyId string = vmHost.outputs.sshAccessPolicyId
