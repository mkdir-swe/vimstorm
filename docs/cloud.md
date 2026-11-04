# Cloud: agents on your own box

By default every session runs on this Mac ([Getting started](getting-started.md)). With an AWS account of your own, a session can run on **your box** instead: an EC2 instance per repo, a container per card on it, Claude Code in tmux inside. It keeps working after you close the laptop, and VimStorm picks it up again when you come back.

This guide fits **abe 3.6** (`abe --version` on your Mac says `3.6.…`). The Terraform in `infra/aws/` and the `abe` your boxes run come from the same checkout: keep them on the same release.

## What the Terraform makes

`infra/aws/` sets up one person in one AWS account:

- a network for your boxes, with no public addresses;
- an EC2 Instance Connect Endpoint, the only way in (SSH through it, signed with your AWS login);
- your box role and the launch template your boxes start from (Graviton);
- a Secrets Manager secret for your logins (GitHub, Claude Code), readable only by your boxes;
- one S3 bucket for session logs, the store and abe's releases for the boxes;
- a budget alarm, so a forgotten box does not surprise you.

Boxes are not in the Terraform: Abe makes them when you launch a card, puts them to sleep when idle (the disk is kept) and wakes them in about 30 seconds.

## 1. Before you start

- An AWS account, and an AWS CLI profile for it: IAM Identity Center or a plain IAM user both work. Check it with `aws sts get-caller-identity --profile <profile>`.
- The AWS CLI: `install.sh --cloud` adds it.
- Terraform: `brew install hashicorp/tap/terraform`.

## 2. Apply the Terraform

```sh
cd ~/projects/vimstorm/infra/aws
terraform init
AWS_PROFILE=<profile> terraform apply
```

Terraform asks for what is yours: the account id, the region, your GitHub login (your boxes are tagged with it, and IAM lets you act only on boxes carrying it) and a monthly budget. Nothing specific to you is in the repo. State stays in this folder unless you add a backend of your choice (an S3 backend, say) before `init`.

`terraform output` names the bucket you will give Abe below.

## 3. Point Abe at your account

These are yours on this Mac (`~/.config/abe/settings.yaml`); run them outside any repo:

```sh
cd ~
abe settings set box.profile <profile>
abe settings set box.region <region>
abe settings set stores.logs s3://<bucket>
```

`box.owner` is your GitHub login unless you set it. `abe serve` reads these when it starts, so restart it once no session is live: `abe serve stop` (the next `abe` command starts it again).

Then send sessions to your boxes. Outside any repo, as here, for every repo on this Mac:

```sh
abe settings set serve.target cloud
```

Run the same command inside a repo's checkout to change that repo alone (it is written to the checkout's `.abe/settings.local.yaml`, never committed). `abe settings explain serve.target` says which value wins and where it comes from; `abe tools check` now also checks the AWS CLI.

## 4. A long-running session

Launch a card as before: ⏎ on it on the Board, then Launch agent. The first launch for a repo makes its box (a few minutes: boot, the base image, the repo's image); after that a sleeping box wakes in about 30 seconds. VimStorm shows each step, so a launch is never a bare spinner.

Your box signs in to GitHub and Claude Code on its own. The first time, sign it in from your Mac (each prints a URL and a code to open here; the logins are kept in your secret and restored on every start):

```sh
abe box list                       # your boxes, their state and today's cost
abe --on <box> login github
abe --on <box> login claude
```

Then:

- **Chat** attaches to the session's tmux over SSH, and reconnects by itself after a drop.
- **Close the laptop.** Claude keeps working in tmux on the box. When you open VimStorm again it follows the box's events from where it left off.
- **Idle boxes sleep.** No session working and nobody attached for `box.idleMinutes`: the box warns, shuts down and keeps its disk. `abe box keep <box>` keeps one awake until `abe box sleep <box>`; `abe box stop <box>` puts it to sleep now.
- **Move a session.** `abe session move-to-cloud <id>` takes a session from this Mac to its box; `abe session download <id>` brings a box's session back here.

## A new abe on your box

A box runs the abe its bucket pins; your Mac runs the one you built. When they differ, `abe box list` marks the box's release, and a command the box's abe does not know is refused with `box-version`, naming both versions.

To bring your boxes to the abe of this checkout, from a clean commit:

```sh
AWS_PROFILE=<profile> ABE_ARTIFACTS_BUCKET=<bucket> abe/scripts/release.sh
```

It builds the Linux binary and the box's images, puts them in the bucket under `abe/<version>/`, and moves the pin, `abe/current`, to that version last. Each box installs it on its next start:

```sh
abe box stop <box> && abe box start <box>
abe --on <box> status              # the new version
```

`--no-current` puts a build without moving the boxes to it.

## Taking it down

Terminate your boxes first (`abe box terminate <box> --yes`; work not pushed is lost), then `AWS_PROFILE=<profile> terraform destroy` in `infra/aws/`. Set `serve.target` back with `abe settings set serve.target local`.

How the pieces talk: [Architecture](architecture.md). The details: [Boxes](reference/boxes.md) and [Sessions in your environment](reference/cloud-sessions.md).
