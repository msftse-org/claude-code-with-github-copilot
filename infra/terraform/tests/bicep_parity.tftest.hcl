# Expected values come from Bicep's own uniqueString() and guid() functions,
# evaluated with `bicep console`, for a synthetic subscription, prefix
# ccgc-pilot, and nameSeed litellm. Terraform must produce the same names so
# that either engine can manage a deployment created by the other.

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
  subscription_id         = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE"
  tenant_id               = "00000000-0000-4000-8000-000000000002"
  postgres_admin_password = "test-postgres-password-not-real"
  litellm_master_key      = "sk-test-master-key-not-real"
  litellm_salt_key        = "test-salt-key-not-real"
}

run "globally_unique_names_match_bicep" {
  command = plan

  assert {
    condition     = azapi_resource.vault.name == "kv-ccgcpilot-bbsmbj3lmzp"
    error_message = "Key Vault name differs from Bicep uniqueString naming."
  }

  assert {
    condition     = azapi_resource.postgres.name == "psql-ccgcpilot-bbsmbj3lmzp4o"
    error_message = "PostgreSQL server name differs from Bicep uniqueString naming."
  }
}

run "role_assignment_name_matches_bicep_guid" {
  command = plan

  override_resource {
    target          = azapi_resource.vault
    override_during = plan
    values = {
      id = "/subscriptions/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/resourceGroups/rg-ccgc-pilot-enterprise/providers/Microsoft.KeyVault/vaults/kv-ccgcpilot-bbsmbj3lmzp"
    }
  }

  override_resource {
    target          = azapi_resource.identity
    override_during = plan
    values = {
      id = "/subscriptions/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/resourceGroups/rg-ccgc-pilot-enterprise/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-ccgc-pilot-litellm"
      output = {
        properties = {
          principalId = "00000000-0000-0000-0000-000000000001"
        }
      }
    }
  }

  assert {
    condition     = azapi_resource.litellm_key_vault_access.name == "91b87ee0-4ad6-5333-872e-16ae045645ca"
    error_message = "Role assignment name differs from Bicep guid(vault.id, identity.id, 'Key Vault Secrets User')."
  }
}
