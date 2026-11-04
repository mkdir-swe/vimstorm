# 0021 · Our own box layer on AWS, not Coder

Status: accepted, 24 Oct 2026. Supersedes the Coder parts of 0016.

Boxes are started, stopped, resized and attached by `abe box`, our own TypeScript over EC2, IAM Identity Center and EC2 Instance Connect Endpoint, not by Coder.

**Why.** Coder's open-source edition is open core: what a company needs (audit logs, IdP group sync, quotas, external provisioners, high availability) is Premium. Once each workspace got its own box (0016 amendment), Coder only gave us lifecycle, attach and login, all of which AWS gives directly with the developer's SSO login, with no server, database or OAuth app to run.

**How.** A box is an EC2 instance from the box launch template, tagged `abe:owner` and `abe:box`; IAM lets a developer act only on boxes with their own owner tag. The box's `abe serve` stops the box when it has been idle (no hooks, no one attached) for a set time; the disk stays. Attach is SSH through an EC2 Instance Connect Endpoint (no public address, a key per connection) with a reconnect loop around tmux; Chat and `g w` use it.

**Trade-off.** Coder's peer-to-peer tunnel reconnected fastest in the attach spike. The SSH path is measured against the same bar before it is built; if it fails, the fallback is our own WireGuard, never SSM shell sessions (they hung after sleep).

**Status / details (M2).** Built as above, with these details. The tunnel is abe's own SigV4 client (`abe box tunnel`, ssh's ProxyCommand): the stock `aws ec2-instance-connect open-tunnel` polls stdin every 50 ms and fails the latency bar. `serve.target` defaults to cloud, so your environment (your boxes) is where launches go; `local` in a Layer keeps them on the Mac. A box is tagged `abe:owner`, `abe:team`, `abe:box`, `abe:repo`, `abe:card` and `abe:title`. Each person has one box role (`/abe/box/abe-box-<login>-boxes`) that all their boxes run as.
