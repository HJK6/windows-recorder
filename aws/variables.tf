variable "aws_account_id" {
  description = "The ONLY account this stack may deploy to. Enforced by the provider (account guard)."
  type        = string
}

variable "aws_region" {
  description = "Deploy region (POC: us-east-1)."
  type        = string
  default     = "us-east-1"
}

variable "project" {
  description = "Project tag applied to every resource."
  type        = string
  default     = "fleet-recorder-poc"
}

variable "name_prefix" {
  description = "Prefix for resource names."
  type        = string
  default     = "fleet-recorder-poc"
}

variable "device_bootstrap_secret" {
  description = "Device enrollment material the desktop presents to mint a device token. Leave empty to auto-generate. Supplied to the desktop at runtime, never committed."
  type        = string
  default     = ""
  sensitive   = true
}

variable "device_token_ttl_seconds" {
  type    = number
  default = 900
}

variable "control_token_ttl_seconds" {
  type    = number
  default = 3600
}
