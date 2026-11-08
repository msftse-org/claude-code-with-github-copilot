terraform {
  # 1.11 is the first release with write-only arguments, which keep secrets out of state.
  required_version = ">= 1.11.0, < 2.0.0"

  required_providers {
    azapi = {
      source  = "Azure/azapi"
      version = "2.13.0"
    }
  }
}
