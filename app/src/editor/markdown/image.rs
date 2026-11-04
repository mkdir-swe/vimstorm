//! Images of a preview: local paths (relative to the markdown file) and their pixel size, read
//! from the file header off the UI thread with the parse, so a row is laid out at its final
//! height before the image itself loads (no jumps; GPUI's list keeps measured heights).
//!
//! Remote (http / https) images, like WS's JCEF preview loads them (README badges): fetched off
//! the UI thread by the system `curl` (no HTTP crate: proxies / TLS as macOS has them; 5 s, 5 MB
//! at most) into `~/Library/Caches/VimStorm/md-images/<hash>.<format>`, then drawn like a local
//! file; the alt text shows until then (and when the fetch fails). A cached file older than a
//! day is fetched again in the background (the old one stays meanwhile).

use std::collections::HashMap;
use std::hash::{Hash as _, Hasher as _};
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::Duration;

/// Where remote images are cached (tests point it at a temp dir).
static CACHE_DIR: RwLock<Option<PathBuf>> = RwLock::new(None);
/// The formats a cached image may have (by its content).
const CACHED_EXTS: [&str; 6] = ["png", "svg", "jpg", "gif", "webp", "bmp"];
/// Fetch limits.
const FETCH_TIMEOUT_S: u32 = 5;
const FETCH_MAX_BYTES: u32 = 5 * 1024 * 1024;
/// A cached image older than this is fetched again.
pub const REVALIDATE: Duration = Duration::from_secs(24 * 3600);

/// The remote image cache (default `~/Library/Caches/VimStorm/md-images`).
pub fn cache_dir() -> PathBuf {
    if let Some(d) = CACHE_DIR.read().ok().and_then(|d| d.clone()) {
        return d;
    }
    let home = std::env::var_os("HOME").map_or_else(|| PathBuf::from("/tmp"), PathBuf::from);
    home.join("Library/Caches/VimStorm/md-images")
}

/// Tests: cache remote images in `dir`.
pub fn set_cache_dir(dir: PathBuf) {
    if let Ok(mut d) = CACHE_DIR.write() {
        *d = Some(dir);
    }
}

