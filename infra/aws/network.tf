# One VPC, one zone. The boxes' subnet is public (each box a public IPv4 address for outbound
# traffic, nothing let in but ssh from the Instance Connect Endpoint) or, with private_boxes,
# private behind one NAT gateway. S3 through a gateway endpoint (free) either way.

data "aws_availability_zones" "up" {
  state = "available"
}

locals {
  zone = coalesce(var.zone, data.aws_availability_zones.up.names[0])
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = var.name }
}

# The default security group allows nothing.
resource "aws_default_security_group" "none" {
  vpc_id = aws_vpc.this.id
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = { Name = var.name }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.this.id
  availability_zone       = local.zone
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, 0)
  map_public_ip_on_launch = false

  tags = { Name = "${var.name}-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  tags = { Name = "${var.name}-public" }
}

resource "aws_route" "public_out" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# private_boxes: the boxes' own subnet, out through one NAT gateway.
resource "aws_subnet" "private" {
  count = var.private_boxes ? 1 : 0

  vpc_id            = aws_vpc.this.id
  availability_zone = local.zone
  cidr_block        = cidrsubnet(var.vpc_cidr, 3, 1)

  tags = { Name = "${var.name}-private" }
}

resource "aws_eip" "nat" {
  count = var.private_boxes ? 1 : 0

  domain = "vpc"
  tags   = { Name = "${var.name}-nat" }
}

resource "aws_nat_gateway" "this" {
  count = var.private_boxes ? 1 : 0

  subnet_id     = aws_subnet.public.id
  allocation_id = aws_eip.nat[0].id

  tags = { Name = var.name }

  depends_on = [aws_internet_gateway.this]
}

resource "aws_route_table" "private" {
  count = var.private_boxes ? 1 : 0

  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name}-private" }
}

resource "aws_route" "private_out" {
  count = var.private_boxes ? 1 : 0

  route_table_id         = aws_route_table.private[0].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[0].id
}

resource "aws_route_table_association" "private" {
  count = var.private_boxes ? 1 : 0

  subnet_id      = aws_subnet.private[0].id
  route_table_id = aws_route_table.private[0].id
}

locals {
  box_subnet_id   = var.private_boxes ? aws_subnet.private[0].id : aws_subnet.public.id
  box_route_table = var.private_boxes ? aws_route_table.private[0].id : aws_route_table.public.id
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [local.box_route_table]

  tags = { Name = "${var.name}-s3" }
}
