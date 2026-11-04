# Part: logins

Passes when every tool the repo needs answers, and the live read of GitHub and the cloud is right. Do it before anything remote, so the board, GitHub and the sources can be read. A personal part: on a join it is the person's too.

## 1. Each tool

1. Run `abe install logins --json`. Each needed tool (`github`, `claude`, `az`, `aws`) is `ok`, `missing`, `expired`, `unchecked` or `skipped`.
   - **az** is needed only for an Azure board (one `abe.yaml` names, one the person gave, or Azure CI). Until the board is known to be Azure it is `skipped`: never ask the person to sign in to az for a board that is not Azure. When [board](board.md) picks Azure, come back here.
   - **aws** is needed only when the repo uses it (`read.aws`: its SDK, CDK, Terraform's aws provider, Serverless, an aws CI step, `AWS_*` env keys, an aws source). Else it is `skipped`.
2. For each one not ok, its `fix` names the login. A login opens the person's browser or reads their terminal, so it is theirs: tell them in one line which ones and why the repo needs each, with the exact command to run here, prefixed with `!` (`! az login --allow-no-subscriptions`, or the `fix` as given). You never type a password, read a token or print one.
3. When they say they signed in, run `abe install logins` again.

## 2. Which account and profile

The settings that say who the person is are theirs, in `.abe/settings.local.yaml`, names only; never in `abe.yaml`:

- `logins: { gh: <account>, az: <account> }`: the gh account Abe reads GitHub as for this repo (when it is not gh's active login), and the az account. Never `gh auth switch`.
- `credentials: { <env>: { awsProfile: <profile> } }`: the aws profile each environment runs with. Set it with `abe install env-profile <dev|test|prod> <profile|none>`.

**The aws profiles are an up-front question** when the repo uses aws: which profile each environment runs with (one question per environment when the repo says they differ). Offer the profiles Read saw the repo name first (`read.awsProfiles`, where each was seen), then this machine's other ones by name, then **None**, then **Not sure: find out**. Never offer a prod-looking profile (`prod`, `*-prod`, `prod-readonly`) for dev or test. Never take the one in the person's machine-wide settings (`~/.config/abe/settings.yaml`): that one is for their boxes.

While aws has no profile or its login is not ok, aws is off for the install: never run a repo script that needs it.

## 3. The live read

`abe install connection` has serve read GitHub and the cloud live (`connection.facts` in the status; each `ok`, `failed` with `why` and `fix`, `warning`, or `skipped`):

- **GitHub**: the repo from origin, the account Abe reads it as (`logins.gh`, else gh's active login), whether it reads pull requests. When the account in force can't read the repo, serve tries each other signed-in gh login read-only and sets the one that reads it as this checkout's gh account itself: the Account row says which, and why. Tell the person in one line. When none can, the fact says which logins were tried, and the fix is a sign-in as an account that can. The `githubIdentity` setting guards writes only: it never changes the account Abe reads as, so never suggest it to fix a failed read.
- **Cloud**: when cards run in cloud boxes, the settings' `box.profile` and `box.region` and the account the profile is. Box infrastructure is set up by the platform Terraform, never a setting: when it is missing, the fact says `set up by the platform Terraform (infra/aws)`; never set it up from here. When cards run on this machine, the app's aws login when the repo uses aws.
- **Env file · <environment>**: the aws profile the app runs with there and its Abe env file's key names; never a value. An expired aws login fails, its fix the sign-in the person runs.

Fix what you can yourself, give the person the `fix` that is theirs, and read it again after a fix. Then `abe install check logins`.
