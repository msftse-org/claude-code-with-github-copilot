param prefix string
param location string
param tenantId string
param entraAudience string
param postgresAdminObjectId string
param postgresAdminName string
param brokerImage string
param workerImage string
param litellmImage string
param litellmPostgresAdminLogin string
@secure()
param litellmPostgresAdminPassword string
@secure()
param litellmMasterKey string
@secure()
param litellmSaltKey string
@secure()
param dispatchSigningSecret string
@secure()
param checkpointEncryptionKey string
param cryptographicSecretExpiration int
param modelsJson string

var compact = replace(prefix, '-', '')
var unique = toLower(uniqueString(subscription().id, resourceGroup().id, prefix))
var vnetName = 'vnet-${prefix}-enterprise'
var brokerIdentityName = 'id-${prefix}-broker'
var workerIdentityName = 'id-${prefix}-worker'
var litellmIdentityName = 'id-${prefix}-litellm'
var postgresName = take('psql-${compact}-${unique}', 63)
var litellmPostgresName = take('psql-${compact}-litellm-${unique}', 63)
var vaultName = take('kv-${compact}-${unique}', 24)
var registryName = take('cr${compact}${unique}', 50)
var storageName = take('st${compact}${unique}', 24)
var environmentName = 'cae-${prefix}-enterprise'
var brokerName = 'ca-${prefix}-broker'
var workerName = 'ca-${prefix}-worker'
var litellmName = 'ca-${prefix}-litellm'
var workspaceName = 'log-${prefix}-enterprise'
var insightsName = 'appi-${prefix}-enterprise'
var postgresDnsZoneName = '${compact}.postgres.database.azure.com'
var tags = {
  project: 'claude-code-with-github-copilot'
  environment: 'enterprise'
  managedBy: 'bicep'
}

resource brokerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: brokerIdentityName
  location: location
  tags: tags
}

resource workerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: workerIdentityName
  location: location
  tags: tags
}

