data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = "${path.module}/lambda"
  output_path = "${path.module}/build/lambda.zip"
}

resource "aws_lambda_function" "authorizer" {
  function_name    = "${local.prefix}-authorizer"
  role             = aws_iam_role.authorizer.arn
  handler          = "authorizer/index.handler"
  runtime          = "nodejs20.x"
  timeout          = 10
  memory_size      = 256
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  environment {
    variables = { TOKEN_SIGNING_SECRET = random_password.token_signing.result }
  }
}

resource "aws_lambda_function" "ws" {
  function_name    = "${local.prefix}-ws"
  role             = aws_iam_role.ws.arn
  handler          = "ws/index.handler"
  runtime          = "nodejs20.x"
  timeout          = 10
  memory_size      = 256
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.control.name
    }
  }
}

resource "aws_lambda_function" "http" {
  function_name    = "${local.prefix}-http"
  role             = aws_iam_role.http.arn
  handler          = "http/index.handler"
  runtime          = "nodejs20.x"
  timeout          = 15
  memory_size      = 512
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  environment {
    variables = {
      TABLE_NAME           = aws_dynamodb_table.control.name
      TOKEN_SIGNING_SECRET = random_password.token_signing.result
      DEVICE_ENROLLMENT    = jsonencode(local.device_enrollment)
      BROWSER_LOGIN_KEY    = random_password.browser_login_key.result
      BUCKET_NAME          = aws_s3_bucket.media.id
      KMS_KEY_ID           = aws_kms_key.media.arn
      WS_MGMT_ENDPOINT     = "https://${aws_apigatewayv2_api.ws.id}.execute-api.${var.aws_region}.amazonaws.com/${aws_apigatewayv2_stage.ws.name}"
      DEVICE_TOKEN_TTL     = tostring(var.device_token_ttl_seconds)
      CONTROL_TOKEN_TTL    = tostring(var.control_token_ttl_seconds)
    }
  }
}

resource "aws_cloudwatch_log_group" "authorizer" {
  name              = "/aws/lambda/${aws_lambda_function.authorizer.function_name}"
  retention_in_days = 14
}
resource "aws_cloudwatch_log_group" "ws" {
  name              = "/aws/lambda/${aws_lambda_function.ws.function_name}"
  retention_in_days = 14
}
resource "aws_cloudwatch_log_group" "http" {
  name              = "/aws/lambda/${aws_lambda_function.http.function_name}"
  retention_in_days = 14
}
