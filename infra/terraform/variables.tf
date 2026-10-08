variable "created_at" {
  type        = string
  description = "Stable creation timestamp supplied by the coordinator, not recomputed on each plan."
}

variable "deployment_name" {
  type        = string
  description = "Unique lowercase deployment name; resources must not already belong to another engine."

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}[a-z0-9]$", var.deployment_name))
    error_message = "Use 3-32 lowercase letters, digits or hyphens, beginning with a letter."
  }
}

variable "location" {
  type        = string
  description = "Reviewed deployment region."
  default     = "swedencentral"

  validation {
    condition     = var.location == "swedencentral"
    error_message = "Only Sweden Central is reviewed for this deployment profile."
  }
}

variable "operator_ipv4_address" {
  type        = string
  description = "Public operator IPv4 address without a suffix; the JIT policy adds /32."

  validation {
    condition     = can(cidrnetmask("${var.operator_ipv4_address}/32"))
    error_message = "Supply one IPv4 address. The coordinator additionally validates public routability."
  }
}

variable "ssh_public_key" {
  type        = string
  description = "Public SSH key, never a private key or provider credential."

  validation {
    condition     = can(regex("^ssh-(ed25519|rsa) [A-Za-z0-9+/=]+( [^\r\n]*)?$", var.ssh_public_key))
    error_message = "Supply one RSA or Ed25519 public key."
  }
}

variable "subscription_id" {
  type        = string
  description = "Explicit Azure subscription ID."
}

variable "tenant_id" {
  type        = string
  description = "Explicit Azure tenant ID, checked against the Azure CLI login."
}