/// An http(s) image source.
pub fn is_remote(src: &str) -> bool {
    let lower = src.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// A remote image's cache file name without its extension.
fn cache_key(url: &str) -> String {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    url.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// A remote image's cached file, if fetched.
pub fn cached(url: &str) -> Option<PathBuf> {
    let dir = cache_dir();
    let key = cache_key(url);
    CACHED_EXTS
        .iter()
        .map(|e| dir.join(format!("{key}.{e}")))
        .find(|p| p.is_file())
}

/// Whether `url` needs a fetch: not cached, or cached longer than [`REVALIDATE`] ago.
pub fn wants_fetch(url: &str) -> bool {
    match cached(url) {
        None => true,
        Some(p) => std::fs::metadata(&p)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_none_or(|age| age > REVALIDATE),
    }
}

/// The format of an image's bytes (its cache extension).
fn sniff(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(b"\x89PNG") {
        Some("png")
    } else if b.starts_with(&[0xff, 0xd8]) {
        Some("jpg")
    } else if b.starts_with(b"GIF8") {
        Some("gif")
    } else if b.starts_with(b"RIFF") && b.get(8..12) == Some(b"WEBP") {
        Some("webp")
    } else if b.starts_with(b"BM") {
        Some("bmp")
    } else {
        let head = String::from_utf8_lossy(&b[..b.len().min(1024)]).to_ascii_lowercase();
        head.contains("<svg").then_some("svg")
    }
}

/// Fetches `url` into the cache with the system `curl` (blocking: run it off the UI thread). Its
/// path and pixel size, or None (failed, too big, not an image).
pub fn fetch_blocking(url: &str) -> Option<(PathBuf, (f32, f32))> {
    fetch_with(url, |to| {
        std::process::Command::new("/usr/bin/curl")
            .args(["-fsSL", "--max-time", &FETCH_TIMEOUT_S.to_string()])
            .args(["--max-filesize", &FETCH_MAX_BYTES.to_string(), "-o"])
            .arg(to)
            .arg(url)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    })
}

/// Fetches `url` into the cache by `get`, which writes the file it's handed and says whether it
/// did. Blocking; its path and pixel size, or None (failed, not an image).
pub fn fetch_with(url: &str, get: impl FnOnce(&Path) -> bool) -> Option<(PathBuf, (f32, f32))> {
    let tmp = part_file(url)?;
    let got = get(&tmp);
    adopt(url, &tmp, got)
}

/// The file a fetch of `url` writes before [`adopt`] takes it into the cache (its folder made).
pub fn part_file(url: &str) -> Option<PathBuf> {
    let dir = cache_dir();
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(format!("{}.part{}", cache_key(url), std::process::id())))
}

/// The fetched file `tmp` (`got`: the fetch said it wrote it; an image only a port can read, an
/// Azure DevOps attachment, is written by the Azure port) as `url`'s cached image: its path and
/// pixel size, or None (failed, not an image; `tmp` removed).
pub fn adopt(url: &str, tmp: &Path, got: bool) -> Option<(PathBuf, (f32, f32))> {
    let dir = cache_dir();
    let key = cache_key(url);
    let bytes = got.then(|| std::fs::read(tmp).ok()).flatten();
    let found = bytes
        .as_deref()
        .and_then(|b| Some((sniff(b)?, header_size(b)?)));
    let Some((ext, size)) = found else {
        let _ = std::fs::remove_file(tmp);
        return None;
    };
    for e in CACHED_EXTS {
        let _ = std::fs::remove_file(dir.join(format!("{key}.{e}")));
    }
    let path = dir.join(format!("{key}.{ext}"));
    std::fs::rename(tmp, &path).ok()?;
    Some((path, size))
}

/// Remote image sources in `rows`, each once.
pub fn remote(rows: &[Row]) -> Vec<String> {
    let mut srcs = Vec::new();
    for r in rows {
        match &r.kind {
            RowKind::Node(n) => collect(n, &mut srcs),
            RowKind::Item { item, .. } => item.nodes.iter().for_each(|n| collect(n, &mut srcs)),
        }
    }
    srcs.retain(|s| is_remote(s));
    srcs.sort();
    srcs.dedup();
    srcs
}

/// Remote image sources in `rows` that need a fetch.
pub fn to_fetch(rows: &[Row]) -> Vec<String> {
    let mut srcs = remote(rows);
    srcs.retain(|s| wants_fetch(s));
    srcs
}

use super::doc::{Node, Piece, Row, RowKind};

/// An image's file: a local path (`file://`, absolute, or relative to `dir`), a remote image's
/// cached copy; None for remote images not fetched (yet) and `data:` URLs. Stats the cache for
/// remote ones: off the UI thread (frames use [`Images::path`]).
pub fn resolve(src: &str, dir: &Path) -> Option<PathBuf> {
    if is_remote(src) {
        return cached(src);
    }
    local(src, dir)
}

/// A local image's path (no disk access); None for remote images and `data:` URLs.
fn local(src: &str, dir: &Path) -> Option<PathBuf> {
    if is_remote(src) || src.to_ascii_lowercase().starts_with("data:") {
        return None;
    }
    let path = percent_decode(src.strip_prefix("file://").unwrap_or(src));
    let path = path.split(['?', '#']).next().unwrap_or_default();
    let p = Path::new(path);
    Some(if p.is_absolute() {
        p.to_path_buf()
    } else {
        dir.join(p)
    })
}

/// What a document's images resolve to, found off the UI thread (with the parse, a fetch): frames
/// only look it up.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Images {
    /// Pixel sizes by src (unreadable / not fetched ones left out).
    pub sizes: HashMap<String, (f32, f32)>,
    /// Remote images' cached files by url.
    pub cached: HashMap<String, PathBuf>,
}

