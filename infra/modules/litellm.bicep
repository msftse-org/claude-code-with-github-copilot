param prefix string
param location string
param size string
param nameSeed string

@secure()
param postgresAdminPassword string

@secure()
param litellmMasterKey string

@secure()
param litellmSaltKey string

// Shared with infra/terraform so both deployments create the same solution.
var settings = loadJsonContent('../solution.json')
var sized = settings.sizes[size]
var tags = union(settings.tags, { environment: size })
var postgresAdminLogin = settings.postgres.adminLogin
var compact = replace(prefix, '-', '')
var unique = toLower(uniqueString(subscription().id, resourceGroup().id, prefix, nameSeed))
var vnetName = 'vnet-${prefix}-enterprise'
var postgresName = take('psql-${compact}-${unique}', 63)
var vaultName = take('kv-${compact}-${unique}', 24)
var litellmName = 'ca-${prefix}-litellm'
var litellmUrl = 'https://${litellmName}.${environment.properties.defaultDomain}'
var copilotTokenDir = '/var/run/ccgc/github-copilot'
var keyVaultSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'

// LiteLLM's GitHub Copilot provider resolution reads a process-wide token file even
// though every model here uses per-user OAuth. The placeholder in solution.json is
// public and never a valid GitHub token; requests use each employee's own Copilot
// connection instead.
var copilotPlaceholderToken = settings.litellm.copilotPlaceholderToken

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'id-${prefix}-litellm'
  location: location
  tags: tags
}

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${prefix}-enterprise'
  location: location
  tags: tags
  properties: {
    retentionInDays: settings.logRetentionDays
    sku: {
      name: 'PerGB2018'
    }
  }
}

resource natPublicIp 'Microsoft.Network/publicIPAddresses@2024-07-01' = if (sized.natGateway) {
  name: 'pip-${prefix}-egress'
  location: location
  tags: tags
  sku: {
    name: 'Standard'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
  }
}

resource natGateway 'Microsoft.Network/natGateways@2024-07-01' = if (sized.natGateway) {
  name: 'ng-${prefix}-enterprise'
  location: location
  tags: tags
  sku: {
    name: 'Standard'
  }
  properties: {
    idleTimeoutInMinutes: 10
    publicIpAddresses: [
      {
        id: natPublicIp.id
      }
    ]
  }
}

resource workloadNsg 'Microsoft.Network/networkSecurityGroups@2024-07-01' = {
  name: 'nsg-${prefix}-workload'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'allow-vnet-inbound'
        properties: {
          access: 'Allow'
          direction: 'Inbound'
          priority: 100
          protocol: '*'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: 'VirtualNetwork'
          destinationPortRange: '*'
        }
      }
      {
        name: 'deny-internet-inbound'
        properties: {
          access: 'Deny'
          direction: 'Inbound'
          priority: 4096
          protocol: '*'
          sourceAddressPrefix: 'Internet'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-07-01' = {
  name: vnetName
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        settings.network.addressSpace
      ]
    }
    subnets: [
      {
        name: 'snet-container-apps'
        properties: union(
          {
            addressPrefix: settings.network.containerAppsSubnet
            delegations: [
              {
                name: 'container-apps'
                properties: {
                  serviceName: 'Microsoft.App/environments'
                }
              }
            ]
            networkSecurityGroup: {
              id: workloadNsg.id
            }
            privateEndpointNetworkPolicies: 'Disabled'
          },
          // Without a NAT gateway (poc size), Container Apps uses its own outbound IP.
          sized.natGateway ? { natGateway: { id: natGateway.id } } : {}
        )
      }
      {
        name: 'snet-postgres'
        properties: {
          addressPrefix: settings.network.postgresSubnet
          delegations: [
            {
              name: 'postgres'
              properties: {
                serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers'
              }
            }
          ]
          networkSecurityGroup: {
            id: workloadNsg.id
          }
          serviceEndpoints: [
            {
              service: 'Microsoft.Storage'
            }
          ]
        }
      }
      {
        name: 'snet-private-endpoints'
        properties: {
          addressPrefix: settings.network.privateEndpointSubnet
          networkSecurityGroup: {
            id: workloadNsg.id
          }
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

resource containerSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-07-01' existing = {
  parent: vnet
  name: 'snet-container-apps'
}

resource postgresSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-07-01' existing = {
  parent: vnet
  name: 'snet-postgres'
}

resource privateEndpointSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-07-01' existing = {
  parent: vnet
  name: 'snet-private-endpoints'
}