resource litellmIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: litellmIdentityName
  location: location
  tags: tags
}

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  tags: tags
  properties: {
    retentionInDays: 30
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
    sku: {
      name: 'PerGB2018'
    }
  }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: insightsName
  location: location
  kind: 'web'
  tags: tags
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    DisableIpMasking: false
    IngestionMode: 'LogAnalytics'
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource natPublicIp 'Microsoft.Network/publicIPAddresses@2024-07-01' = {
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

resource natGateway 'Microsoft.Network/natGateways@2024-07-01' = {
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
        '10.80.0.0/16'
      ]
    }
    subnets: [
      {
        name: 'snet-container-apps'
        properties: {
          addressPrefix: '10.80.0.0/23'
          delegations: [
            {
              name: 'container-apps'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
          natGateway: {
            id: natGateway.id
          }
          networkSecurityGroup: {
            id: workloadNsg.id
          }
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
      {
        name: 'snet-postgres'
        properties: {
          addressPrefix: '10.80.2.0/27'
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
        }
      }
      {
        name: 'snet-private-endpoints'
        properties: {
          addressPrefix: '10.80.2.32/27'
          networkSecurityGroup: {
            id: workloadNsg.id
          }
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
      {
        name: 'snet-litellm-postgres'
        properties: {
          addressPrefix: '10.80.2.64/27'
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

resource litellmPostgresSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-07-01' existing = {
  parent: vnet
  name: 'snet-litellm-postgres'
}

resource postgresDns 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: postgresDnsZoneName
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
    name: 'Standard_D2ds_v5'
    tier: 'GeneralPurpose'
  }
  properties: {
    version: '16'
    administratorLogin: postgresAdminName
    authConfig: {
      activeDirectoryAuth: 'Enabled'
      passwordAuth: 'Disabled'
      tenantId: tenantId
    }
    backup: {
      backupRetentionDays: 14
      geoRedundantBackup: 'Disabled'
    }
    dataEncryption: {
      type: 'SystemManaged'
    }
    highAvailability: {
      mode: 'ZoneRedundant'
    }
    network: {
      delegatedSubnetResourceId: postgresSubnet.id
      privateDnsZoneArmResourceId: postgresDns.id
      publicNetworkAccess: 'Disabled'
    }
    storage: {
      storageSizeGB: 128
      autoGrow: 'Enabled'
      tier: 'P10'
    }
  }
  dependsOn: [
    postgresDnsLink
  ]
}

resource postgresAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = {
  parent: postgres
  name: postgresAdminObjectId
  properties: {
    principalName: postgresAdminName
    principalType: 'ServicePrincipal'
    tenantId: tenantId
  }
}

resource litellmPostgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: litellmPostgresName
  location: location
  tags: tags
  sku: {
    name: 'Standard_D2ds_v5'
    tier: 'GeneralPurpose'
  }
  properties: {
    version: '16'
    administratorLogin: litellmPostgresAdminLogin
    administratorLoginPassword: litellmPostgresAdminPassword
    authConfig: {
      activeDirectoryAuth: 'Disabled'
      passwordAuth: 'Enabled'
      tenantId: tenantId
    }
    backup: {
      backupRetentionDays: 14
      geoRedundantBackup: 'Disabled'
    }
    dataEncryption: {
      type: 'SystemManaged'
    }
    highAvailability: {
      mode: 'ZoneRedundant'
    }
    network: {
      delegatedSubnetResourceId: litellmPostgresSubnet.id
      privateDnsZoneArmResourceId: postgresDns.id
      publicNetworkAccess: 'Disabled'
    }
    storage: {
      storageSizeGB: 128
      autoGrow: 'Enabled'
      tier: 'P10'
    }
  }
  dependsOn: [
    postgresDnsLink
  ]
}

resource vault 'Microsoft.KeyVault/vaults@2024-11-01' = {
  name: vaultName
  location: location
  tags: tags
  properties: {
    tenantId: tenantId
    enablePurgeProtection: true
    enableRbacAuthorization: true
    enableSoftDelete: true
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

resource dispatchSecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = {
  parent: vault
  name: 'broker-worker-dispatch-signing'
  properties: {
    value: dispatchSigningSecret
    contentType: 'application/vnd.ccgc.dispatch-signing-key'
    attributes: {
      enabled: true
      exp: cryptographicSecretExpiration
    }
  }
}

resource checkpointKeySecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = {
  parent: vault
  name: 'worker-checkpoint-encryption'
  properties: {
    value: checkpointEncryptionKey
    contentType: 'application/vnd.ccgc.checkpoint-key'
    attributes: {
      enabled: true
      exp: cryptographicSecretExpiration
    }
  }
}

resource litellmDatabaseSecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = {
  parent: vault
  name: 'litellm-database-url'
  properties: {
    value: 'postgresql://${litellmPostgresAdminLogin}:${uriComponent(litellmPostgresAdminPassword)}@${litellmPostgres.properties.fullyQualifiedDomainName}:5432/postgres?sslmode=require'
    contentType: 'application/vnd.ccgc.litellm-database-url'
    attributes: {
      enabled: true
      exp: cryptographicSecretExpiration
    }
  }
}

resource litellmMasterKeySecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = {
  parent: vault
  name: 'litellm-master-key'
  properties: {
    value: litellmMasterKey
    contentType: 'application/vnd.ccgc.litellm-master-key'
    attributes: {
      enabled: true
      exp: cryptographicSecretExpiration
    }
  }
}

resource litellmSaltKeySecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = {
  parent: vault
  name: 'litellm-salt-key'
  properties: {
    value: litellmSaltKey
    contentType: 'application/vnd.ccgc.litellm-salt-key'
    attributes: {
      enabled: true
      exp: cryptographicSecretExpiration
    }
  }
}

resource registry 'Microsoft.ContainerRegistry/registries@2025-04-01' = {
  name: registryName
  location: location
  tags: tags
  sku: {
    name: 'Premium'
  }
  properties: {
    adminUserEnabled: false
    anonymousPullEnabled: false
    dataEndpointEnabled: false
    publicNetworkAccess: 'Disabled'
    zoneRedundancy: 'Enabled'
    policies: {
      quarantinePolicy: {
        status: 'enabled'
      }
      retentionPolicy: {
        days: 14
        status: 'enabled'
      }
      trustPolicy: {
        status: 'disabled'
        type: 'Notary'
      }
    }
  }
}

//checkov:skip=CKV_AZURE_43:Name is generated from lowercase alphanumeric inputs and capped at 24 characters.
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  tags: tags
  sku: {
    name: 'Standard_GZRS'
  }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    allowCrossTenantReplication: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Deny'
      ipRules: []
      virtualNetworkRules: []
    }
    publicNetworkAccess: 'Disabled'
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: true
      days: 14
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 14
    }
  }
}

resource checkpointContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'checkpoints'
  properties: {
    publicAccess: 'None'
    immutableStorageWithVersioning: {
      enabled: false
    }
  }
}

var privateServices = [
  {
    name: 'kv'
    resourceId: vault.id
    groupId: 'vault'
    zoneName: 'privatelink.vaultcore.azure.net'
    zoneId: 'vault'
  }
  {
    name: 'acr'
    resourceId: registry.id
    groupId: 'registry'
    zoneName: 'privatelink.azurecr.io'
    zoneId: 'registry'
  }
  {
    name: 'blob'
    resourceId: storage.id
    groupId: 'blob'
    zoneName: 'privatelink.blob.${az.environment().suffixes.storage}'
    zoneId: 'blob'
  }
]

resource privateDnsZones 'Microsoft.Network/privateDnsZones@2024-06-01' = [for service in privateServices: {
  name: service.zoneName
  location: 'global'
  tags: tags
}]

resource privateDnsLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [for (service, index) in privateServices: {
  parent: privateDnsZones[index]
  name: 'link-${vnetName}'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}]

resource privateEndpoints 'Microsoft.Network/privateEndpoints@2024-07-01' = [for (service, index) in privateServices: {
  name: 'pe-${prefix}-${service.name}'
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
          privateLinkServiceId: service.resourceId
          groupIds: [
            service.groupId
          ]
        }
      }
    ]
  }
  dependsOn: [
    privateDnsLinks[index]
  ]
}]

