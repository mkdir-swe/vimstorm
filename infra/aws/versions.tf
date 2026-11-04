# Your own boxes in one AWS account: the network, your box role, the launch template `abe box up`
# makes boxes from, the Instance Connect Endpoint `abe box attach` goes through, your logins
# secret, one bucket (abe builds, session logs, the store) and a budget alarm. README.md.
#
# No backend here: the state is local (terraform.tfstate) unless you add one
# (backend.tf.example).

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    cloudinit = {
      source  = "hashicorp/cloudinit"
      version = "~> 2.3"
    }
  }
}

provider "aws" {
  region  = var.region
  profile = var.profile
  # A profile on another account plans nothing.
  allowed_account_ids = [var.account_id]

  default_tags {
    tags = merge({ project = "abe" }, var.tags)
  }
}
