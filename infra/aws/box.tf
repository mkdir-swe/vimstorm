# Your boxes (ADR 0021): `abe box up` on your Mac makes each from the launch template
# <name>-box, naming only its size, your box role and its tags; everything else is here. One box
# per repo, a workspace per card on it (ADR 0022). A box with no public address of its own
# (private_boxes) or one whose security group lets in nothing but ssh from the endpoint
# (eice.tf).

locals {
  role_name = "${var.name}-box-${var.owner}-boxes"
  ec2_arn   = "arn:aws:ec2:${var.region}:${var.account_id}"
}

# Your box role: EC2 only (never sts:TagSession: its abe:owner tag is the fence).
data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "box" {
  name               = local.role_name
  path               = "/abe/box/"
  description        = "The boxes of ${var.owner}"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json

  tags = { "abe:owner" = var.owner }
}

resource "aws_iam_instance_profile" "box" {
  name = local.role_name
  path = "/abe/box/"
  role = aws_iam_role.box.name

  tags = { "abe:owner" = var.owner }
}

# What a box's serve does in AWS: your logins secret, the bucket (abe builds read; logs and the
# store read and written), its own disk grown while workspaces fill it.
data "aws_iam_policy_document" "box" {
  statement {
    sid       = "Logins"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue", "secretsmanager:DescribeSecret"]
    resources = [aws_secretsmanager_secret.logins.arn]
  }

  statement {
    sid       = "ReadBuilds"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.this.arn}/abe/*"]
  }

  statement {
    sid       = "LogsAndStore"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.this.arn}/logs/*", "${aws_s3_bucket.this.arn}/store/*"]
  }

  statement {
    sid       = "List"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.this.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["abe/*", "logs/*", "store/*"]
    }
  }

  statement {
    sid       = "GrowItsOwnVolumes"
    actions   = ["ec2:ModifyVolume"]
    resources = ["${local.ec2_arn}:volume/*"]

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/abe:owner"
      values   = [var.owner]
    }
  }

  # Not resource-scoped in EC2: the box finds its root volume and follows the change.
  statement {
    sid       = "SeeVolumes"
    actions   = ["ec2:DescribeVolumes", "ec2:DescribeVolumesModifications"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "box" {
  name   = "box"
  role   = aws_iam_role.box.id
  policy = data.aws_iam_policy_document.box.json
}

# Session Manager too, as a way in beside ssh.
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.box.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_security_group" "box" {
  name        = "${var.name}-box"
  description = "Abe boxes: ssh from the Instance Connect Endpoint only, everything out"
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${var.name}-box" }
}

resource "aws_vpc_security_group_egress_rule" "box_out" {
  security_group_id = aws_security_group.box.id
  description       = "everything out"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

# Every box's user data: cloud-init, then box-boot.sh.tftpl on every boot. A box is made its own
# by its tags (abe:owner, abe:box, abe:repo), read through the instance metadata.
data "cloudinit_config" "box" {
  gzip          = true
  base64_encode = true

  part {
    filename     = "cloud-config.yaml"
    content_type = "text/cloud-config"
    content = yamlencode({
      cloud_final_modules = [["scripts-user", "always"]]
      package_update      = false
      package_upgrade     = false
      preserve_hostname   = true
      manage_etc_hosts    = false
      disable_root        = true
      ssh_pwauth          = false
    })
  }

  part {
    filename     = "boot.sh"
    content_type = "text/x-shellscript"
    content = templatefile("${path.module}/box-boot.sh.tftpl", {
      user           = "ubuntu"
      bucket         = aws_s3_bucket.this.id
      region         = var.region
      abe_version    = var.abe_version
      claude_version = var.claude_version
      log_store      = local.log_store
      org_store      = local.org_store
      logins_secret  = aws_secretsmanager_secret.logins.name
    })
  }
}

data "aws_ssm_parameter" "ubuntu" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id"
}

resource "aws_launch_template" "box" {
  name                   = "${var.name}-box"
  description            = "An abe box: abe box up names its size, role and tags."
  image_id               = data.aws_ssm_parameter.ubuntu.insecure_value
  instance_type          = var.box_sizes[0]
  user_data              = data.cloudinit_config.box.rendered
  update_default_version = true

  # The box's serve shuts it down when idle: that stops it, its disk kept.
  instance_initiated_shutdown_behavior = "stop"

  network_interfaces {
    subnet_id                   = local.box_subnet_id
    security_groups             = [aws_security_group.box.id]
    associate_public_ip_address = !var.private_boxes
    delete_on_termination       = true
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "enabled"
  }

  block_device_mappings {
    device_name = "/dev/sda1"

    ebs {
      volume_type           = "gp3"
      volume_size           = var.disk_gb
      encrypted             = true
      delete_on_termination = true
    }
  }

  lifecycle {
    # A new Ubuntu image becomes the default only when this is applied for another reason.
    ignore_changes = [image_id]
  }
}
