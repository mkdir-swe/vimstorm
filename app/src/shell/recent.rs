//! Recent projects: what the toolbar's Recent Projects… popup and the Recent Projects picker list.
//!
//! Native list (`config/webstorm.lua` only sends `Snacks.picker.projects()` here; rules from
//! snacks' `projects` source): the projects opened recently first (here: the app's saved sessions in
//! `<state>/vimstorm/open-files/`, newest first; snacks takes the git roots of `v:oldfiles`, which
//! the sessions stand in for), then every project under `~/projects` (a dir with `.git`,
//! `package.json`, `Makefile`, ... at most two levels down, like its `fd --max-depth 2`), by name.
//!
//! The project icon is WebStorm's: initials ([`initials`], `AvatarUtils.initials`) on a gradient
//! from its 9-color palette ([`color_index`]: the index WebStorm stored for the project in its
//! `recentProjects.xml`, else a hash of the path like `ProjectIconPalette`).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// One recent project.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecentProject {
    pub path: PathBuf,
    /// The dir's name.
    pub name: String,
    /// When its session was last saved (None: found under `~/projects`, never opened in the app).
    pub opened: Option<SystemTime>,
    /// Its checked-out branch (`.git/HEAD`), None outside git / detached.
    pub branch: Option<String>,
    /// Icon color: index into WebStorm's project palette (0..[`PALETTE_LEN`]).
    pub color: usize,
    /// Open in the window ([`crate::shell::projects`]): listed first, name in bold.
    pub open: bool,
}

impl RecentProject {
    /// `path` as a list row (the name, its branch and color read now: the disk, quick).
    pub fn of(path: PathBuf) -> Self {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string());
        RecentProject {
            branch: branch_of(&path),
            name,
            opened: None,
            color: color_index(&path),
            open: false,
            path,
        }
    }
}

/// The open projects (`open`, shown one first) on top of `items`, marked open; the rest keep
/// their order. An open project missing from `items` is added (its row read from disk).
pub fn open_first(items: Vec<RecentProject>, open: &[PathBuf]) -> Vec<RecentProject> {
    let (mut top, rest): (Vec<_>, Vec<_>) = items.into_iter().partition(|p| open.contains(&p.path));
    let mut out: Vec<RecentProject> = open
        .iter()
        .map(|dir| match top.iter().position(|p| p.path == *dir) {
            Some(i) => top.swap_remove(i),
            None => RecentProject::of(dir.clone()),
        })
        .map(|p| RecentProject { open: true, ..p })
        .collect();
    out.extend(rest);
    out
}

/// Files / dirs that make a dir a project (snacks' `projects.patterns`).
const PATTERNS: &[&str] = &[
    ".git",
    "_darcs",
    ".hg",
    ".bzr",
    ".svn",
    "package.json",
    "Makefile",
    // a WebStorm project
    ".idea",
];

/// Number of project icon colors (`RecentProjectColorPalette.COLOR_COUNT`).
pub const PALETTE_LEN: usize = 9;

/// Recent projects, most recent first (see the module doc). Reads the disk: off the UI thread
/// when it can wait (a few ms for `~/projects` with dozens of dirs).
pub fn recent() -> Vec<RecentProject> {
    recent_with(None)
}

/// The recent projects with the open ones on top (shown one first, then by use; `current` when
/// there's no projects window), read off the UI thread: the toolbar's projects popup and the
/// Recent Projects picker. The sessions are the app's nvim's (tests give theirs a state dir).
pub fn recent_open_first(
    current: PathBuf,
    cx: &gpui_kit::App,
) -> gpui_kit::Task<Vec<RecentProject>> {
    let state_home = crate::shell::projects::state_home(cx);
    let mut open = crate::shell::projects::open_dirs_by_use(cx);
    if open.is_empty() {
        open.push(current);
    }
    cx.background_executor()
        .spawn(async move { open_first(recent_with(state_home.as_deref()), &open) })
}

/// [`recent`] with the sessions of the nvim whose `XDG_STATE_HOME` is `state_home` (None: this
/// process's; tests give their nvim its own).
pub fn recent_with(state_home: Option<&Path>) -> Vec<RecentProject> {
    let mut list = found_with(state_home);
    // removed from the list (Welcome's Remove from list): never found again under `~/projects`;
    // opened again, its session brings it back
    drop_forgotten(&mut list, &forgotten(state_home));
    list
}

