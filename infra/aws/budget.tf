# The account's monthly cost budget: alarms at 80% and 100% spent and 100% forecast, to one SNS
# topic; alert_email subscribed (pending until you confirm AWS's mail). Unencrypted topic:
# Budgets cannot publish under the AWS managed SNS key.

resource "aws_sns_topic" "budget" {
  name = "${var.name}-budget"
}

data "aws_iam_policy_document" "budget_topic" {
  statement {
    sid       = "BudgetsPublishes"
    actions   = ["SNS:Publish"]
    resources = [aws_sns_topic.budget.arn]

    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "budget" {
  arn    = aws_sns_topic.budget.arn
  policy = data.aws_iam_policy_document.budget_topic.json
}

resource "aws_sns_topic_subscription" "budget_email" {
  count = var.alert_email == "" ? 0 : 1

  topic_arn = aws_sns_topic.budget.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_budgets_budget" "this" {
  name         = "${var.name}-monthly"
  budget_type  = "COST"
  limit_amount = format("%.2f", var.budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "notification" {
    for_each = [
      { kind = "ACTUAL", percent = 80 },
      { kind = "ACTUAL", percent = 100 },
      { kind = "FORECASTED", percent = 100 },
    ]

    content {
      comparison_operator       = "GREATER_THAN"
      threshold                 = notification.value.percent
      threshold_type            = "PERCENTAGE"
      notification_type         = notification.value.kind
      subscriber_sns_topic_arns = [aws_sns_topic.budget.arn]
    }
  }

  depends_on = [aws_sns_topic_policy.budget]
}
