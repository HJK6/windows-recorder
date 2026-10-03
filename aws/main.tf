locals {
  prefix = var.name_prefix
  # Per-device enrollment map { deviceId: secret } — server-side only (Lambda env +
  # state), never in the repo/build/logs. State itself must be protected (README).
  device_enrollment = { for d in var.enrolled_device_ids : d => random_password.device_secret[d].result }
}

resource "random_password" "token_signing" {
  length  = 48
  special = false
}

resource "random_password" "device_secret" {
  for_each = toset(var.enrolled_device_ids)
  length   = 32
  special  = false
}

resource "random_password" "browser_login_key" {
  length  = 24
  special = false
}

# ---- KMS: customer-managed key for the private media bucket ----------------
resource "aws_kms_key" "media" {
  description             = "${local.prefix} raw media encryption"
  deletion_window_in_days = 7
  enable_key_rotation     = true
}

resource "aws_kms_alias" "media" {
  name          = "alias/${local.prefix}-media"
  target_key_id = aws_kms_key.media.key_id
}

# ---- S3: private, encrypted raw media bucket -------------------------------
resource "aws_s3_bucket" "media" {
  bucket        = "${local.prefix}-media-${var.aws_account_id}"
  force_destroy = true # POC: allow teardown to remove objects
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket                  = aws_s3_bucket.media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "media" {
  bucket = aws_s3_bucket.media.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_versioning" "media" {
  bucket = aws_s3_bucket.media.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.media.arn
    }
    bucket_key_enabled = true
  }
}

# ---- DynamoDB: single control table (on-demand) ----------------------------
resource "aws_dynamodb_table" "control" {
  name         = "${local.prefix}-control"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }

  point_in_time_recovery { enabled = true }
}
