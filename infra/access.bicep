targetScope = 'resourceGroup'

@description('Approved region for the VM and its Defender just-in-time access policy.')
@allowed([
  'swedencentral'
])
param location string = 'swedencentral'

@description('Existing proof host; this template never modifies the VM or its disk.')
param vmName string = 'vm-ccgc-dev-87b7'

@description('Public operator IPv4 address without a suffix. Both policy and access requests restrict SSH to /32.')
@minLength(7)
@maxLength(15)
param operatorIpv4Address string

resource vm 'Microsoft.Compute/virtualMachines@2026-04-01' existing = {
  name: vmName
}

resource sshAccess 'Microsoft.Security/locations/jitNetworkAccessPolicies@2020-01-01' = {
  name: '${location}/ccgc-ssh'
  kind: 'Basic'
  properties: {
    virtualMachines: [
      {
        id: vm.id
        ports: [
          {
            number: 22
            protocol: 'TCP'
            allowedSourceAddressPrefix: '${operatorIpv4Address}/32'
            maxRequestAccessDuration: 'PT1H'
          }
        ]
      }
    ]
  }
}

output policyId string = sshAccess.id
