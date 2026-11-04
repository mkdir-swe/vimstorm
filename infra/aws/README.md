# Your own boxes on AWS

Terraform for running agents on boxes of your own: one person, one AWS account. Made for abe
3.6. It makes:

- a VPC with one subnet for your boxes (a public IPv4 address each for outbound traffic, nothing
  let in but ssh from the endpoint; `private_boxes = true` puts them behind a NAT gateway
  instead, about 36 USD a month more), and a free S3 gateway endpoint;
- your box role and instance profile, `abe-box-<owner>-boxes` (path `/abe/box/`, tagged
  `abe:owner`): your logins secret, the bucket, its own disk;
- the launch template `abe-box` (Ubuntu 24.04 arm64, IMDSv2 with its tags, an encrypted gp3
  disk, a shutdown from inside stops it) and its boot script, `box-boot.sh.tftpl`;
- the EC2 Instance Connect Endpoint `abe box attach` goes through (free);
- your logins secret, `abe/<owner>/logins`;
- one bucket for abe builds (`abe/`), session logs (`logs/`, kept 90 days) and the store
  (`store/`);
- a monthly cost budget for the account with alarms at 80% and 100% spent and 100% forecast;
- `abe-user`, a policy with what your Mac's profile needs, on your own boxes only.

Nothing in it names an account, bucket or person. Those are variables.

## Apply

You need Terraform 1.10 or later, the AWS CLI v2 and an AWS profile on the account: an Identity
Center one (`aws configure sso`) or a plain IAM user's keys (`aws configure`). Either works for
Terraform and for abe.

```sh
cd infra/aws
cp terraform.tfvars.example terraform.tfvars   # account_id, region, profile, owner, budget
terraform init
terraform plan
terraform apply
```

`owner` is your GitHub login, exactly as `gh api user --jq .login` spells it. Abe finds your
boxes and your secret by it.

The state stays in `terraform.tfstate` here unless you choose a backend:
`backend.tf.example` keeps it in an S3 bucket of yours. Both files are git-ignored.

Confirm the budget mail AWS sends to `alert_email`. Until you do, nobody gets the alarms.

## Use it

`terraform output settings` prints what abe needs; then, on your Mac:

```sh
abe settings set box.profile <profile>
abe settings set box.region <region>
abe settings set stores.logs s3://<bucket>/logs
abe settings set stores.org s3://<bucket>/store
abe settings set serve.target cloud
abe serve stop
```

A box installs the abe release `abe/current` in the bucket names. Put one there from this repo:

```sh
ABE_ARTIFACTS_BUCKET=<bucket> AWS_PROFILE=<profile> abe/scripts/release.sh
```

Then `abe box up`, `abe box attach` and `abe login` as the cloud guide says.

## A profile that is not an administrator

`abe-user` (output `user_policy_arn`) is what `abe box`, `abe box attach` and `abe login` need:
boxes made only from the template at a size in `box_sizes`, tagged as yours, started, stopped,
resized and ended only when tagged as yours; ssh keys pushed only to your boxes; your secret;
the bucket. It names no person or session, so it works for an IAM user (`iam_users = ["you"]`)
or an Identity Center permission set (attach the customer managed policy `abe-user`, path
`/abe/`).

## Cost

The endpoint, the VPC and the role are free. A box bills while it runs (an `m8g.large` is about
0.09 USD an hour, its public IPv4 address 0.005) and its disk while it exists (60 GB gp3, about
5 USD a month). Boxes stop themselves when idle and keep their disk. The NAT gateway, only with
`private_boxes`, is about 36 USD a month.

## Remove it

Terminate your boxes (`abe box terminate`) and empty the bucket, then `terraform destroy`.