resource privateDnsGroups 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-07-01' = [for (service, index) in privateServices: {
  parent: privateEndpoints[index]
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: service.zoneId
        properties: {
          privateDnsZoneId: privateDnsZones[index].id
        }
      }
    ]
  }
}]

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: environmentName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'azure-monitor'
    }
    vnetConfiguration: {
      infrastructureSubnetId: containerSubnet.id
      internal: true
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
      {
        name: 'D4'
        workloadProfileType: 'D4'
        minimumCount: 2
        maximumCount: 6
      }
    ]
    zoneRedundant: true
  }
}

resource environmentDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'send-to-workspace'
  scope: environment
  properties: {
    workspaceId: workspace.id
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
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

module containerDns 'container-dns.bicep' = {
  name: 'container-apps-private-dns'
  params: {
    defaultDomain: environment.properties.defaultDomain
    staticIp: environment.properties.staticIp
    vnetId: vnet.id
    vnetName: vnet.name
    tags: tags
  }
}

resource broker 'Microsoft.App/containerApps@2025-01-01' = {
  name: brokerName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${brokerIdentity.id}': {}
    }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'D4'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        allowInsecure: false
        external: true
        targetPort: 8080
        transport: 'http2'
      }
      registries: [
        {
          identity: brokerIdentity.id
          server: registry.properties.loginServer
        }
      ]
      secrets: []
    }
    template: {
      containers: [
        {
          name: 'broker'
          image: brokerImage
          env: [
            {
              name: 'CCGC_ENTRA_TENANT_ID'
              value: tenantId
            }
            {
              name: 'CCGC_ENTRA_AUDIENCE'
              value: entraAudience
            }
            {
              name: 'CCGC_ENTRA_SCOPE'
              value: 'CCGC.Access'
            }
            {
              name: 'CCGC_KEY_VAULT_URL'
              value: vault.properties.vaultUri
            }
            {
              name: 'CCGC_WORKER_DNS_SUFFIX'
              value: '.${environment.properties.defaultDomain}'
            }
            {
              name: 'CCGC_WORKER_URL'
              value: 'https://${workerName}.${environment.properties.defaultDomain}'
            }
            {
              name: 'CCGC_BROKER_ORIGIN'
              value: 'https://${brokerName}.${environment.properties.defaultDomain}'
            }
            {
              name: 'CCGC_DISPATCH_SECRET_NAME'
              value: dispatchSecret.name
            }
            {
              name: 'CCGC_POSTGRES_URL'
              value: 'postgresql://${brokerIdentity.name}@${postgres.properties.fullyQualifiedDomainName}:5432/postgres?sslmode=require'
            }
            {
              name: 'CCGC_POSTGRES_ENTRA'
              value: 'true'
            }
            {
              name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
              value: insights.properties.ConnectionString
            }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/healthz'
                port: 8080
                scheme: 'HTTP'
              }
              initialDelaySeconds: 10
              periodSeconds: 10
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/healthz'
                port: 8080
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
              periodSeconds: 5
            }
          ]
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
        }
      ]
      scale: {
        minReplicas: 2
        maxReplicas: 10
        rules: [
          {
            name: 'http'
            http: {
              metadata: {
                concurrentRequests: '20'
              }
            }
          }
        ]
      }
    }
  }
  dependsOn: [
    containerDns
    privateDnsGroups
    postgresAdmin
    keyVaultAccess
    registryPull
  ]
}

