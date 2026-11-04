//! The app's scripts on a temp `HOME`: install.sh puts Abe 3.x from the bundle on PATH with the
//! tools it needs and drops 1.x's links; warmup.sh and the warm-up's Mason step; bundle.sh builds
//! VimStorm.app with this build's binary and Abe 3.x beside it, signed.

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

fn repo() -> PathBuf {
    std::fs::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).join("..")).unwrap()
}

/// A copy of what install.sh reads from this checkout (the script, the `vimstorm` command) in
/// `root/repo`, with the 1.x copilot plugin's folder an old checkout keeps, so a test install can
/// drop the 1.x links in it without touching this checkout; with a stand-in bundle in `root/apps` holding this build's binary and,
/// with `abe`, a stand-in Abe 3.x beside it.
fn install_fixture(root: &Path, abe: bool) -> PathBuf {
    let copy = root.join("repo");
    for file in ["install.sh", "app/scripts/vimstorm"] {
        let to = copy.join(file);
        std::fs::create_dir_all(to.parent().unwrap()).unwrap();
        std::fs::copy(repo().join(file), &to).unwrap();
    }
    std::fs::create_dir_all(copy.join("plugins/copilot")).unwrap();
    let macos = root.join("apps/VimStorm.app/Contents/MacOS");
    std::fs::create_dir_all(&macos).unwrap();
    std::os::unix::fs::symlink(env!("CARGO_BIN_EXE_vimstorm"), macos.join("vimstorm")).unwrap();
    if abe {
        let abe = macos.join("abe");
        std::fs::write(&abe, "#!/bin/sh\necho \"abe 2: $*\"\n").unwrap();
        std::fs::set_permissions(&abe, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
    }
    copy
}

/// install.sh from `copy` into `root`'s temp prefix and HOME; its stdout.
fn install(copy: &Path, root: &Path, path: &str, skip_tools: bool) -> String {
    install_with(copy, root, path, skip_tools, &[])
}

/// `install` with install.sh's `args` (`--cloud`).
fn install_with(copy: &Path, root: &Path, path: &str, skip_tools: bool, args: &[&str]) -> String {
    let home = root.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let out = Command::new(copy.join("install.sh"))
        .args(args)
        .env("HOME", &home)
        .env("PATH", path)
        .env_remove("XDG_CONFIG_HOME")
        .env_remove("XDG_DATA_HOME")
        .env("VIMSTORM_SKIP_TOOLS", if skip_tools { "1" } else { "0" })
        .env("VIMSTORM_SKIP_APP", "1")
        .env("VIMSTORM_SKIP_WARMUP", "1")
        .env("VIMSTORM_LSREGISTER", "0")
        .env("VIMSTORM_APPS_DIR", root.join("apps"))
        .env("VIMSTORM_BIN_DIR", root.join("bin"))
        .stdin(Stdio::null())
        .output()
        .unwrap();
    let said = String::from_utf8_lossy(&out.stdout).into_owned();
    assert!(
        out.status.success(),
        "{said}{}",
        String::from_utf8_lossy(&out.stderr)
    );
    said
}

/// install.sh into a temp prefix and a temp HOME: `abe` is Abe 3.x, the bundle's
/// `Contents/MacOS/abe` (replacing TS Abe's wrapper and the 1.x link there), the 1.x-only links
/// (`abe-hook` beside the command, TS Abe's skills in the copilot plugin) are gone.
#[test]
fn install_sh_puts_abe_on_path_and_drops_the_1x_links() {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let copy = install_fixture(&root, true);
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    // TS Abe's `abe setup-path` wrapper, as it stands in ~/.local/bin on an old Mac; the 1.x
    // install's links
    std::fs::write(bin.join("abe"), "#!/bin/sh\nexec ts-abe \"$@\"\n").unwrap();
    std::os::unix::fs::symlink(copy.join("bin/abe-hook"), bin.join("abe-hook")).unwrap();
    std::fs::create_dir_all(root.join("ts-abe/skills")).unwrap();
    std::os::unix::fs::symlink(
        root.join("ts-abe/skills"),
        copy.join("plugins/copilot/skills"),
    )
    .unwrap();

    let said = install(&copy, &root, "/usr/bin:/bin:/usr/sbin:/sbin", true);
    let macos = root.join("apps/VimStorm.app/Contents/MacOS");
    assert_eq!(
        std::fs::read_link(bin.join("abe")).unwrap(),
        macos.join("abe"),
        "abe is the bundle's Abe 3.x: {said}"
    );
    let two = Command::new(bin.join("abe")).arg("help").output().unwrap();
    assert_eq!(String::from_utf8_lossy(&two.stdout), "abe 2: help\n");
    assert!(bin.join("vimstorm").exists());
    assert!(std::fs::symlink_metadata(bin.join("abe-hook")).is_err());
    assert!(std::fs::symlink_metadata(copy.join("plugins/copilot/skills")).is_err());
    assert!(
        !copy.join("plugins").exists(),
        "the empty 1.x plugin folder goes too"
    );
    assert!(
        root.join("ts-abe/skills").is_dir(),
        "TS Abe's own skills stay"
    );
    // its next steps: az only where the board is Azure, never a login every repo needs
    let logins = said
        .lines()
        .find(|l| l.contains("1. logins:"))
        .unwrap_or_else(|| panic!("no logins step: {said}"));
    assert!(!logins.contains("az login"), "{logins}");
    assert!(said.contains("an Azure board also needs az"), "{said}");
    // sessions run on this Mac (ADR 0042); cloud is the flag and the setting
    assert!(said.contains("sessions run on this Mac"), "{said}");
    assert!(said.contains("./install.sh --cloud"), "{said}");
}

/// A bundle without Abe 3.x (an old one kept with `VIMSTORM_SKIP_APP`): `abe` is left as it was
/// and install.sh says why.
#[test]
fn install_sh_without_abe_in_the_bundle_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let copy = install_fixture(&root, false);
    let said = install(&copy, &root, "/usr/bin:/bin:/usr/sbin:/sbin", true);
    assert!(said.contains("no Abe 3.x"), "{said}");
    assert!(std::fs::symlink_metadata(root.join("bin/abe")).is_err());
}

