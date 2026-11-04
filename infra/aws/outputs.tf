output "settings" {
  description = "What to tell abe on your Mac (README.md › Use it)."
  value = {
    "box.region"  = var.region
    "box.owner"   = var.owner
    "stores.logs" = local.log_store
    "stores.org"  = local.org_store
  }
}

output "artifacts_bucket" {
  description = "ABE_ARTIFACTS_BUCKET for abe/scripts/release.sh."
  value       = aws_s3_bucket.this.id
}

output "launch_template_name" {
  value = aws_launch_template.box.name
}

output "box_role_name" {
  description = "Your box role and instance profile, which `abe box up` passes."
  value       = aws_iam_role.box.name
}

output "logins_secret" {
  value = aws_secretsmanager_secret.logins.name
}

output "eice_id" {
  value = aws_ec2_instance_connect_endpoint.this.id
}

output "user_policy_arn" {
  description = "Attach to a non-administrator profile's IAM user or permission set."
  value       = aws_iam_policy.user.arn
}

output "budget_topic_arn" {
  value = aws_sns_topic.budget.arn
}
