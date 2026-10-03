output "ws_url" {
  description = "Outbound WebSocket control endpoint for the desktop (HF_WS_URL)."
  value       = "wss://${aws_apigatewayv2_api.ws.id}.execute-api.${var.aws_region}.amazonaws.com/${aws_apigatewayv2_stage.ws.name}"
}

output "http_api_url" {
  description = "HTTP API base for browser control + device token + upload (HF_HTTP_API_URL)."
  value       = aws_apigatewayv2_api.http.api_endpoint
}

output "app_url" {
  description = "Browser control page. Append the browser_login_key as ?k=..."
  value       = "${aws_apigatewayv2_api.http.api_endpoint}/app?k=${random_password.browser_login_key.result}"
  sensitive   = true
}

output "browser_login_key" {
  description = "Key required on GET /app?k=... (mock-IdP browser login)."
  value       = random_password.browser_login_key.result
  sensitive   = true
}

output "device_bootstrap_secret" {
  description = "Device enrollment material for HF_DEVICE_BOOTSTRAP_SECRET on the workstation."
  value       = local.device_bootstrap_secret
  sensitive   = true
}

output "media_bucket" {
  value = aws_s3_bucket.media.id
}

output "control_table" {
  value = aws_dynamodb_table.control.name
}

output "teardown_hint" {
  value = "terraform -chdir=aws destroy -var-file=poc.tfvars   # removes every tagged resource"
}