/// The projects removed from the list leave it, but the ones opened since (a session saved).
fn drop_forgotten(list: &mut Vec<RecentProject>, forgotten: &HashSet<PathBuf>) {
    list.retain(|p| p.opened.is_some() || !forgotten.contains(&p.path));
}

fn found_with(state_home: Option<&Path>) -> Vec<RecentProject> {
    // Preview/test discovery is explicit and never reads the user's IDE history or folders.
    if let Some(roots) = std::env::var_os("VIMSTORM_PROJECTS_DIR") {
        let roots = std::env::split_paths(&roots).collect::<Vec<_>>();
        return recent_from(
            &state_dir(state_home).join("open-files"),
            &roots,
            &HashMap::new(),
        );
    }
    if std::env::var_os("VIMSTORM_SHOT").is_some() {
        return recent_from(
            &state_dir(state_home).join("open-files"),
            &[],
            &HashMap::new(),
        );
    }
    let home = home();
    let ws_colors = webstorm_colors(&home);
    let sessions = state_dir(state_home).join("open-files");
    recent_from(&sessions, &[home.join("projects")], &ws_colors)
}

/// The file the projects removed from the list are kept in (a JSON list of paths).
fn forgotten_file(state_home: Option<&Path>) -> PathBuf {
    state_dir(state_home).join("forgotten-projects.json")
}

fn forgotten(state_home: Option<&Path>) -> HashSet<PathBuf> {
    std::fs::read_to_string(forgotten_file(state_home))
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<PathBuf>>(&t).ok())
        .unwrap_or_default()
        .into_iter()
        .collect()
}

/// Welcome's Remove from list (WebStorm's Remove from Recent Projects): its session file
/// goes (a gone folder's row with it) and a folder under `~/projects` is not listed again until
/// it is opened.
pub fn forget(state_home: Option<&Path>, project: &Path) {
    // the list's own spelling (`/private/var`, not `/var`); a gone folder as it was
    let real = project.canonicalize();
    let project = real.as_deref().unwrap_or(project);
    let dir = state_dir(state_home);
    let _ = std::fs::remove_file(dir.join("open-files").join(session_name(project)));
    let mut all: Vec<PathBuf> = forgotten(state_home).into_iter().collect();
    if all.iter().any(|p| p == project) {
        return;
    }
    all.push(project.to_path_buf());
    all.sort();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(text) = serde_json::to_string(&all) {
        let _ = std::fs::write(forgotten_file(state_home), text);
    }
}

/// A repo moved on this Mac (Abe followed it): its session file goes with it, so the list names
/// the new folder and not the gone one; a session the new folder has already stays.
pub fn moved(state_home: Option<&Path>, from: &Path, to: &Path) {
    let sessions = state_dir(state_home).join("open-files");
    let (was, now) = (
        sessions.join(session_name(from)),
        sessions.join(session_name(to)),
    );
    if !was.exists() {
        return;
    }
    if now.exists() {
        let _ = std::fs::remove_file(&was);
    } else {
        let _ = std::fs::rename(&was, &now);
    }
}

/// The projects whose session is kept but whose folder is gone, newest first: Welcome's dim rows.
pub fn gone_with(state_home: Option<&Path>) -> Vec<PathBuf> {
    let home = home();
    let mut gone: Vec<(PathBuf, SystemTime)> =
        std::fs::read_dir(state_dir(state_home).join("open-files"))
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| {
                let dir = session_project(&e.file_name().to_string_lossy())?;
                let mtime = e.metadata().ok()?.modified().ok()?;
                // an unmounted drive or a whole tree gone (a temp dir) is not a gone project
                let gone = !dir.exists()
                    && dir.parent().is_some_and(Path::exists)
                    && !dir.starts_with("/Volumes")
                    && !not_a_project_root(&dir, &home);
                gone.then_some((dir, mtime))
            })
            .collect();
    gone.sort_by_key(|g| std::cmp::Reverse(g.1));
    gone.into_iter().map(|g| g.0).collect()
}