/// A serve from the old abe still answering once the new one is in place: stopped when no
/// session is live; with live sessions left running, saying it is the old one and how to restart.
#[test]
fn install_sh_stops_the_old_serve_unless_sessions_are_live() {
    // (the serve's sessions, or none running; what install.sh says; whether it stopped it)
    let rows: [(Option<u32>, Option<&str>, bool); 3] = [
        (None, None, false),
        (
            Some(0),
            Some("  stopped the running abe serve: the next abe command starts the new one"),
            true,
        ),
        (
            Some(2),
            Some(
                "  note: the running abe serve is the old abe, with 2 live sessions: once they end, abe serve stop (the next abe command starts the new one)",
            ),
            false,
        ),
    ];
    for (sessions, line, stopped) in rows {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let copy = install_fixture(&root, true);
        let serve = root.join("serve");
        if let Some(n) = sessions {
            std::fs::write(&serve, n.to_string()).unwrap();
        }
        // a stand-in for the new abe: `status` answers while the old serve runs, `serve stop` is logged
        std::fs::write(
            root.join("apps/VimStorm.app/Contents/MacOS/abe"),
            format!(
                "#!/bin/sh\ncase \"$*\" in\n'status --json --no-start') [ -f '{s}' ] || exit 3; printf '{{\"ok\":true,\"data\":{{\"version\":\"old\",\"sessions\":%s}}}}\\n' \"$(cat '{s}')\" ;;\n'serve stop') echo stop >>'{s}.stops' ;;\nesac\n",
                s = serve.display()
            ),
        )
        .unwrap();
        let said = install(&copy, &root, "/usr/bin:/bin:/usr/sbin:/sbin", true);
        let lines: Vec<&str> = said.lines().filter(|l| l.contains("abe serve")).collect();
        assert_eq!(
            lines,
            line.into_iter().collect::<Vec<_>>(),
            "{sessions:?}: {said}"
        );
        assert_eq!(
            root.join("serve.stops").exists(),
            stopped,
            "{sessions:?}: {said}"
        );
    }
}

