//! Starting the app's embedded nvim.
//!
//! `NVIM_APPNAME=vimstorm` + `XDG_CONFIG_HOME=<Application Support>/VimStorm/config`, where
//! `config/vimstorm` links to the repo's `nvim/` dir: the app gets its own plugin / state dirs
//! (`~/.local/share/vimstorm`, ...) and never shares lazy / Mason / session state with the user's
//! terminal nvim. First start installs plugins (network); `scripts/warmup.sh` does that up front.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};

use anyhow::{Context as _, Result, bail};

/// How to start nvim.
#[derive(Clone, Debug)]
pub struct NvimConfig {
    /// Repo root (holds `nvim/`).
    pub repo: PathBuf,
    /// Project dir: nvim's cwd.
    pub project: PathBuf,
    /// Extra nvim arguments (files to open, ...).
    pub args: Vec<String>,
    /// Extra / overriding env vars (tests: `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`).
    pub env: HashMap<String, String>,
    /// Dir holding `vimstorm -> <repo>/nvim`; used as `XDG_CONFIG_HOME`.
    pub config_home: PathBuf,
    /// nvim binary.
    pub nvim: PathBuf,
    /// A cloud workspace's Neovim ([`crate::shell::remote`]): this argv starts it, embedded on
    /// stdio, in place of `nvim --embed`; the app's `--cmd` and files follow it.
    pub launch: Option<Vec<String>>,
}

impl NvimConfig {
    /// Defaults for `project`: repo from [`find_repo`], config home in Application Support.
    pub fn new(project: impl Into<PathBuf>) -> Result<Self> {
        Ok(Self {
            repo: find_repo()?,
            project: project.into(),
            args: Vec::new(),
            env: Default::default(),
            config_home: default_config_home()?,
            nvim: PathBuf::from("nvim"),
            launch: None,
        })
    }
}

/// Config links are separate from plugin/data state. Preview launches must never repoint
/// the installed editor's `vimstorm` link to another checkout.
pub fn default_config_home() -> Result<PathBuf> {
    if let Some(config) = std::env::var_os("VIMSTORM_CONFIG_HOME").filter(|p| !p.is_empty()) {
        return Ok(PathBuf::from(config));
    }
    let home = std::env::var_os("HOME").context("HOME not set")?;
    Ok(PathBuf::from(home).join("Library/Application Support/VimStorm/config"))
}

/// The repo with the Lua config: `$VIMSTORM_REPO`, else an ancestor of the binary that has
/// `nvim/init.lua` (dev builds live in `<repo>/app/target/...`), else `CARGO_MANIFEST_DIR/..`.
pub fn find_repo() -> Result<PathBuf> {
    let is_repo = |p: &Path| p.join("nvim/init.lua").is_file();
    if let Some(r) = std::env::var_os("VIMSTORM_REPO") {
        let r = PathBuf::from(r);
        if is_repo(&r) {
            return Ok(r);
        }
        bail!("VIMSTORM_REPO={} has no nvim/init.lua", r.display());
    }
    if let Ok(exe) = std::env::current_exe() {
        let exe = crate::shell::real_path(&exe);
        if let Some(r) = exe.ancestors().find(|p| is_repo(p)) {
            return Ok(r.to_path_buf());
        }
    }
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    if let Some(r) = manifest.parent().filter(|p| is_repo(p)) {
        return Ok(r.to_path_buf());
    }
    bail!("can't find the VimStorm repo (set VIMSTORM_REPO)")
}

/// Creates `config_home` and points `config_home/vimstorm` at `<repo>/nvim` (idempotent: an
/// existing correct link is left alone, a stale one replaced).
pub fn ensure_config_link(config_home: &Path, repo: &Path) -> Result<()> {
    std::fs::create_dir_all(config_home)
        .with_context(|| format!("creating {}", config_home.display()))?;
    let link = config_home.join("vimstorm");
    let target = repo.join("nvim");
    if let Ok(cur) = std::fs::read_link(&link) {
        if cur == target {
            return Ok(());
        }
        match std::fs::remove_file(&link) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
    } else if link.exists() {
        bail!("{} exists and is not a symlink", link.display());
    }
    match std::os::unix::fs::symlink(&target, &link) {
        // another process (parallel tests) linked it first
        Err(e)
            if e.kind() == std::io::ErrorKind::AlreadyExists
                && std::fs::read_link(&link).is_ok_and(|cur| cur == target) =>
        {
            Ok(())
        }
        r => r.with_context(|| format!("linking {} -> {}", link.display(), target.display())),
    }
}

/// The spawned process with its pipes taken out (the RPC layer owns them).
pub struct NvimProcess {
    pub child: Child,
    pub stdin: ChildStdin,
    pub stdout: ChildStdout,
    /// A cloud workspace's stderr (what its attach said when it ended); a local nvim's goes
    /// to the app's own.
    pub stderr: Option<ChildStderr>,
}