/// [`recent`] from explicit sources (tests).
pub fn recent_from(
    sessions: &Path,
    dev: &[PathBuf],
    ws_colors: &HashMap<PathBuf, usize>,
) -> Vec<RecentProject> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let home = home();
    let mut add = |path: PathBuf, opened: Option<SystemTime>| {
        // a session for the home dir, /tmp or a plain folder (nvim started there) isn't a project
        if !is_project(&path) || not_a_project_root(&path, &home) || !seen.insert(path.clone()) {
            return;
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string());
        let color = ws_colors
            .get(&path)
            .copied()
            .unwrap_or_else(|| color_index(&path));
        out.push(RecentProject {
            branch: branch_of(&path),
            name,
            opened,
            color,
            open: false,
            path,
        });
    };

    let mut sessions: Vec<(PathBuf, SystemTime)> = std::fs::read_dir(sessions)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let file = e.file_name().to_string_lossy().into_owned();
            let dir = session_project(&file)?;
            let mtime = e.metadata().ok()?.modified().ok()?;
            Some((dir, mtime))
        })
        .collect();
    sessions.sort_by_key(|s| std::cmp::Reverse(s.1));
    for (dir, mtime) in sessions {
        add(dir, Some(mtime));
    }

    for root in dev {
        let mut found: Vec<PathBuf> = Vec::new();
        if is_project(root) {
            found.push(root.clone());
        }
        let children = std::fs::read_dir(root).into_iter().flatten().flatten();
        found.extend(
            children
                .map(|e| e.path())
                .filter(|p| p.is_dir() && is_project(p)),
        );
        found.sort_by_key(|p| p.file_name().map(|n| n.to_ascii_lowercase()));
        for p in found {
            add(p, None);
        }
    }
    out
}

/// The project dir a session file is for: `config/session.lua` names it after the cwd with `/`
/// (and `\`, `:`) replaced by `%`.
pub fn session_project(file: &str) -> Option<PathBuf> {
    let stem = file.strip_suffix(".json")?;
    stem.starts_with('%')
        .then(|| PathBuf::from(stem.replace('%', "/")))
}

/// `config/session.lua`'s file for a project dir (inverse of [`session_project`]).
#[cfg(test)]
pub fn session_file(project: &Path) -> PathBuf {
    sessions_dir().join(session_name(project))
}

fn session_name(project: &Path) -> String {
    let name = project.to_string_lossy().replace(['/', '\\', ':'], "%");
    format!("{name}.json")
}

/// The app nvim's session dir: `$XDG_STATE_HOME/vimstorm/open-files` (default
/// `~/.local/state`).
#[cfg(test)]
pub fn sessions_dir() -> PathBuf {
    state_dir(None).join("open-files")
}

/// The app's state dir `<state>/vimstorm` (sessions, the open projects set): `state_home` is the
/// app nvim's `XDG_STATE_HOME` (None: this process's, default `~/.local/state`).
pub fn state_dir(state_home: Option<&Path>) -> PathBuf {
    let state = state_home.map(Path::to_path_buf).unwrap_or_else(|| {
        std::env::var_os("XDG_STATE_HOME")
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join(".local/state"))
    });
    state.join("vimstorm")
}

/// `dir` with symlinks resolved (as given when it can't be: gone). Open projects are keyed by it
/// (one nvim per folder, whatever path opened it). Stats every component: not per frame.
pub fn real_path(dir: &Path) -> PathBuf {
    std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf())
}

/// The home dir (empty when `HOME` is unset).
pub fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
}

/// Dirs never listed even with a project marker in them.
/// Home, `/` or /tmp: never a project (a dotfiles repo in home is not one either).
pub fn not_a_project_root(dir: &Path, home: &Path) -> bool {
    dir == home
        || dir == Path::new("/")
        || ["/tmp", "/private/tmp"].iter().any(|t| dir == Path::new(t))
}

fn is_project(dir: &Path) -> bool {
    PATTERNS.iter().any(|p| dir.join(p).exists())
}

/// The branch checked out in `dir`'s repo (reads `.git/HEAD`, following a worktree's `.git`
/// file); None outside a repo or on a detached HEAD.
pub fn branch_of(dir: &Path) -> Option<String> {
    let dot_git = dir.join(".git");
    let git_dir = if dot_git.is_file() {
        let text = std::fs::read_to_string(&dot_git).ok()?;
        let rel = text.trim().strip_prefix("gitdir:")?.trim().to_owned();
        dir.join(rel)
    } else {
        dot_git
    };
    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    head.trim()
        .strip_prefix("ref: refs/heads/")
        .map(str::to_owned)
}