/// The tools Abe 3.x needs come with Homebrew when missing (bun from its tap), Claude Code from
/// its own installer, Docker only a note; awscli only with `--cloud`, azure-cli never (ADR 0042).
/// A fake `brew` and `curl` stand in; every editor tool is there already.
#[test]
fn install_sh_installs_the_tools_abe_needs() {
    for cloud in [false, true] {
        let brew = brew_install(if cloud { &["--cloud"] } else { &[] });
        for pkg in ["oven-sh/bun/bun", "gh", "tmux", "ffmpeg"] {
            assert!(brew.split(' ').any(|w| w == pkg), "{pkg}: {brew}");
        }
        for there in ["neovim", "ripgrep", "node", "azure-cli"] {
            assert!(!brew.split(' ').any(|w| w == there), "{there}: {brew}");
        }
        assert_eq!(brew.split(' ').any(|w| w == "awscli"), cloud, "{brew}");
    }
}

/// install.sh with `args`, tools on: the `brew install` line it ran (and Claude Code's installer
/// and the Docker note checked on the way).
fn brew_install(args: &[&str]) -> String {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let copy = install_fixture(&root, true);
    let fake = root.join("fake");
    std::fs::create_dir_all(&fake).unwrap();
    let log = root.join("calls.log");
    let script = |name: &str, body: &str| {
        let p = fake.join(name);
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    };
    for tool in ["rg", "fd", "lazygit", "node", "tree-sitter", "cargo"] {
        script(tool, "exit 0");
    }
    script("nvim", "echo 'NVIM v0.12.0'");
    script("brew", &format!("echo \"brew $*\" >>'{}'", log.display()));
    // the official installer's script, run by bash
    script(
        "curl",
        &format!(
            "echo \"curl $*\" >>'{0}'; echo \"echo claude-installer >>'{0}'\"",
            log.display()
        ),
    );
    let path = format!("{}:/usr/bin:/bin:/usr/sbin:/sbin", fake.display());
    let said = install_with(&copy, &root, &path, false, args);
    let calls = std::fs::read_to_string(&log).unwrap();
    assert!(
        calls.contains("curl -fsSL https://claude.ai/install.sh"),
        "{calls}"
    );
    assert!(calls.contains("claude-installer"), "{calls}");
    assert!(said.contains("Docker"), "{said}");
    calls
        .lines()
        .find(|l| l.starts_with("brew install"))
        .unwrap_or_else(|| panic!("no brew install: {calls}"))
        .to_owned()
}

/// An executable `name` in `dir` running `body` under `/bin/sh`.
fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
    std::fs::create_dir_all(dir).unwrap();
    let p = dir.join(name);
    std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&p, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    p
}