/// The command [`spawn`] runs, its stdio not set yet.
fn command(cfg: &NvimConfig) -> Command {
    let launch = cfg
        .launch
        .as_deref()
        .and_then(crate::shell::remote::command);
    let local = launch.is_none();
    let mut cmd = launch.unwrap_or_else(|| {
        let mut cmd = Command::new(&cfg.nvim);
        cmd.arg("--embed");
        cmd
    });
    cmd.arg("--cmd")
        // No intro screen: it would flash under the session restore / empty-editor hints.
        .arg("let g:vimstorm_app = 1 | set shortmess+=I")
        .args(&cfg.args);
    // A cloud workspace's launch (`abe box attach … -- docker exec … nvim --embed`) runs on this
    // Mac as the person, its Neovim's own variables the box's (`docker exec -e`; nothing here
    // reaches it over ssh): this XDG_CONFIG_HOME sent the attach's `gh` to a folder with no
    // login, so only a local Neovim gets them.
    if local {
        cmd.env("NVIM_APPNAME", "vimstorm")
            .env("XDG_CONFIG_HOME", &cfg.config_home)
            // the `abe` Lua runs for a Layer's file (config/workflow.lua): the one the bridge runs
            .env(
                "VIMSTORM_ABE",
                crate::factory::BridgeCommand::from_env().program,
            );
        // The user's own XDG_CONFIG_HOME, for config/app.lua to restore for plugins / child processes.
        if let Some(user) = std::env::var_os("XDG_CONFIG_HOME") {
            cmd.env("VIMSTORM_USER_XDG_CONFIG_HOME", user);
        }
    }
    // a box's folder is no folder here: its launch says where it runs
    if cfg.launch.is_none() || cfg.project.is_dir() {
        cmd.current_dir(&cfg.project);
    }
    // `env` goes to both: a test's stand-in box runs this Mac's nvim with it (its config vars too)
    cmd.envs(&cfg.env);
    cmd
}

/// Spawns `nvim --embed` per contract 1 (a cloud workspace's: its [`NvimConfig::launch`]).
pub fn spawn(cfg: &NvimConfig) -> Result<NvimProcess> {
    ensure_config_link(&cfg.config_home, &cfg.repo)?;
    let mut cmd = command(cfg);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(if cfg.launch.is_some() {
            Stdio::piped()
        } else {
            Stdio::inherit()
        });
    let mut child = cmd.spawn().with_context(|| match &cfg.launch {
        Some(argv) => format!("spawning {}", argv.join(" ")),
        None => format!("spawning {}", cfg.nvim.display()),
    })?;
    let stdin = child.stdin.take().context("nvim stdin")?;
    let stdout = child.stdout.take().context("nvim stdout")?;
    let stderr = child.stderr.take();
    Ok(NvimProcess {
        child,
        stdin,
        stdout,
        stderr,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_link_is_idempotent_and_replaces_stale_links() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("cfg");
        let repo_a = dir.path().join("a");
        let repo_b = dir.path().join("b");
        ensure_config_link(&home, &repo_a).unwrap();
        ensure_config_link(&home, &repo_a).unwrap();
        assert_eq!(
            std::fs::read_link(home.join("vimstorm")).unwrap(),
            repo_a.join("nvim")
        );
        ensure_config_link(&home, &repo_b).unwrap();
        assert_eq!(
            std::fs::read_link(home.join("vimstorm")).unwrap(),
            repo_b.join("nvim")
        );
    }

    fn envs(cmd: &Command) -> HashMap<String, Option<String>> {
        cmd.get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.map(|v| v.to_string_lossy().into_owned()),
                )
            })
            .collect()
    }

    /// A cloud workspace's launch (`abe box attach … -- docker exec … nvim --embed`) runs
    /// on this Mac as the person: the app's XDG_CONFIG_HOME, which only points a local Neovim at
    /// VimStorm's config, sent `gh` there to a folder with no login.
    #[test]
    fn a_cloud_launch_runs_as_the_person_with_none_of_the_local_nvims_config_vars() {
        let mut cfg = NvimConfig {
            repo: PathBuf::from("/repo"),
            project: PathBuf::from("/workspace/repo"),
            args: Vec::new(),
            env: HashMap::from([("VIMSTORM_FEEL".to_owned(), "webstorm".to_owned())]),
            config_home: PathBuf::from("/app/config"),
            nvim: PathBuf::from("nvim"),
            launch: None,
        };
        let local = envs(&command(&cfg));
        assert_eq!(local["XDG_CONFIG_HOME"].as_deref(), Some("/app/config"));
        assert_eq!(local["NVIM_APPNAME"].as_deref(), Some("vimstorm"));

        cfg.launch = Some(
            [
                "abe", "box", "attach", "shop-4", "--", "docker", "exec", "-i", "nvim", "--embed",
            ]
            .map(str::to_owned)
            .to_vec(),
        );
        let cloud = command(&cfg);
        assert_eq!(cloud.get_program(), "abe");
        let cloud = envs(&cloud);
        for var in [
            "XDG_CONFIG_HOME",
            "NVIM_APPNAME",
            "VIMSTORM_USER_XDG_CONFIG_HOME",
            "VIMSTORM_ABE",
        ] {
            assert!(
                !cloud.contains_key(var),
                "{var} set on the launch: {cloud:?}"
            );
        }
        assert_eq!(cloud["VIMSTORM_FEEL"].as_deref(), Some("webstorm"));
    }

    #[test]
    fn finds_the_repo_from_the_manifest_dir() {
        let r = find_repo().unwrap();
        assert!(r.join("nvim/init.lua").is_file());
    }
}