impl Images {
    /// The file image `src` draws from ([`resolve`] without touching the disk).
    pub fn path(&self, src: &str, dir: &Path) -> Option<PathBuf> {
        if is_remote(src) {
            return self.cached.get(src).cloned();
        }
        local(src, dir)
    }

    /// A fetched remote image.
    pub fn insert_fetched(&mut self, url: &str, path: PathBuf, size: (f32, f32)) {
        self.sizes.insert(url.to_string(), size);
        self.cached.insert(url.to_string(), path);
    }
}

/// Sizes of the images in `rows` (src -> px) and remote ones' cached files; unreadable ones
/// left out. Reads the disk: off the UI thread.
pub fn images(rows: &[Row], dir: &Path) -> Images {
    let mut out = Images::default();
    let mut srcs = Vec::new();
    for r in rows {
        match &r.kind {
            RowKind::Node(n) => collect(n, &mut srcs),
            RowKind::Item { item, .. } => item.nodes.iter().for_each(|n| collect(n, &mut srcs)),
        }
    }
    for src in srcs {
        if out.sizes.contains_key(&src) {
            continue;
        }
        let Some(path) = resolve(&src, dir) else {
            continue;
        };
        if let Some(size) = size(&path) {
            if is_remote(&src) {
                out.cached.insert(src.clone(), path);
            }
            out.sizes.insert(src, size);
        }
    }
    out
}

fn collect(n: &Node, out: &mut Vec<String>) {
    let pieces = |ps: &[Piece], out: &mut Vec<String>| {
        for p in ps {
            if let Piece::Image(i) = p {
                out.push(i.src.clone());
            }
        }
    };
    match n {
        Node::Para(ps) | Node::Heading { pieces: ps, .. } => pieces(ps, out),
        Node::Center(n) => collect(n, out),
        Node::Table(t) => {
            for c in t.head.iter().chain(t.rows.iter().flatten()) {
                pieces(c, out);
            }
        }
        Node::List(l) => l
            .items
            .iter()
            .for_each(|i| i.nodes.iter().for_each(|n| collect(n, out))),
        Node::Quote(ns) | Node::Footnote { nodes: ns, .. } => {
            ns.iter().for_each(|n| collect(n, out))
        }
        _ => {}
    }
}

/// Pixel size from a PNG / GIF / JPEG / WebP / BMP header, or an SVG's width / height (viewBox).
pub fn size(path: &Path) -> Option<(f32, f32)> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; 256 * 1024];
    let n = f.read(&mut buf).ok()?;
    buf.truncate(n);
    header_size(&buf)
}