resource postgresDns 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: '${compact}.postgres.database.azure.com'
  location: 'global'
  tags: tags
}

resource postgresDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: postgresDns
  name: 'link-${vnetName}'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: postgresName
  location: location
  tags: tags
  sku: {
    name: sized.postgres.skuName
    tier: sized.postgres.skuTier
  }
  properties: {
    version: settings.postgres.version
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    authConfig: {
      activeDirectoryAuth: 'Disabled'
      passwordAuth: 'Enabled'
    }
    backup: {
      backupRetentionDays: sized.postgres.backupRetentionDays
      geoRedundantBackup: 'Disabled'
    }
    dataEncryption: {
      type: 'SystemManaged'
    }
    highAvailability: {
      mode: sized.postgres.highAvailability
    }
    network: {
      delegatedSubnetResourceId: postgresSubnet.id
      privateDnsZoneArmResourceId: postgresDns.id
      publicNetworkAccess: 'Disabled'
    }
    storage: {
      storageSizeGB: sized.postgres.storageSizeGB
      autoGrow: 'Enabled'
      tier: sized.postgres.storageTier
    }
  }
  dependsOn: [
    postgresDnsLink
  ]
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: 'litellm'
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

resource vault 'Microsoft.KeyVault/vaults@2024-11-01' = {
  name: vaultName
  location: location
  tags: tags
  properties: {
    tenantId: tenant().tenantId
    enablePurgeProtection: true
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      bypass: 'None'
      defaultAction: 'Deny'
    }
    sku: {
      family: 'A'
      name: 'standard'
    }
  }
}

resource databaseUrlSecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = {
  parent: vault
  name: 'litellm-database-url'
  properties: {
    value: 'postgresql://${postgresAdminLogin}:${uriComponent(postgresAdminPassword)}@${postgres.properties.fullyQualifiedDomainName}:5432/${database.name}?sslmode=require'
    contentType: 'application/vnd.ccgc.litellm-database-url'
  }
}

resource masterKeySecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = {
  parent: vault
  name: 'litellm-master-key'
  properties: {
    value: litellmMasterKey
    contentType: 'application/vnd.ccgc.litellm-master-key'
  }
}

resource saltKeySecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = {
  parent: vault
  name: 'litellm-salt-key'
  properties: {
    value: litellmSaltKey
    contentType: 'application/vnd.ccgc.litellm-salt-key'
  }
}

resource vaultDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'send-to-workspace'
  scope: vault
  properties: {
    workspaceId: workspace.id
    // Listed as Azure returns them so Terraform plans of the same deployment stay clean.
    logs: [
      {
        categoryGroup: 'audit'
        enabled: true
      }
      {
        categoryGroup: 'allLogs'
        enabled: false
      }
    ]
  }
}

resource vaultDns 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: 'privatelink.vaultcore.azure.net'
  location: 'global'
  tags: tags
}

resource vaultDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: vaultDns
  name: 'link-${vnetName}'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

resource vaultEndpoint 'Microsoft.Network/privateEndpoints@2024-07-01' = {
  name: 'pe-${prefix}-kv'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnet.id
    }
    privateLinkServiceConnections: [
      {
        name: 'connection'
        properties: {
          privateLinkServiceId: vault.id
          groupIds: [
            'vault'
          ]
        }
      }
    ]
  }
  dependsOn: [
    vaultDnsLink
  ]
}

resource vaultDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-07-01' = {
  parent: vaultEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'vault'
        properties: {
          privateDnsZoneId: vaultDns.id
        }
      }
    ]
  }
}

