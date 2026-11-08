variable "litellm_master_key" {
  type        = string
  description = "LiteLLM master key. Written only to Key Vault; never stored in Terraform state or plans."
  sensitive   = true
  ephemeral   = true

  validation {
    condition     = length(var.litellm_master_key) >= 19
    error_message = "litellm_master_key must be at least 19 characters."
  }
}

variable "litellm_salt_key" {
  type        = string
  description = "LiteLLM salt key that encrypts stored GitHub connections. It must never change for an existing database."
  sensitive   = true
  ephemeral   = true

  validation {
    condition     = length(var.litellm_salt_key) >= 16
    error_message = "litellm_salt_key must be at least 16 characters."
  }
}

variable "location" {
  type        = string
  description = "Azure region for every resource."
  default     = "swedencentral"
}

variable "name_seed" {
  type        = string
  description = "Seed for globally unique names. Change it only to rebuild while a deleted Key Vault name is still reserved by purge protection."
  default     = "litellm2"

  validation {
    condition     = length(var.name_seed) >= 1 && length(var.name_seed) <= 16
    error_message = "name_seed must be 1-16 characters."
  }
}

variable "postgres_admin_password" {
  type        = string
  description = "PostgreSQL administrator password used only by LiteLLM. Never stored in Terraform state or plans."
  sensitive   = true
  ephemeral   = true

  validation {
    condition     = length(var.postgres_admin_password) >= 16
    error_message = "postgres_admin_password must be at least 16 characters."
  }
}

variable "prefix" {
  type        = string
  description = "Short name for every resource, for example ccgc-pilot. The resource group is rg-<prefix>-enterprise."
  default     = "ccgc-pilot"

  validation {
    condition     = length(var.prefix) >= 3 && length(var.prefix) <= 16
    error_message = "prefix must be 3-16 characters."
  }
}

variable "subscription_id" {
  type        = string
  description = "Azure subscription ID that receives the deployment."

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.subscription_id))
    error_message = "subscription_id must be an Azure subscription ID."
  }
}

variable "tenant_id" {
  type        = string
  description = "Microsoft Entra tenant ID of the subscription."

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.tenant_id))
    error_message = "tenant_id must be a Microsoft Entra tenant ID."
  }
}
