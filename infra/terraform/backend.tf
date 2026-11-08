terraform {
  # Partial configuration: scripts/deploy.mjs creates the state storage account and
  # supplies storage_account_name, container_name, key, and tenant_id at init.
  backend "azurerm" {
    use_azuread_auth = true
  }
}
