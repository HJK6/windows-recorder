data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# Basic execution (CloudWatch Logs) reused by all three roles.
data "aws_iam_policy_document" "logs" {
  statement {
    actions = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    # Scoped to this project's function log groups only, not the whole account.
    resources = [
      "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${local.prefix}-*",
      "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${local.prefix}-*:*",
    ]
  }
}

# ---- Authorizer role: logs only (it just verifies a JWT) -------------------
resource "aws_iam_role" "authorizer" {
  name               = "${local.prefix}-authorizer"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}
resource "aws_iam_role_policy" "authorizer_logs" {
  role   = aws_iam_role.authorizer.id
  policy = data.aws_iam_policy_document.logs.json
}

# ---- Shared control-plane policy fragments ---------------------------------
# WS handler uses item CRUD only (no Scan/Query).
data "aws_iam_policy_document" "dynamo_ws" {
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.control.arn]
  }
}

# HTTP handler uses item reads/writes plus a Scan (listConnectedDevices); no Delete/Query.
data "aws_iam_policy_document" "dynamo_http" {
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Scan"]
    resources = [aws_dynamodb_table.control.arn]
  }
}

data "aws_iam_policy_document" "manage_connections" {
  statement {
    # Only delivery roles may manage the WebSocket connections (spec §13).
    actions   = ["execute-api:ManageConnections"]
    resources = ["arn:aws:execute-api:${var.aws_region}:${var.aws_account_id}:${aws_apigatewayv2_api.ws.id}/*"]
  }
}

# ---- WS handler role: logs + dynamo + manage connections -------------------
resource "aws_iam_role" "ws" {
  name               = "${local.prefix}-ws"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}
resource "aws_iam_role_policy" "ws_logs" {
  role   = aws_iam_role.ws.id
  policy = data.aws_iam_policy_document.logs.json
}
resource "aws_iam_role_policy" "ws_dynamo" {
  role   = aws_iam_role.ws.id
  policy = data.aws_iam_policy_document.dynamo_ws.json
}
resource "aws_iam_role_policy" "ws_manage" {
  role   = aws_iam_role.ws.id
  policy = data.aws_iam_policy_document.manage_connections.json
}

# ---- HTTP handler role: logs + dynamo + manage connections + S3 + KMS ------
data "aws_iam_policy_document" "http_media" {
  statement {
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.media.arn}/*"]
  }
  statement {
    actions   = ["kms:GenerateDataKey", "kms:Decrypt", "kms:DescribeKey"]
    resources = [aws_kms_key.media.arn]
  }
}

resource "aws_iam_role" "http" {
  name               = "${local.prefix}-http"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}
resource "aws_iam_role_policy" "http_logs" {
  role   = aws_iam_role.http.id
  policy = data.aws_iam_policy_document.logs.json
}
resource "aws_iam_role_policy" "http_dynamo" {
  role   = aws_iam_role.http.id
  policy = data.aws_iam_policy_document.dynamo_http.json
}
resource "aws_iam_role_policy" "http_manage" {
  role   = aws_iam_role.http.id
  policy = data.aws_iam_policy_document.manage_connections.json
}
resource "aws_iam_role_policy" "http_media" {
  role   = aws_iam_role.http.id
  policy = data.aws_iam_policy_document.http_media.json
}
