# <name>-user: what your Mac's AWS profile needs for `abe box`, `abe box attach` and `abe login`,
# on your own boxes only (abe:owner = owner). It names no person or session: whoever holds it
# acts as the owner, whether an Identity Center role or an IAM user. An administrator needs
# none of it; attach it to an IAM user with iam_users, or to a permission set by its name.

locals {
  instance_arn    = "${local.ec2_arn}:instance/*"
  volume_arn      = "${local.ec2_arn}:volume/*"
  interface_arn   = "${local.ec2_arn}:network-interface/*"
  subnet_arn      = "${local.ec2_arn}:subnet/${local.box_subnet_id}"
  template_arn    = aws_launch_template.box.arn
  security_groups = [aws_security_group.box.arn]
}

data "aws_iam_policy_document" "user" {
  # Reading is not resource-scoped in EC2: `abe box list` filters on abe:owner itself.
  statement {
    sid = "SeeBoxes"
    actions = [
      "ec2:DescribeInstances",
      "ec2:DescribeInstanceStatus",
      "ec2:DescribeInstanceTypes",
      "ec2:DescribeTags",
      "ec2:DescribeLaunchTemplates",
      "ec2:DescribeLaunchTemplateVersions",
      "ec2:DescribeInstanceConnectEndpoints",
    ]
    resources = ["*"]
  }

  # What a box is made of besides its instance and volume: only the launch template's.
  statement {
    sid       = "LaunchFromTheTemplate"
    actions   = ["ec2:RunInstances"]
    resources = concat([local.template_arn, local.interface_arn, local.subnet_arn], local.security_groups)
  }

  statement {
    sid       = "TheTemplatesImage"
    actions   = ["ec2:RunInstances"]
    resources = ["arn:aws:ec2:${var.region}::image/*"]

    condition {
      test     = "ArnEquals"
      variable = "ec2:LaunchTemplate"
      values   = [local.template_arn]
    }
    condition {
      test     = "Bool"
      variable = "ec2:IsLaunchTemplateResource"
      values   = ["true"]
    }
  }

  # A box made only from the template, at a box size, tagged as the owner's; its volume too.
  statement {
    sid       = "MakeTheOwnersBox"
    actions   = ["ec2:RunInstances"]
    resources = [local.instance_arn]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/abe:owner"
      values   = [var.owner]
    }
    condition {
      test     = "Null"
      variable = "aws:RequestTag/abe:box"
      values   = ["false"]
    }
    condition {
      test     = "ArnEquals"
      variable = "ec2:LaunchTemplate"
      values   = [local.template_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "ec2:InstanceType"
      values   = var.box_sizes
    }
  }

  statement {
    sid       = "MakeTheOwnersVolume"
    actions   = ["ec2:RunInstances"]
    resources = [local.volume_arn]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/abe:owner"
      values   = [var.owner]
    }
    condition {
      test     = "ArnEquals"
      variable = "ec2:LaunchTemplate"
      values   = [local.template_arn]
    }
  }

  # Tags only as a box is made, never a retag.
  statement {
    sid       = "TagAtLaunch"
    actions   = ["ec2:CreateTags"]
    resources = [local.instance_arn, local.volume_arn, local.interface_arn]

    condition {
      test     = "StringEquals"
      variable = "ec2:CreateAction"
      values   = ["RunInstances"]
    }
  }

  statement {
    sid       = "PassTheBoxRole"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.box.arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ec2.amazonaws.com"]
    }
  }

  # Wake, sleep and end the owner's boxes.
  statement {
    sid       = "StartStopTerminate"
    actions   = ["ec2:StartInstances", "ec2:StopInstances", "ec2:TerminateInstances"]
    resources = [local.instance_arn]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/abe:owner"
      values   = [var.owner]
    }
  }

  # Resize: the instance type only, to a box size.
  statement {
    sid       = "Resize"
    actions   = ["ec2:ModifyInstanceAttribute"]
    resources = [local.instance_arn]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/abe:owner"
      values   = [var.owner]
    }
    condition {
      test     = "StringEquals"
      variable = "ec2:Attribute/InstanceType"
      values   = var.box_sizes
    }
  }

  # Attach: a tunnel to port 22 through the endpoint, a key only to the owner's boxes as ubuntu.
  statement {
    sid       = "TunnelToSsh"
    actions   = ["ec2-instance-connect:OpenTunnel"]
    resources = [aws_ec2_instance_connect_endpoint.this.arn]

    condition {
      test     = "NumericEquals"
      variable = "ec2-instance-connect:remotePort"
      values   = ["22"]
    }
    condition {
      test     = "NumericLessThanEquals"
      variable = "ec2-instance-connect:maxTunnelDuration"
      values   = ["3600"]
    }
  }

  statement {
    sid       = "KeyToTheOwnersBoxes"
    actions   = ["ec2-instance-connect:SendSSHPublicKey"]
    resources = [local.instance_arn]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/abe:owner"
      values   = [var.owner]
    }
    condition {
      test     = "StringEquals"
      variable = "ec2:osuser"
      values   = ["ubuntu"]
    }
  }

  # abe login: the secret found by its tag, then read and written.
  statement {
    sid       = "FindSecrets"
    actions   = ["secretsmanager:ListSecrets"]
    resources = ["*"]
  }

  statement {
    sid       = "Logins"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue", "secretsmanager:DescribeSecret"]
    resources = [aws_secretsmanager_secret.logins.arn]
  }

  # The bucket: releases put, logs and the store read on the Mac.
  statement {
    sid       = "Bucket"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.this.arn]
  }

  statement {
    sid       = "Objects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.this.arn}/*"]
  }
}

resource "aws_iam_policy" "user" {
  name        = "${var.name}-user"
  path        = "/abe/"
  description = "What ${var.owner}'s Mac needs for abe box, attach and login on their own boxes."
  policy      = data.aws_iam_policy_document.user.json
}

resource "aws_iam_user_policy_attachment" "user" {
  for_each = toset(var.iam_users)

  user       = each.value
  policy_arn = aws_iam_policy.user.arn
}
