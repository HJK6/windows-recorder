# ---- API Gateway WebSocket API (the outbound control channel) --------------
resource "aws_apigatewayv2_api" "ws" {
  name                       = "${local.prefix}-ws"
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.type"
}

resource "aws_apigatewayv2_authorizer" "ws_connect" {
  api_id           = aws_apigatewayv2_api.ws.id
  authorizer_type  = "REQUEST"
  name             = "${local.prefix}-connect-authorizer"
  authorizer_uri   = aws_lambda_function.authorizer.invoke_arn
  identity_sources = ["route.request.header.Authorization"]
}

resource "aws_apigatewayv2_integration" "ws" {
  api_id                    = aws_apigatewayv2_api.ws.id
  integration_type          = "AWS_PROXY"
  integration_uri           = aws_lambda_function.ws.invoke_arn
  content_handling_strategy = "CONVERT_TO_TEXT"
  passthrough_behavior      = "WHEN_NO_MATCH"
}

locals {
  ws_target = "integrations/${aws_apigatewayv2_integration.ws.id}"
}

resource "aws_apigatewayv2_route" "connect" {
  api_id             = aws_apigatewayv2_api.ws.id
  route_key          = "$connect"
  authorization_type = "CUSTOM"
  authorizer_id      = aws_apigatewayv2_authorizer.ws_connect.id
  target             = local.ws_target
}

resource "aws_apigatewayv2_route" "disconnect" {
  api_id    = aws_apigatewayv2_api.ws.id
  route_key = "$disconnect"
  target    = local.ws_target
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.ws.id
  route_key = "$default"
  target    = local.ws_target
}

resource "aws_apigatewayv2_route" "hello" {
  api_id    = aws_apigatewayv2_api.ws.id
  route_key = "hello"
  target    = local.ws_target
}

resource "aws_apigatewayv2_route" "heartbeat" {
  api_id    = aws_apigatewayv2_api.ws.id
  route_key = "heartbeat"
  target    = local.ws_target
}

resource "aws_apigatewayv2_route" "command_ack" {
  api_id    = aws_apigatewayv2_api.ws.id
  route_key = "command.ack"
  target    = local.ws_target
}

resource "aws_apigatewayv2_stage" "ws" {
  api_id      = aws_apigatewayv2_api.ws.id
  name        = "poc"
  auto_deploy = true
}

resource "aws_lambda_permission" "ws_invoke" {
  statement_id  = "AllowWSInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ws.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ws.execution_arn}/*"
}

resource "aws_lambda_permission" "ws_authorizer_invoke" {
  statement_id  = "AllowWSAuthorizerInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.authorizer.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ws.execution_arn}/*"
}
