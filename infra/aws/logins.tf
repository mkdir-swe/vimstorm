# Your logins secret: GitHub, Claude Code, az and aws logins kept once (abe login), restored by
# your boxes on start and written back when a tool refreshes one. abe finds it by its name
# (abe/<owner>/logins) and its abe:owner tag. No value here: the first box or `abe login` writes
# it. Encrypted with the account's AWS managed Secrets Manager key; who reads it is IAM's: your
# box role (box.tf) and whoever holds the user policy (user.tf) or administers the account.

resource "aws_secretsmanager_secret" "logins" {
  name                    = "abe/${var.owner}/logins"
  description             = "The logins of ${var.owner}'s boxes"
  recovery_window_in_days = var.secret_recovery_days

  tags = { "abe:owner" = var.owner }
}