resource worker 'Microsoft.App/containerApps@2025-01-01' = {
  name: workerName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${workerIdentity.id}': {}
    }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'D4'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        allowInsecure: false
        external: true
        targetPort: 8080
        transport: 'http2'
      }
      registries: [
        {
          identity: workerIdentity.id
          server: registry.properties.loginServer
        }
      ]
      secrets: []
    }
    template: {
      containers: [
        {
          name: 'worker'
          image: workerImage
          env: [
            {
              name: 'CCGC_KEY_VAULT_URL'
              value: vault.properties.vaultUri
            }
            {
              name: 'CCGC_DISPATCH_SECRET_NAME'
              value: dispatchSecret.name
            }
            {
              name: 'CCGC_CHECKPOINT_KEY_SECRET_NAME'
              value: checkpointKeySecret.name
            }
            {
              name: 'CCGC_CHECKPOINT_STORAGE_URL'
              value: 'https://${storage.name}.blob.${az.environment().suffixes.storage}/'
            }
            {
              name: 'CCGC_CHECKPOINT_CONTAINER'
              value: checkpointContainer.name
            }
            {
              name: 'CCGC_BROKER_ORIGIN'
              value: 'https://${brokerName}.${environment.properties.defaultDomain}'
            }
            {
              name: 'CCGC_WORKER_ORIGIN'
              value: 'https://${workerName}.${environment.properties.defaultDomain}'
            }
            {
              name: 'CCGC_EXPECTED_HOST'
              value: '${workerName}.${environment.properties.defaultDomain}'
            }
            {
              name: 'CCGC_MODELS_JSON'
              value: modelsJson
            }
            {
              name: 'CCGC_LITELLM_URL'
              value: 'https://${litellmName}.${environment.properties.defaultDomain}'
            }
            {
              name: 'CCGC_MAX_CONNECTORS'
              value: '500'
            }
            {
              name: 'CCGC_MAX_ACTIVE_BRANCHES'
              value: '500'
            }
            {
              name: 'CCGC_MAX_ACTIVE_BRANCHES_PER_USER'
              value: '4'
            }
            {
              name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
              value: insights.properties.ConnectionString
            }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/healthz'
                port: 8080
                scheme: 'HTTP'
              }
              initialDelaySeconds: 10
              periodSeconds: 10
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/healthz'
                port: 8080
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
              periodSeconds: 5
            }
          ]
          resources: {
            cpu: json('2.0')
            memory: '4Gi'
          }
        }
      ]
      scale: {
        minReplicas: 2
        maxReplicas: 30
        rules: [
          {
            name: 'http'
            http: {
              metadata: {
                concurrentRequests: '8'
              }
            }
          }
        ]
      }
    }
  }
  dependsOn: [
    containerDns
    privateDnsGroups
    workerKeyVaultAccess
    workerRegistryPull
    workerStorageAccess
    litellm
  ]
}