pub fn header_size(b: &[u8]) -> Option<(f32, f32)> {
    let be32 =
        |i: usize| -> Option<u32> { Some(u32::from_be_bytes(b.get(i..i + 4)?.try_into().ok()?)) };
    let be16 = |i: usize| -> Option<u32> {
        Some(u16::from_be_bytes(b.get(i..i + 2)?.try_into().ok()?) as u32)
    };
    let le16 = |i: usize| -> Option<u32> {
        Some(u16::from_le_bytes(b.get(i..i + 2)?.try_into().ok()?) as u32)
    };
    let le32 =
        |i: usize| -> Option<u32> { Some(u32::from_le_bytes(b.get(i..i + 4)?.try_into().ok()?)) };
    if b.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some((be32(16)? as f32, be32(20)? as f32));
    }
    if b.starts_with(b"GIF8") {
        return Some((le16(6)? as f32, le16(8)? as f32));
    }
    if b.starts_with(b"BM") {
        return Some((le32(18)? as f32, (le32(22)? as i32).unsigned_abs() as f32));
    }
    if b.starts_with(b"RIFF") && b.get(8..12) == Some(b"WEBP") {
        return match b.get(12..16)? {
            b"VP8 " => Some(((le16(26)? & 0x3fff) as f32, (le16(28)? & 0x3fff) as f32)),
            b"VP8L" => {
                let v = le32(21)?;
                Some(((v & 0x3fff) as f32 + 1., ((v >> 14) & 0x3fff) as f32 + 1.))
            }
            b"VP8X" => {
                let w = le32(24)? & 0xffffff;
                let h = le32(27)? & 0xffffff;
                Some((w as f32 + 1., h as f32 + 1.))
            }
            _ => None,
        };
    }
    if b.starts_with(&[0xff, 0xd8]) {
        let mut i = 2;
        while i + 9 < b.len() {
            if b[i] != 0xff {
                i += 1;
                continue;
            }
            let m = b[i + 1];
            if (0xc0..=0xcf).contains(&m) && m != 0xc4 && m != 0xc8 && m != 0xcc {
                return Some((be16(i + 7)? as f32, be16(i + 5)? as f32));
            }
            let len = be16(i + 2)? as usize;
            i += 2 + len;
        }
        return None;
    }
    let text = std::str::from_utf8(b).ok()?;
    let start = text.find("<svg")?;
    let tag = &text[start..start + text[start..].find('>')?];
    let num = |name: &str| -> Option<f32> {
        let at = tag.find(&format!(" {name}=\""))? + name.len() + 3;
        let v = &tag[at..at + tag[at..].find('"')?];
        v.trim_end_matches("px").parse().ok()
    };
    if let (Some(w), Some(h)) = (num("width"), num("height")) {
        return Some((w, h));
    }
    let at = tag.find("viewBox=\"")? + 9;
    let vb: Vec<f32> = tag[at..at + tag[at..].find('"')?]
        .split([' ', ','])
        .filter_map(|s| s.parse().ok())
        .collect();
    (vb.len() == 4).then(|| (vb[2], vb[3]))
}

fn percent_decode(s: &str) -> String {
    if !s.contains('%') {
        return s.to_owned();
    }
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && let Some(v) = s
                .get(i + 1..i + 3)
                .and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_sizes() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend(160u32.to_be_bytes());
        png.extend(80u32.to_be_bytes());
        assert_eq!(header_size(&png), Some((160., 80.)));
        let gif = b"GIF89a\x10\x00\x20\x00";
        assert_eq!(header_size(gif), Some((16., 32.)));
        let svg = b"<?xml?><svg xmlns=\"x\" width=\"24\" height=\"12px\">";
        assert_eq!(header_size(svg), Some((24., 12.)));
        let svg = b"<svg viewBox=\"0 0 100 50\">";
        assert_eq!(header_size(svg), Some((100., 50.)));
    }

    #[test]
    fn resolves_relative_to_the_file() {
        let dir = Path::new("/p/docs");
        assert_eq!(
            resolve("a%20b.png", dir),
            Some(PathBuf::from("/p/docs/a b.png"))
        );
        assert_eq!(resolve("/abs.png", dir), Some(PathBuf::from("/abs.png")));
        assert_eq!(resolve("data:image/png;base64,AA", dir), None);
    }

    #[test]
    fn remote_images_resolve_to_their_cached_copy() {
        let tmp = tempfile::tempdir().unwrap();
        set_cache_dir(tmp.path().to_path_buf());
        let url = "https://img.test/badge?style=flat";
        assert_eq!(resolve(url, Path::new("/p")), None);
        assert!(wants_fetch(url));
        let file = tmp.path().join(format!("{}.svg", cache_key(url)));
        std::fs::write(&file, "<svg width=\"90\" height=\"20\">").unwrap();
        assert_eq!(resolve(url, Path::new("/p")), Some(file.clone()));
        assert!(!wants_fetch(url), "fresh");
        assert_eq!(size(&file), Some((90., 20.)));
        assert_eq!(sniff(b"<?xml version=\"1.0\"?><svg"), Some("svg"));
        assert_eq!(sniff(b"\x89PNG\r\n"), Some("png"));
        assert_eq!(sniff(b"<html>"), None);
    }
}
