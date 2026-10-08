mock_provider "azapi" {}

variables {
  subscription_id       = "00000000-0000-0000-0000-000000000001"
  tenant_id             = "00000000-0000-0000-0000-000000000002"
  deployment_name       = "ccgc-synthetic"
  created_at            = "2026-10-07T00:00:00Z"
  operator_ipv4_address = "8.8.8.8"
  ssh_public_key        = "ssh-ed25519 AAAA synthetic"
}

run "reviewed_profile" {
  command = plan

  assert {
    condition     = azapi_resource.host.body.properties.hardwareProfile.vmSize == "Standard_D2as_v5"
    error_message = "The automation must retain the approved general-purpose D-series profile."
  }

  assert {
    condition     = azapi_resource.host.body.properties.securityProfile.encryptionAtHost && azapi_resource.host.body.properties.securityProfile.uefiSettings.secureBootEnabled && azapi_resource.host.body.properties.securityProfile.uefiSettings.vTpmEnabled
    error_message = "Host encryption, Secure Boot and vTPM must remain enabled."
  }

  assert {
    condition     = azapi_resource.host.body.properties.storageProfile.osDisk.deleteOption == "Detach" && azapi_resource.host.body.properties.storageProfile.osDisk.diskSizeGB == 64
    error_message = "Keep the retained 64-GiB state-bearing OS disk."
  }

  assert {
    condition     = azapi_resource.host.body.properties.osProfile.linuxConfiguration.disablePasswordAuthentication
    error_message = "Password SSH must remain disabled."
  }

  assert {
    condition     = alltrue([for rule in azapi_resource.network_security.body.properties.securityRules : rule.properties.access != "Allow" || contains(["80", "443"], rule.properties.destinationPortRange)])
    error_message = "No permanent SSH, Node, LiteLLM or Docker ingress is allowed."
  }

  assert {
    condition     = azapi_resource.ssh_access.body.properties.virtualMachines[0].ports[0].maxRequestAccessDuration == "PT1H" && azapi_resource.ssh_access.body.properties.virtualMachines[0].ports[0].allowedSourceAddressPrefix == "8.8.8.8/32"
    error_message = "JIT must constrain one source /32 and at most one hour."
  }
}

run "reject_unreviewed_region" {
  command = plan
  variables {
    location = "eastus"
  }
  expect_failures = [var.location]
}

run "reject_bad_name" {
  command = plan
  variables {
    deployment_name = "../existing"
  }
  expect_failures = [var.deployment_name]
}
