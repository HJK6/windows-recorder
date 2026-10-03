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

variable "enrolled_device_ids" {
  description = "Enrolled POC device ids. Each gets its OWN generated enrollment secret, so a device cannot mint a token for another deviceId."
  type        = list(string)
  default     = ["amaterasu-01", "poc-curl-01"]
}

variable "device_token_ttl_seconds" {
  type    = number
  default = 900
}

variable "control_token_ttl_seconds" {
  type    = number
  default = 3600
}
