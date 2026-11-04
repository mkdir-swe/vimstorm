variable "account_id" {
  description = "The AWS account your boxes run in (12 digits). The provider refuses any other."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id is 12 digits."
  }
}

variable "region" {
  description = "The region your boxes run in (box.region)."
  type        = string
}

variable "profile" {
  description = "The AWS CLI profile Terraform runs as: Identity Center or an IAM user's keys. null: the AWS_PROFILE / default credentials."
  type        = string
  default     = null
}

variable "owner" {
  description = "Your GitHub login exactly as `gh api user --jq .login` spells it: your boxes' abe:owner tag (IAM matches it case-sensitively)."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9-]{0,38}$", var.owner))
    error_message = "owner is a GitHub login."
  }
}

variable "budget_usd" {
  description = "The account's monthly cost budget in USD: alarms at 80% and 100% spent and 100% forecast."
  type        = number
  default     = 50
}

variable "alert_email" {
  description = "Where the budget alarms go; confirm the mail AWS sends. Empty: the topic exists, nobody is subscribed."
  type        = string
  default     = ""
}

variable "name" {
  description = "Prefix of every name this makes. `abe box up` makes boxes from the launch template `abe-box`, so keep `abe` unless this is a trial beside another setup."
  type        = string
  default     = "abe"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}$", var.name))
    error_message = "name is lower-case letters, digits and dashes, 2 to 21 long."
  }
}

variable "box_sizes" {
  description = "The instance types a box may have (arm64): the first is the launch template's default. Abe's box.size names them."
  type        = list(string)
  default     = ["m8g.large", "m8g.xlarge", "m8g.2xlarge"]

  validation {
    condition     = length(var.box_sizes) > 0
    error_message = "box_sizes names at least one instance type."
  }
}

variable "disk_gb" {
  description = "A new box's root disk in GB; its serve grows it while workspaces fill it."
  type        = number
  default     = 60
}

variable "private_boxes" {
  description = "true: boxes in a private subnet behind a NAT gateway (about 36 USD a month). false: boxes get a public IPv4 address for outbound traffic, and nothing is let in but ssh from the Instance Connect Endpoint."
  type        = bool
  default     = false
}

variable "zone" {
  description = "The availability zone of the boxes' subnet; null: the region's first one."
  type        = string
  default     = null
}

variable "vpc_cidr" {
  description = "The VPC's range."
  type        = string
  default     = "10.40.0.0/16"
}

variable "iam_users" {
  description = "IAM users to attach the user policy to (what `abe box` and `abe login` need on the Mac). An administrator needs none; an Identity Center permission set attaches the policy by its name."
  type        = list(string)
  default     = []
}

variable "abe_version" {
  description = "The abe build a box with no abe yet installs while abe/current in the bucket cannot be read. Empty: none; abe/scripts/release.sh writes abe/current."
  type        = string
  default     = ""
}

variable "claude_version" {
  description = "The Claude Code a box installs on its host for `abe login claude`."
  type        = string
  default     = "2.1.308"
}

variable "secret_recovery_days" {
  description = "Days a destroyed logins secret can be restored (0: deleted at once, 7 to 30 otherwise)."
  type        = number
  default     = 7
}

variable "tags" {
  description = "Tags on everything this makes, beside project = abe."
  type        = map(string)
  default     = {}
}
