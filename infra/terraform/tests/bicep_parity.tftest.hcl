# Expected values are the names Azure assigned when infra/main.bicep deployed
# prefix ccgc-pilot with nameSeed litellm. Terraform must produce the same names
# so that either engine can manage a deployment created by the other.

mock_provider "azapi" {
  mock_resource "azapi_resource" {
    defaults = {
      output = {
        properties = {
          configuration = {
            ingress = {
              fqdn = "ca-ccgc-pilot-litellm.example.swedencentral.azurecontainerapps.io"
            }
          }
          defaultDomain            = "example.swedencentral.azurecontainerapps.io"
          fullyQualifiedDomainName = "psql.example.postgres.database.azure.com"
          ipAddress                = "203.0.113.10"
          principalId              = "00000000-0000-0000-0000-000000000001"
          secretUriWithVersion     = "https://kv.example.vault.azure.net/secrets/example/0"
        }
      }
    }
  }
}

variables {
  name_seed               = "litellm"
  subscription_id         = "B8242ABA-C397-4474-82E4-C96CBFD7FA7B"
  tenant_id               = "2e1ff9b6-0978-4e17-84c5-b55ad1f6041d"
  postgres_admin_password = "test-postgres-password-not-real"
  litellm_master_key      = "sk-test-master-key-not-real"
  litellm_salt_key        = "test-salt-key-not-real"
}

run "globally_unique_names_match_bicep" {
  command = plan

  assert {
    condition     = azapi_resource.vault.name == "kv-ccgcpilot-ad5ibgxs5wd"
    error_message = "Key Vault name differs from Bicep uniqueString naming."
  }

  assert {
    condition     = azapi_resource.postgres.name == "psql-ccgcpilot-ad5ibgxs5wd56"
    error_message = "PostgreSQL server name differs from Bicep uniqueString naming."
  }
}

run "role_assignment_name_matches_bicep_guid" {
  command = plan

  override_resource {
    target          = azapi_resource.vault
    override_during = plan
    values = {
      id = "/subscriptions/b8242aba-c397-4474-82e4-c96cbfd7fa7b/resourceGroups/rg-ccgc-pilot-enterprise/providers/Microsoft.KeyVault/vaults/kv-ccgcpilot-ad5ibgxs5wd"
    }
  }

  override_resource {
    target          = azapi_resource.identity
    override_during = plan
    values = {
      id = "/subscriptions/b8242aba-c397-4474-82e4-c96cbfd7fa7b/resourceGroups/rg-ccgc-pilot-enterprise/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-ccgc-pilot-litellm"
      output = {
        properties = {
          principalId = "00000000-0000-0000-0000-000000000001"
        }
      }
    }
  }

  assert {
    condition     = azapi_resource.litellm_key_vault_access.name == "20dc5654-1a03-579a-89f6-e811d178b4b7"
    error_message = "Role assignment name differs from Bicep guid(vault.id, identity.id, 'Key Vault Secrets User')."
  }
}