/// install.sh from `copy` with the warm-up on (its `app/scripts/warmup.sh` the fixture's), the
/// rest as `install` runs it: its output, success or not.
fn install_warming(copy: &Path, root: &Path) -> std::process::Output {
    let home = root.join("home");
    std::fs::create_dir_all(&home).unwrap();
    Command::new(copy.join("install.sh"))
        .env("HOME", &home)
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("XDG_DATA_HOME", root.join("data"))
        .env("VIMSTORM_SKIP_TOOLS", "1")
        .env("VIMSTORM_SKIP_APP", "1")
        .env("VIMSTORM_SKIP_WARMUP", "0")
        .env("VIMSTORM_LSREGISTER", "0")
        .env("VIMSTORM_APPS_DIR", root.join("apps"))
        .env("VIMSTORM_BIN_DIR", root.join("bin"))
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

/// The warm-up runs on every install, not only while the plugins are missing, so a re-run retries
/// what an earlier one left out; one that fails ends the install with exit 1 and says so,
/// never `Done`, after the app and the commands are in place.
#[test]
fn install_sh_runs_the_warm_up_again_and_fails_when_it_fails() {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let copy = install_fixture(&root, true);
    // an earlier run's plugins: the old install skipped the warm-up from then on
    std::fs::create_dir_all(root.join("data/vimstorm/lazy")).unwrap();
    let runs = root.join("warmups.log");
    let warmup = script(
        &copy.join("app/scripts"),
        "warmup.sh",
        &format!(
            "echo ran >>'{}'\necho 'language servers: missing vtsls'\n[ -f '{}' ]",
            runs.display(),
            root.join("network-back").display()
        ),
    );
    assert!(warmup.exists());

    let failed = install_warming(&copy, &root);
    let said = String::from_utf8_lossy(&failed.stdout);
    let err = String::from_utf8_lossy(&failed.stderr);
    assert_eq!(failed.status.code(), Some(1), "{said}{err}");
    assert!(said.contains("language servers: missing vtsls"), "{said}");
    assert!(!said.contains("Done"), "{said}");
    assert!(err.contains("run ./install.sh again to retry"), "{err}");
    assert!(
        root.join("bin/vimstorm").exists(),
        "the commands are in place"
    );

    std::fs::write(root.join("network-back"), "").unwrap();
    let again = install_warming(&copy, &root);
    let said = String::from_utf8_lossy(&again.stdout);
    assert!(again.status.success(), "{said}");
    assert!(said.contains("Done"), "{said}");
    assert_eq!(std::fs::read_to_string(&runs).unwrap(), "ran\nran\n");
}

/// warmup.sh runs the app's nvim headless on the checkout's config through a config link of its
/// own (gone after), never the installed app's `~/Library/Application Support/VimStorm/config`
/// link, hands it the checkout's lazy-lock.json and puts that file back when lazy rewrote it, and
/// exits as nvim does. A fake `nvim` records what it was given and rewrites the lock.
#[test]
fn warmup_sh_leaves_the_installed_apps_config_link_and_the_lockfile_alone_and_exits_as_nvim() {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let checkout = root.join("repo");
    std::fs::create_dir_all(checkout.join("nvim")).unwrap();
    let lock = "{\n  \"lazy.nvim\": { \"branch\": \"main\", \"commit\": \"306a055\" }\n}\n";
    std::fs::write(checkout.join("nvim/lazy-lock.json"), lock).unwrap();
    let seen = root.join("seen.txt");
    let fake = root.join("fake");
    script(
        &fake,
        "nvim",
        &format!(
            "{{ echo \"app=$NVIM_APPNAME\"; echo \"cfg=$XDG_CONFIG_HOME\"; \
             echo \"link=$(readlink \"$XDG_CONFIG_HOME/vimstorm\")\"; \
             echo \"kept=$(cat \"$VIMSTORM_WARMUP_LOCK\")\"; echo \"args=$*\"; }} >'{}'\n\
             echo '{{}}' >\"$XDG_CONFIG_HOME/vimstorm/lazy-lock.json\"\n\
             exit \"${{NVIM_EXIT:-0}}\"",
            seen.display()
        ),
    );
    let run = |exit: &str| {
        Command::new(repo().join("app/scripts/warmup.sh"))
            .env("HOME", root.join("home"))
            .env("TMPDIR", &root)
            .env("VIMSTORM_REPO", &checkout)
            .env("PATH", format!("{}:/usr/bin:/bin", fake.display()))
            .env("NVIM_EXIT", exit)
            .stdin(Stdio::null())
            .output()
            .unwrap()
    };

    let ok = run("0");
    assert!(
        ok.status.success(),
        "{}",
        String::from_utf8_lossy(&ok.stderr)
    );
    let seen_text = std::fs::read_to_string(&seen).unwrap();
    assert!(seen_text.contains("app=vimstorm\n"), "{seen_text}");
    assert!(
        seen_text.contains(&format!("link={}\n", checkout.join("nvim").display())),
        "{seen_text}"
    );
    assert!(seen_text.contains("kept={\n  \"lazy.nvim\""), "{seen_text}");
    assert!(
        seen_text.contains(
            "--headless --cmd let g:vimstorm_app = 1 -c lua require('config.warmup').run()"
        ),
        "{seen_text}"
    );
    assert_eq!(
        std::fs::read_to_string(checkout.join("nvim/lazy-lock.json")).unwrap(),
        lock,
        "the checkout's lock is put back"
    );
    let cfg = seen_text
        .lines()
        .find_map(|l| l.strip_prefix("cfg="))
        .unwrap()
        .to_string();
    assert!(cfg.starts_with(&root.display().to_string()), "{cfg}");
    assert!(
        !Path::new(&cfg).exists(),
        "its config link goes with it: {cfg}"
    );
    assert!(
        !root.join("home/Library").exists(),
        "the installed app's config link is not touched"
    );

    assert_eq!(run("1").status.code(), Some(1));
    assert_eq!(
        std::fs::read_to_string(checkout.join("nvim/lazy-lock.json")).unwrap(),
        lock
    );
}

/// The warm-up's Mason step (`nvim/lua/config/warmup.lua`) headless, as warmup.sh runs it, on a
/// fake registry: only the packages whose command is missing are installed, each said as
/// it starts and ends, one not in the registry or failing named after as missing; again with
/// everything there, nothing is asked.
#[test]
fn the_warm_up_installs_the_missing_mason_packages_headless_and_names_what_failed() {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let out = root.join("out.json");
    let lua = root.join("t.lua");
    std::fs::write(
        &lua,
        format!(
            r#"package.path = "{repo}/nvim/lua/?.lua;" .. package.path
local W = require("config.warmup")
local bin = "{root}/bin/"
vim.fn.mkdir(bin, "p")
io.open(bin .. "vtsls", "w"):close()
local installs = {{}}
local function pkg(name)
  local p = {{ name = name, busy = false }}
  function p:is_installed() return false end
  function p:is_installing() return self.busy end
  function p:install(_, cb)
    installs[#installs + 1] = name
    self.busy = true
    vim.defer_fn(function()
      if name == "good" then io.open(bin .. "good-bin", "w"):close() end
      self.busy = false
      cb(name == "good", name == "good" and {{}} or "npm failed\n")
    end, 60)
  end
  return p
end
local refreshes = 0
local registry = {{
  refresh = function(cb) refreshes = refreshes + 1; cb(true, {{}}) end,
  get_package = function(n) if n == "gone" then error("no package " .. n) end return pkg(n) end,
}}
local packages = {{
  {{ package = "vtsls", bin = "vtsls" }}, {{ package = "good", bin = "good-bin" }},
  {{ package = "bad", bin = "bad-bin" }}, {{ package = "gone", bin = "gone-bin" }},
}}
local lines = {{}}
local function say(l) lines[#lines + 1] = l end
local left = W.mason({{ packages = packages, registry = registry, bin = bin, say = say, every = 20 }})
local first = {{ left = left, lines = lines, installs = installs, refreshes = refreshes }}
packages[3], packages[4] = nil, nil
lines = {{}}
local again = W.mason({{ packages = packages, registry = registry, bin = bin, say = say }})
local f = io.open("{out}", "w")
f:write(vim.json.encode({{ first = first, again = {{ left = again, lines = lines, refreshes = refreshes }} }}))
f:close()
vim.cmd("qa!")
"#,
            repo = repo().display(),
            root = root.display(),
            out = out.display(),
        ),
    )
    .unwrap();
    let ran = Command::new("nvim")
        .args(["--headless", "-u", "NONE", "-i", "NONE", "-n", "-c"])
        .arg(format!("luafile {}", lua.display()))
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        ran.status.success(),
        "{}",
        String::from_utf8_lossy(&ran.stderr)
    );
    let got: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
    let strs = |v: &serde_json::Value| -> Vec<String> {
        v.as_array()
            .map(|a| a.iter().map(|x| x.as_str().unwrap().to_string()).collect())
            .unwrap_or_default()
    };
    let first = &got["first"];
    let lines = strs(&first["lines"]);
    assert_eq!(strs(&first["left"]), ["bad", "gone"], "{lines:?}");
    assert_eq!(strs(&first["installs"]), ["good", "bad"], "{lines:?}");
    for line in [
        "language servers: refreshing Mason's registry (network)",
        "  installing good (1 of 3)",
        "  installing bad (2 of 3)",
        "  gone: not in Mason's registry",
        "  good installed",
        "  bad failed: npm failed",
        "language servers: missing bad, gone",
    ] {
        assert!(lines.iter().any(|l| l == line), "{line}: {lines:?}");
    }
    assert!(
        lines.iter().any(|l| l.starts_with("  still installing: ")),
        "a long install says what it waits on: {lines:?}"
    );
    let again = &got["again"];
    assert_eq!(strs(&again["left"]), Vec::<String>::new());
    assert_eq!(strs(&again["lines"]), ["language servers: all 2 installed"]);
    assert_eq!(
        again["refreshes"], 1,
        "nothing missing: the registry is not asked"
    );
}

/// A warm-up that throws (an offline first start: no lazy.nvim to require) still exits, with 1 and
/// the error, never a headless nvim left up forever.
#[test]
fn a_warm_up_that_throws_exits_1() {
    let mut child = Command::new("nvim")
        .args(["--headless", "-u", "NONE", "-i", "NONE", "-n", "--cmd"])
        .arg(format!(
            "lua package.path = '{}/nvim/lua/?.lua;' .. package.path",
            repo().display()
        ))
        .args(["-c", "lua require('config.warmup').run()"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if std::time::Instant::now() > deadline {
            child.kill().unwrap();
            panic!("the warm-up hung after its error");
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    };
    let mut err = String::new();
    std::io::Read::read_to_string(&mut child.stderr.take().unwrap(), &mut err).unwrap();
    assert_eq!(status.code(), Some(1), "{err}");
    assert!(err.contains("warm-up failed: "), "{err}");
}

// ---- bundle.sh -----------------------------------------------------------------------------------

fn plist(app: &Path, key: &str) -> Option<String> {
    let out = Command::new("plutil")
        .args(["-extract", key, "raw", "-o", "-"])
        .arg(app.join("Contents/Info.plist"))
        .output()
        .unwrap();
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

fn ok(out: Output, what: &str) -> String {
    assert!(
        out.status.success(),
        "{what}: {}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// bundle.sh on a temp `HOME`, this build's binary and a stand-in Abe 3.x (`abe`).
fn bundle_sh(home: &Path, abe: &Path) -> Command {
    let mut c = Command::new(Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/bundle.sh"));
    c.env("HOME", home)
        .env("VIMSTORM_BUNDLE_BINARY", env!("CARGO_BIN_EXE_vimstorm"))
        .env("VIMSTORM_BUNDLE_ABE", abe);
    c
}

#[test]
fn the_bundle_carries_abe_beside_the_binary_and_is_signed() {
    let dir = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(dir.path()).unwrap();
    let home = base.join("h");
    std::fs::create_dir_all(&home).unwrap();
    let abe = base.join("abe-darwin-arm64");
    std::fs::write(&abe, "#!/bin/sh\necho \"abe 2: $*\"\n").unwrap();
    std::fs::set_permissions(&abe, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let out = base.join("out");

    let app = PathBuf::from(
        ok(
            bundle_sh(&home, &abe)
                .arg("--out")
                .arg(&out)
                .output()
                .unwrap(),
            "bundle.sh",
        )
        .trim(),
    );
    assert_eq!(app, out.join("VimStorm.app"));
    assert_eq!(plist(&app, "CFBundleName").as_deref(), Some("VimStorm"));
    assert_eq!(
        plist(&app, "CFBundleIdentifier").as_deref(),
        Some("se.mkdir.vimstorm")
    );
    assert_eq!(
        plist(&app, "LSEnvironment.VIMSTORM_REPO"),
        Some(repo().display().to_string())
    );
    // Abe 3.x beside the binary, where the bridge looks, signed with the bundle
    let two = app.join("Contents/MacOS/abe");
    assert_eq!(std::fs::read(&two).unwrap(), std::fs::read(&abe).unwrap());
    let said = Command::new(&two).arg("help").output().unwrap();
    assert_eq!(String::from_utf8_lossy(&said.stdout), "abe 2: help\n");
    ok(
        Command::new("codesign")
            .args(["--verify", "--deep", "--strict"])
            .arg(&app)
            .output()
            .unwrap(),
        "codesign --verify",
    );
    // the demo app `abe demo new` copies, where Abe looks beside itself, sealed in the signature
    let demo = app.join("Contents/Resources/demo-shop");
    assert!(demo.join("board/seed.json").is_file(), "{}", demo.display());
    assert!(demo.join("api/src/app.ts").is_file(), "{}", demo.display());
    assert!(!demo.join("node_modules").exists());
    // the 1.0 Preview is gone: no such flag
    let preview = bundle_sh(&home, &abe)
        .args(["--preview", "--out"])
        .arg(base.join("pv"))
        .output()
        .unwrap();
    assert_eq!(preview.status.code(), Some(2));

    // without one to bundle, Abe 3.x is built with bun: none on PATH stops the bundle
    let no_bun = bundle_sh(&home, &abe)
        .env_remove("VIMSTORM_BUNDLE_ABE")
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .arg("--out")
        .arg(base.join("no-bun"))
        .output()
        .unwrap();
    assert_eq!(no_bun.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&no_bun.stderr).contains("bun not found"),
        "{}",
        String::from_utf8_lossy(&no_bun.stderr)
    );
}
