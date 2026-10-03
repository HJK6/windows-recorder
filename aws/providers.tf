provider "aws" {
  region = var.aws_region

  # ACCOUNT GUARD (ruling d956a689 cond. 4): the provider refuses to plan/apply
  # if the active credentials resolve to any account other than this one.
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      project   = var.project
      poc       = "true"
      managedby = "terraform"
    }
  }
}

# Belt-and-braces: fail the plan early with a clear message if the region is
# not us-east-1 for the POC, and surface the resolved identity.
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

check "account_and_region_guard" {
  assert {
    condition     = data.aws_caller_identity.current.account_id == var.aws_account_id
    error_message = "Refusing to deploy: active account ${data.aws_caller_identity.current.account_id} != allowed ${var.aws_account_id}."
  }
  assert {
    condition     = var.aws_region == "us-east-1"
    error_message = "POC is pinned to us-east-1; got ${var.aws_region}."
  }
}
