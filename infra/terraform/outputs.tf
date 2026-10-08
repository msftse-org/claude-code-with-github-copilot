output "deployment" {
  description = "Shared deployment contract consumed by the Bicep/Terraform coordinator."
  value = {
    adminUsername     = "ccgcadmin"
    gatewayUrl        = "https://${azapi_resource.public_ip.output.properties.dnsSettings.fqdn}"
    publicFqdn        = azapi_resource.public_ip.output.properties.dnsSettings.fqdn
    publicIpAddress   = azapi_resource.public_ip.output.properties.ipAddress
    resourceGroupName = azapi_resource.group.name
    sshAccessPolicyId = azapi_resource.ssh_access.id
    vmId              = azapi_resource.host.id
    vmName            = azapi_resource.host.name
  }
}
