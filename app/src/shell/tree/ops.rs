//! File actions the tree does itself (new, copy, paste, delete to the Trash). Renames and moves go
//! through Lua (`config/app/tree.lua`): the LSP servers update imports there, like today.

use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// Delete moves to the Trash (tests turn it off: fixtures don't belong in the user's Trash).
pub static USE_TRASH: AtomicBool = AtomicBool::new(true);

/// `dir` + what was typed into "New file or directory" (directories end with `/`), `..` and `.`
/// resolved. Returns the path and whether it's a file.
pub fn new_path(dir: &Path, typed: &str) -> Option<(PathBuf, bool)> {
    let typed = typed.trim();
    if typed.is_empty() {
        return None;
    }
    let is_file = !typed.ends_with('/');
    let joined = if Path::new(typed).is_absolute() {
        PathBuf::from(typed)
    } else {
        dir.join(typed)
    };
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            c => out.push(c),
        }
    }
    Some((out, is_file))
}

/// Creates the file (empty) or folder with its missing folders. An existing file is an error
/// ("File already exists"), an existing folder isn't.
pub fn create(path: &Path, is_file: bool) -> io::Result<()> {
    if is_file {
        if path.exists() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("File already exists:\n- `{}`", path.display()),
            ));
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map(|_| ())
    } else {
        std::fs::create_dir_all(path)
    }
}

/// Copies a file or folder (recursively, symlinks as links) to `to`; never overwrites.
pub fn copy_path(from: &Path, to: &Path) -> io::Result<()> {
    if to.symlink_metadata().is_ok() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("Already exists:\n- `{}`", to.display()),
        ));
    }
    let meta = from.symlink_metadata()?;
    if meta.file_type().is_symlink() {
        std::os::unix::fs::symlink(std::fs::read_link(from)?, to)
    } else if meta.is_dir() {
        std::fs::create_dir_all(to)?;
        for e in std::fs::read_dir(from)? {
            let e = e?;
            copy_path(&e.path(), &to.join(e.file_name()))?;
        }
        Ok(())
    } else {
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(from, to).map(|_| ())
    }
}

/// Copies each path into `dir` under its own name (paste, F5 on several rows). Paths already in
/// `dir` and folders into themselves are skipped. Returns the errors (one line each).
pub fn copy_into(paths: &[PathBuf], dir: &Path) -> Vec<String> {
    let mut errors = Vec::new();
    if let Err(e) = std::fs::create_dir_all(dir) {
        return vec![e.to_string()];
    }
    for from in paths {
        let Some(name) = from.file_name() else {
            continue;
        };
        if from.parent() == Some(dir) || dir.starts_with(from) {
            continue;
        }
        if let Err(e) = copy_path(from, &dir.join(name)) {
            errors.push(e.to_string());
        }
    }
    errors
}

/// Moves a path to the Trash (macOS `trash`, like snacks' explorer); deletes it when there's
/// no `trash` command. Blocking.
pub fn trash(path: &Path) -> Result<(), String> {
    let cmd = if USE_TRASH.load(Ordering::Relaxed) {
        "trash"
    } else {
        "/nonexistent/trash"
    };
    match std::process::Command::new(cmd)
        .arg(path)
        .stdin(std::process::Stdio::null())
        .output()
    {
        Ok(out) if out.status.success() => Ok(()),
        Ok(out) => Err(String::from_utf8_lossy(&out.stderr).trim().to_owned()),
        Err(_) => {
            let res = if path.is_dir() && !path.is_symlink() {
                std::fs::remove_dir_all(path)
            } else {
                std::fs::remove_file(path)
            };
            res.map_err(|e| e.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_paths() {
        let d = Path::new("/p/src");
        assert_eq!(
            new_path(d, "qa_dir/qa_new.ts"),
            Some((PathBuf::from("/p/src/qa_dir/qa_new.ts"), true))
        );
        assert_eq!(new_path(d, "x/"), Some((PathBuf::from("/p/src/x"), false)));
        assert_eq!(
            new_path(d, "../a.ts"),
            Some((PathBuf::from("/p/a.ts"), true))
        );
        assert_eq!(new_path(d, "  "), None);
    }

    #[test]
    fn create_copy_trash() {
        let t = tempfile::tempdir().unwrap();
        let r = t.path();
        create(&r.join("a/b/c.ts"), true).unwrap();
        assert!(create(&r.join("a/b/c.ts"), true).is_err());
        create(&r.join("a/d"), false).unwrap();
        create(&r.join("a/d"), false).unwrap();
        copy_path(&r.join("a"), &r.join("z")).unwrap();
        assert!(r.join("z/b/c.ts").is_file() && r.join("z/d").is_dir());
        assert!(copy_path(&r.join("a"), &r.join("z")).is_err());
        let errs = copy_into(&[r.join("a/b/c.ts"), r.join("z")], &r.join("a/d"));
        assert!(errs.is_empty(), "{errs:?}");
        assert!(r.join("a/d/c.ts").is_file() && r.join("a/d/z/b/c.ts").is_file());
        // into its own folder / itself: skipped
        assert!(copy_into(&[r.join("a/d/c.ts"), r.join("a")], &r.join("a/d")).is_empty());
        assert!(!r.join("a/d/a").exists());
        USE_TRASH.store(false, Ordering::Relaxed);
        trash(&r.join("z")).unwrap();
        assert!(!r.join("z").exists());
    }
}
