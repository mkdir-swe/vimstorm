# Attach (ADR 0021): the Mac reaches a box's ssh through one EC2 Instance Connect Endpoint in the
# VPC; every connection pushes a fresh key with send-ssh-public-key. Free; 20 connections at
# once, a tunnel cut after 1 h (abe's attach loop reconnects).

resource "aws_security_group" "eice" {
  name        = "${var.name}-eice"
  description = "Abe EC2 Instance Connect Endpoint: ssh out to the boxes only"
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${var.name}-eice" }
}

resource "aws_vpc_security_group_egress_rule" "eice_to_box" {
  security_group_id            = aws_security_group.eice.id
  description                  = "ssh to the boxes"
  referenced_security_group_id = aws_security_group.box.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

# The only way into a box: tcp 22 from the endpoint.
resource "aws_vpc_security_group_ingress_rule" "box_from_eice" {
  security_group_id            = aws_security_group.box.id
  description                  = "ssh from the Instance Connect Endpoint only"
  referenced_security_group_id = aws_security_group.eice.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

# preserve_client_ip off, so the box sees the endpoint's address and the rule above matches.
resource "aws_ec2_instance_connect_endpoint" "this" {
  subnet_id          = local.box_subnet_id
  security_group_ids = [aws_security_group.eice.id]
  preserve_client_ip = false

  tags = { Name = "${var.name}-eice" }
}