/// `~/x` for paths under the home dir.
pub fn display_path(path: &Path) -> String {
    let home = home();
    match path.strip_prefix(&home) {
        Ok(rest) if !home.as_os_str().is_empty() => format!("~/{}", rest.display()),
        _ => path.display().to_string(),
    }
}

/// Two-letter project initials, WebStorm's `AvatarUtils.initials`: "MyProject" -> "MP",
/// "app-demo-checkout" -> "AC" (first and last word), "vimstorm" -> "V".
pub fn initials(name: &str) -> String {
    let camel = camel_initials(name);
    if camel.chars().count() == 2 {
        return camel;
    }
    let filtered = name.trim();
    let words = [' ', ',', '-', '_', '.']
        .iter()
        .find_map(|&d| split_words(filtered, &[d]))
        .or_else(|| split_words(filtered, &['`', '\'', '"']));
    match words {
        Some(w) => {
            let first = w.first().and_then(|s| s.chars().next());
            let last = w.last().and_then(|s| s.chars().next());
            first
                .into_iter()
                .chain(last)
                .collect::<String>()
                .to_uppercase()
        }
        None => camel,
    }
}

/// Up to two initials from a camelCase name: its first letter and the next capitals.
fn camel_initials(text: &str) -> String {
    text.chars()
        .skip_while(|c| !c.is_alphabetic())
        .take_while(|c| c.is_alphanumeric())
        .enumerate()
        .filter(|(i, c)| *i == 0 || c.is_uppercase())
        .map(|(_, c)| c)
        .take(2)
        .collect::<String>()
        .to_uppercase()
}

/// The words (alphanumerics only) between delimiters, when there are at least two.
fn split_words(text: &str, delims: &[char]) -> Option<Vec<String>> {
    let words: Vec<String> = text
        .split(delims)
        .map(|w| {
            w.chars()
                .filter(|c| c.is_alphanumeric())
                .collect::<String>()
        })
        .filter(|w| !w.is_empty())
        .collect();
    (words.len() >= 2).then_some(words)
}

/// Palette index for a project WebStorm doesn't know: Java's `String.hashCode` of the path,
/// `abs(hash % 9)` (`ColorPalette.select`).
pub fn color_index(path: &Path) -> usize {
    let hash = path
        .to_string_lossy()
        .encode_utf16()
        .fold(0i32, |h, c| h.wrapping_mul(31).wrapping_add(c as i32));
    (hash % PALETTE_LEN as i32).unsigned_abs() as usize
}

/// The color index WebStorm stored per project (`RecentProjectColorInfo associatedIndex` in the
/// newest `~/Library/Application Support/JetBrains/WebStorm*/options/recentProjects.xml`), so a
/// project keeps the color it has there.
pub fn webstorm_colors(home: &Path) -> HashMap<PathBuf, usize> {
    let base = home.join("Library/Application Support/JetBrains");
    let newest = std::fs::read_dir(&base)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("WebStorm"))
        .max();
    newest
        .and_then(|dir| {
            std::fs::read_to_string(base.join(dir).join("options/recentProjects.xml")).ok()
        })
        .map(|xml| parse_webstorm_colors(&xml, home))
        .unwrap_or_default()
}

