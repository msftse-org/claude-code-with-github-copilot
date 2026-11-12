resource "azapi_resource" "environment" {
  type      = "Microsoft.App/managedEnvironments@2025-01-01"
  parent_id = azapi_resource.group.id
  name      = "cae-${var.prefix}-enterprise"
  location  = var.location
  tags      = local.tags

  body = {
    properties = {
      appLogsConfiguration = {
        destination = "azure-monitor"
      }
      vnetConfiguration = {
        infrastructureSubnetId = local.container_apps_subnet_id
        internal               = false
      }
      workloadProfiles = local.size.workloadProfiles
      zoneRedundant    = local.size.zoneRedundant
    }
  }

  response_export_values = ["properties.defaultDomain"]

  timeouts {
    create = "60m"
    update = "60m"
    delete = "60m"
  }
}

resource "azapi_resource" "environment_diagnostics" {
  type      = "Microsoft.Insights/diagnosticSettings@2021-05-01-preview"
  parent_id = azapi_resource.environment.id
  name      = "send-to-workspace"

  body = {
    properties = {
      workspaceId = azapi_resource.workspace.id
      # Azure returns every category group in this order; listing the disabled one keeps plans clean.
      logs = [
        {
          categoryGroup = "allLogs"
          enabled       = true
        },
        {
          categoryGroup = "audit"
          enabled       = false
        },
      ]
      metrics = [
        {
          category = "AllMetrics"
          enabled  = true
        },
      ]
    }
  }
}

locals {
  litellm_url = "https://${local.litellm_name}.${azapi_resource.environment.output.properties.defaultDomain}"
}

resource "azapi_resource" "litellm" {
  type      = "Microsoft.App/containerApps@2025-01-01"
  parent_id = azapi_resource.group.id
  name      = local.litellm_name
  location  = var.location
  tags      = local.tags

  # Azure returns ingress transport as "Http" although the API value is "http".
  ignore_casing = true

  identity {
    type         = "UserAssigned"
    identity_ids = [azapi_resource.identity.id]
  }

  body = {
    properties = {
      environmentId       = azapi_resource.environment.id
      workloadProfileName = local.size.litellm.workloadProfileName
      configuration = {
        activeRevisionsMode = "Single"
        ingress = {
          allowInsecure = false
          external      = true
          targetPort    = 4000
          transport     = "http"
        }
        secrets = [
          {
            name        = "litellm-database-url"
            keyVaultUrl = azapi_resource.database_url_secret.output.properties.secretUriWithVersion
            identity    = azapi_resource.identity.id
          },
          {
            name        = "litellm-master-key"
            keyVaultUrl = azapi_resource.master_key_secret.output.properties.secretUriWithVersion
            identity    = azapi_resource.identity.id
          },
          {
            name        = "litellm-salt-key"
            keyVaultUrl = azapi_resource.salt_key_secret.output.properties.secretUriWithVersion
            identity    = azapi_resource.identity.id
          },
          {
            # LiteLLM's GitHub Copilot provider reads a process-wide token file even
            # though every model here uses per-user OAuth. The placeholder is public
            # and never a valid GitHub token; it is a secret only so that it can be
            # mounted as a file. Requests use each employee's own Copilot connection.
            name  = "github-copilot-placeholder"
            value = local.settings.litellm.copilotPlaceholderToken
          },
        ]
      }
      template = {
        containers = [
          {
            name  = "litellm"
            image = local.settings.litellm.image
            env = [
              {
                name      = "DATABASE_URL"
                secretRef = "litellm-database-url"
              },
              {
                name      = "LITELLM_MASTER_KEY"
                secretRef = "litellm-master-key"
              },
              {
                name      = "LITELLM_SALT_KEY"
                secretRef = "litellm-salt-key"
              },
              {
                name  = "STORE_MODEL_IN_DB"
                value = "True"
              },
              {
                name  = "PROXY_BASE_URL"
                value = local.litellm_url
              },
              {
                name  = "GITHUB_COPILOT_TOKEN_DIR"
                value = local.copilot_token_dir
              },
            ]
            volumeMounts = [
              {
                volumeName = "github-copilot"
                mountPath  = local.copilot_token_dir
              },
            ]
            # Azure returns probes in this order; any other order shows as drift in every plan.
            probes = [
              {
                type = "Liveness"
                httpGet = {
                  path   = "/health/liveliness"
                  port   = 4000
                  scheme = "HTTP"
                }
                periodSeconds  = 15
                timeoutSeconds = 5
              },
              {
                type = "Readiness"
                httpGet = {
                  path   = "/health/readiness"
                  port   = 4000
                  scheme = "HTTP"
                }
                periodSeconds  = 10
                timeoutSeconds = 5
              },
              {
                type = "Startup"
                httpGet = {
                  path   = "/health/liveliness"
                  port   = 4000
                  scheme = "HTTP"
                }
                initialDelaySeconds = 30
                periodSeconds       = 20
                failureThreshold    = 10
                timeoutSeconds      = 5
              },
            ]
            resources = {
              cpu    = local.size.litellm.cpu
              memory = local.size.litellm.memory
            }
          },
        ]
        volumes = [
          {
            name        = "github-copilot"
            storageType = "Secret"
            secrets = [
              {
                secretRef = "github-copilot-placeholder"
                path      = "api-key.json"
              },
            ]
          },
        ]
        scale = {
          minReplicas = local.size.litellm.minReplicas
          maxReplicas = local.size.litellm.maxReplicas
          rules = [
            {
              name = "http"
              http = {
                metadata = {
                  concurrentRequests = local.settings.litellm.concurrentRequests
                }
              }
            },
          ]
        }
      }
    }
  }

  response_export_values = ["properties.configuration.ingress.fqdn"]

  depends_on = [
    azapi_resource.vault_dns_group,
    azapi_resource.litellm_key_vault_access,
  ]
}