resource litellmKeyVaultAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, identity.id, 'Key Vault Secrets User')
  scope: vault
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUser)
  }
}

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: 'cae-${prefix}-enterprise'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'azure-monitor'
    }
    vnetConfiguration: {
      infrastructureSubnetId: containerSubnet.id
      // Internal: the environment gets only a private IP in the VNet, with no public ingress.
      internal: true
    }
    workloadProfiles: sized.workloadProfiles
    zoneRedundant: sized.zoneRedundant
  }
}

module environmentDns 'environment-dns.bicep' = {
  name: '${prefix}-environment-dns'
  params: {
    defaultDomain: environment.properties.defaultDomain
    staticIp: environment.properties.staticIp
    vnetId: vnet.id
    vnetName: vnetName
    tags: tags
  }
}

resource environmentDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'send-to-workspace'
  scope: environment
  properties: {
    workspaceId: workspace.id
    // Listed as Azure returns them so Terraform plans of the same deployment stay clean.
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
      }
      {
        categoryGroup: 'audit'
        enabled: false
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

resource litellm 'Microsoft.App/containerApps@2025-01-01' = {
  name: litellmName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: sized.litellm.workloadProfileName
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        allowInsecure: false
        external: true
        targetPort: 4000
        transport: 'http'
      }
      secrets: [
        {
          name: 'litellm-database-url'
          keyVaultUrl: databaseUrlSecret.properties.secretUriWithVersion
          identity: identity.id
        }
        {
          name: 'litellm-master-key'
          keyVaultUrl: masterKeySecret.properties.secretUriWithVersion
          identity: identity.id
        }
        {
          name: 'litellm-salt-key'
          keyVaultUrl: saltKeySecret.properties.secretUriWithVersion
          identity: identity.id
        }
        {
          name: 'github-copilot-placeholder'
          // The placeholder is public and never valid; a secret is used only so it can be mounted as a file.
          #disable-next-line use-secure-value-for-secure-inputs
          value: copilotPlaceholderToken
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'litellm'
          image: settings.litellm.image
          env: [
            {
              name: 'DATABASE_URL'
              secretRef: 'litellm-database-url'
            }
            {
              name: 'LITELLM_MASTER_KEY'
              secretRef: 'litellm-master-key'
            }
            {
              name: 'LITELLM_SALT_KEY'
              secretRef: 'litellm-salt-key'
            }
            {
              name: 'STORE_MODEL_IN_DB'
              value: 'True'
            }
            {
              name: 'PROXY_BASE_URL'
              value: litellmUrl
            }
            {
              name: 'GITHUB_COPILOT_TOKEN_DIR'
              value: copilotTokenDir
            }
          ]
          volumeMounts: [
            {
              volumeName: 'github-copilot'
              mountPath: copilotTokenDir
            }
          ]
          // Listed as Azure returns them so Terraform plans of the same deployment stay clean.
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health/liveliness'
                port: 4000
                scheme: 'HTTP'
              }
              periodSeconds: 15
              timeoutSeconds: 5
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health/readiness'
                port: 4000
                scheme: 'HTTP'
              }
              periodSeconds: 10
              timeoutSeconds: 5
            }
            {
              type: 'Startup'
              httpGet: {
                path: '/health/liveliness'
                port: 4000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 30
              periodSeconds: 20
              failureThreshold: 10
              timeoutSeconds: 5
            }
          ]
          resources: {
            cpu: sized.litellm.cpu
            memory: sized.litellm.memory
          }
        }
      ]
      volumes: [
        {
          name: 'github-copilot'
          storageType: 'Secret'
          secrets: [
            {
              secretRef: 'github-copilot-placeholder'
              path: 'api-key.json'
            }
          ]
        }
      ]
      scale: {
        minReplicas: sized.litellm.minReplicas
        maxReplicas: sized.litellm.maxReplicas
        rules: [
          {
            name: 'http'
            http: {
              metadata: {
                concurrentRequests: settings.litellm.concurrentRequests
              }
            }
          }
        ]
      }
    }
  }
  dependsOn: [
    vaultDnsGroup
    litellmKeyVaultAccess
  ]
}

output litellmUrl string = 'https://${litellm.properties.configuration.ingress.fqdn}'
output keyVaultName string = vault.name
output egressIp string = sized.natGateway ? natPublicIp!.properties.ipAddress : ''