/// `<entry key="$USER_HOME$/x"> ... associatedIndex="N" ... </entry>` -> path -> N.
pub fn parse_webstorm_colors(xml: &str, home: &Path) -> HashMap<PathBuf, usize> {
    let mut out = HashMap::new();
    for entry in xml.split("<entry key=\"").skip(1) {
        let Some((key, rest)) = entry.split_once('"') else {
            continue;
        };
        let body = rest.split("</entry>").next().unwrap_or("");
        let Some(ix) = body
            .split_once("associatedIndex=\"")
            .and_then(|(_, r)| r.split('"').next())
            .and_then(|n| n.parse::<usize>().ok())
            .filter(|&n| n < PALETTE_LEN)
        else {
            continue;
        };
        let path = key.replace("$USER_HOME$", &home.to_string_lossy());
        out.insert(PathBuf::from(path), ix);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_projects_go_first_marked() {
        let row = |p: &str| RecentProject {
            color: 0,
            ..RecentProject::of(PathBuf::from(p))
        };
        let items = vec![row("/r/a"), row("/r/b"), row("/r/c"), row("/r/d")];
        // shown one (c) first, then the other open ones by use; one open project isn't recent
        let open = [
            PathBuf::from("/r/c"),
            PathBuf::from("/x/new"),
            PathBuf::from("/r/a"),
        ];
        let out = open_first(items, &open);
        let got: Vec<(&str, bool)> = out
            .iter()
            .map(|p| (p.path.to_str().unwrap(), p.open))
            .collect();
        assert_eq!(
            got,
            [
                ("/r/c", true),
                ("/x/new", true),
                ("/r/a", true),
                ("/r/b", false),
                ("/r/d", false)
            ]
        );
        assert_eq!(out[1].name, "new");
    }

    #[test]
    fn initials_like_webstorm() {
        assert_eq!(initials("MyProject"), "MP");
        assert_eq!(initials("My-Project"), "MP");
        assert_eq!(initials("John-Smith-Harris"), "JH");
        assert_eq!(initials("app-demo-checkout"), "AC");
        assert_eq!(initials("vimstorm-gpui"), "VG");
        assert_eq!(initials("vimstorm"), "V");
        assert_eq!(initials("grepo"), "G");
        assert_eq!(initials("my_cool.app"), "MC");
    }

    #[test]
    fn a_project_s_color_is_webstorm_s_stored_index_else_java_s_string_hash() {
        // "abc".hashCode() = 96354; 96354 % 9 = 0
        assert_eq!(color_index(Path::new("abc")), 0);
        // "b".hashCode() = 98 -> 98 % 9 = 8
        assert_eq!(color_index(Path::new("b")), 8);
        for p in [
            "/home/x/projects/a",
            "/tmp/very/long/path/that/overflows/i32",
        ] {
            assert!(color_index(Path::new(p)) < PALETTE_LEN);
        }
        // the index WebStorm stored for a project, when it has one
        let xml = r#"<map>
        <entry key="$USER_HOME$/projects/a"><value><RecentProjectMetaInfo>
          <option name="colorInfo"><RecentProjectColorInfo associatedIndex="6" /></option>
        </RecentProjectMetaInfo></value></entry>
        <entry key="$USER_HOME$/projects/b"><value><RecentProjectMetaInfo /></value></entry>
        <entry key="/abs/c"><value><RecentProjectColorInfo associatedIndex="2" /></value></entry>
        </map>"#;
        let m = parse_webstorm_colors(xml, Path::new("/home/x"));
        assert_eq!(m.get(Path::new("/home/x/projects/a")), Some(&6));
        assert_eq!(m.get(Path::new("/home/x/projects/b")), None);
        assert_eq!(m.get(Path::new("/abs/c")), Some(&2));
    }

    #[test]
    fn session_names_round_trip() {
        assert_eq!(
            session_project("%home%ada%projects%app.json"),
            Some(PathBuf::from("/home/ada/projects/app"))
        );
        assert_eq!(session_project("git-panel-tabs.json"), None);
        assert_eq!(session_project("%x.txt"), None);
        let f = session_file(Path::new("/home/ada/projects/app"));
        assert!(f.ends_with("%home%ada%projects%app.json"), "{f:?}");
    }

    #[test]
    fn a_gone_folder_is_listed_until_removed_from_the_list() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let (here, gone) = (root.join("here"), root.join("gone"));
        std::fs::create_dir_all(here.join(".git")).unwrap();
        let sessions = state_dir(Some(&root)).join("open-files");
        std::fs::create_dir_all(&sessions).unwrap();
        for dir in [&here, &gone] {
            std::fs::write(sessions.join(session_name(dir)), "{}").unwrap();
        }
        assert_eq!(gone_with(Some(&root)), vec![gone.clone()]);
        forget(Some(&root), &gone);
        forget(Some(&root), &here);
        assert!(gone_with(Some(&root)).is_empty());
        assert!(!sessions.join(session_name(&here)).exists());
        assert_eq!(
            forgotten(Some(&root)),
            HashSet::from([gone.clone(), here.clone()])
        );
    }

    #[test]
    fn a_moved_repo_is_listed_at_its_new_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let sessions = state_dir(Some(&root)).join("open-files");
        std::fs::create_dir_all(&sessions).unwrap();
        let (a, a2, b, b2) = (
            root.join("a"),
            root.join("a-moved"),
            root.join("b"),
            root.join("b-moved"),
        );
        for dir in [&a2, &b2] {
            std::fs::create_dir_all(dir.join(".git")).unwrap();
        }
        std::fs::write(sessions.join(session_name(&a)), "old").unwrap();
        std::fs::write(sessions.join(session_name(&b)), "old").unwrap();
        // opened at its new folder already: that session stays
        std::fs::write(sessions.join(session_name(&b2)), "new").unwrap();
        moved(Some(&root), &a, &a2);
        moved(Some(&root), &b, &b2);
        for (gone, now, text) in [(&a, &a2, "old"), (&b, &b2, "new")] {
            assert!(!sessions.join(session_name(gone)).exists());
            assert_eq!(
                std::fs::read_to_string(sessions.join(session_name(now))).unwrap(),
                text
            );
        }
        assert!(gone_with(Some(&root)).is_empty());
    }

    #[test]
    fn a_forgotten_project_leaves_the_list_until_opened_again() {
        let row = |path: &str, opened: Option<SystemTime>| RecentProject {
            path: PathBuf::from(path),
            name: path.trim_start_matches('/').into(),
            opened,
            branch: None,
            color: 0,
            open: false,
        };
        let mut list = vec![
            row("/p/found", None),
            row("/p/forgotten", None),
            row("/p/reopened", Some(SystemTime::UNIX_EPOCH)),
        ];
        let forgotten =
            HashSet::from([PathBuf::from("/p/forgotten"), PathBuf::from("/p/reopened")]);
        drop_forgotten(&mut list, &forgotten);
        let left: Vec<_> = list.iter().map(|p| p.path.to_str().unwrap()).collect();
        assert_eq!(left, ["/p/found", "/p/reopened"]);
    }

    #[test]
    fn sessions_newest_first_then_dev_projects_by_name() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let dev = root.join("projects");
        for (name, marker) in [
            ("zeta", ".git"),
            ("Alpha", "package.json"),
            ("plain", ""),
            ("old", "Makefile"),
        ] {
            std::fs::create_dir_all(dev.join(name)).unwrap();
            if !marker.is_empty() {
                std::fs::create_dir_all(dev.join(name).join(marker)).unwrap();
            }
        }
        std::fs::write(dev.join("zeta/.git/HEAD"), "ref: refs/heads/main\n").unwrap();
        let sessions = root.join("open-files");
        std::fs::create_dir_all(&sessions).unwrap();
        let file =
            |dir: &Path| sessions.join(format!("{}.json", dir.to_string_lossy().replace('/', "%")));
        // "old" saved first, then "zeta"; a session for a dir that's gone is skipped
        std::fs::write(file(&dev.join("old")), "{}").unwrap();
        let older = SystemTime::now() - std::time::Duration::from_secs(60);
        std::fs::File::options()
            .write(true)
            .open(file(&dev.join("old")))
            .unwrap()
            .set_modified(older)
            .unwrap();
        std::fs::write(file(&dev.join("zeta")), "{}").unwrap();
        std::fs::write(file(&root.join("gone")), "{}").unwrap();
        // nvim once started in a plain folder: not a project
        std::fs::write(file(&dev.join("plain")), "{}").unwrap();

        let mut colors = HashMap::new();
        colors.insert(dev.join("Alpha"), 4);
        let list = recent_from(&sessions, std::slice::from_ref(&dev), &colors);
        let names: Vec<&str> = list.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["zeta", "old", "Alpha"]);
        assert!(list[0].opened.is_some() && list[2].opened.is_none());
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        assert_eq!(list[2].color, 4);
        assert_eq!(list[1].color, color_index(&dev.join("old")));
    }

    #[test]
    fn branch_of_follows_worktree_git_files() {
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path().join("main/.git/worktrees/wt");
        std::fs::create_dir_all(&main).unwrap();
        std::fs::write(main.join("HEAD"), "ref: refs/heads/feature/x\n").unwrap();
        let wt = tmp.path().join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join(".git"), "gitdir: ../main/.git/worktrees/wt\n").unwrap();
        assert_eq!(branch_of(&wt).as_deref(), Some("feature/x"));
        std::fs::write(main.join("HEAD"), "0123456789abcdef\n").unwrap();
        assert_eq!(branch_of(&wt), None);
    }
}
