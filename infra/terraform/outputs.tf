output "egress_ip" {
  description = "Static outbound IP for GitHub organization IP allow lists; empty for the poc size, which has no NAT gateway."
  value       = join("", azapi_resource.nat_public_ip[*].output.properties.ipAddress)
}

output "key_vault_name" {
  description = "Key Vault that holds the LiteLLM master key, salt key, and database URL."
  value       = azapi_resource.vault.name
}

output "litellm_url" {
  description = "LiteLLM origin for Claude clients, the admin UI, and the enrollment workflow."
  value       = "https://${azapi_resource.litellm.output.properties.configuration.ingress.fqdn}"
}

output "resource_group_name" {
  description = "Resource group that holds the platform."
  value       = azapi_resource.group.name
}