resource litellm 'Microsoft.App/containerApps@2025-01-01' = {
  name: litellmName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${litellmIdentity.id}': {}
    }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'D4'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        allowInsecure: false
        external: true
        targetPort: 4000
        transport: 'http'
      }
      registries: [
        {
          identity: litellmIdentity.id
          server: registry.properties.loginServer
        }
      ]
      secrets: [
        {
          name: 'litellm-database-url'
          keyVaultUrl: litellmDatabaseSecret.properties.secretUriWithVersion
          identity: litellmIdentity.id
        }
        {
          name: 'litellm-master-key'
          keyVaultUrl: litellmMasterKeySecret.properties.secretUriWithVersion
          identity: litellmIdentity.id
        }
        {
          name: 'litellm-salt-key'
          keyVaultUrl: litellmSaltKeySecret.properties.secretUriWithVersion
          identity: litellmIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'litellm'
          image: litellmImage
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
              name: 'PROXY_BASE_URL'
              value: 'https://${litellmName}.${environment.properties.defaultDomain}'
            }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health/liveliness'
                port: 4000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 30
              periodSeconds: 15
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health/readiness'
                port: 4000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 20
              periodSeconds: 10
            }
          ]
          resources: {
            cpu: json('2.0')
            memory: '4Gi'
          }
        }
      ]
      scale: {
        minReplicas: 2
        maxReplicas: 10
        rules: [
          {
            name: 'http'
            http: {
              metadata: {
                concurrentRequests: '32'
              }
            }
          }
        ]
      }
    }
  }
  dependsOn: [
    containerDns
    privateDnsGroups
    litellmKeyVaultAccess
    litellmRegistryPull
  ]
}

resource keyVaultAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, brokerIdentity.id, 'Key Vault Secrets User')
  scope: vault
  properties: {
    principalId: brokerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
  }
}

resource workerKeyVaultAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, workerIdentity.id, 'Key Vault Secrets User')
  scope: vault
  properties: {
    principalId: workerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
  }
}

resource litellmKeyVaultAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, litellmIdentity.id, 'Key Vault Secrets User')
  scope: vault
  properties: {
    principalId: litellmIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
  }
}

resource registryPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, brokerIdentity.id, 'AcrPull')
  scope: registry
  properties: {
    principalId: brokerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}

resource workerRegistryPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, workerIdentity.id, 'AcrPull')
  scope: registry
  properties: {
    principalId: workerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}

resource litellmRegistryPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, litellmIdentity.id, 'AcrPull')
  scope: registry
  properties: {
    principalId: litellmIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}

resource workerStorageAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, workerIdentity.id, 'Storage Blob Data Contributor')
  scope: storage
  properties: {
    principalId: workerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  }
}

output brokerInternalFqdn string = broker.properties.configuration.ingress.fqdn
output workerInternalFqdn string = worker.properties.configuration.ingress.fqdn
output litellmInternalFqdn string = litellm.properties.configuration.ingress.fqdn
output keyVaultName string = vault.name
output postgresHost string = postgres.properties.fullyQualifiedDomainName
output litellmPostgresHost string = litellmPostgres.properties.fullyQualifiedDomainName
output registryName string = registry.name
output checkpointStorageName string = storage.name
