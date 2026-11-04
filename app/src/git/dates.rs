//! Dates and names like WebStorm's VCS log, ported from IntelliJ IDEA Community (Apache-2.0, see
//! app/NOTICE):
//! - the log's Date column: `DateFormatUtil.formatPrettyDateTime` on the author time
//!   (`VcsLogDefaultColumn.Date`; pretty formatting is on by default): "Moments ago", "A minute
//!   ago", "N minutes ago", "1 hour ago" (up to 61 minutes), "Today 11:46", "Yesterday 11:46",
//!   else the macOS medium date + short time of the user's locale: "2026-10-15, 11:56";
//! - annotate's date: `DateFormatUtil.formatPrettyDate`: "Today", "Yesterday", "2026-10-15";
//! - the author column's "*": `CommitPresentationUtil.getAuthorPresentation` with
//!   `VcsUserUtil.isSamePerson` (names compared loosely, emails ignored).
//!
//! No date crate: the local zone comes from the system's TZif file (`/etc/localtime`, or `$TZ`).

use std::sync::OnceLock;

use super::log::Person;

const DAY: i64 = 86_400;

/// A time zone: UTC offsets over time (TZif transitions) or a fixed offset.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Zone {
    /// (transition time, offset seconds from then on), sorted.
    transitions: Vec<(i64, i32)>,
    /// The offset before the first transition (or always, for a fixed zone).
    initial: i32,
}

impl Zone {
    pub fn fixed(offset_sec: i32) -> Zone {
        Zone {
            transitions: Vec::new(),
            initial: offset_sec,
        }
    }

    /// The machine's zone (read once). UTC when it can't be read.
    pub fn system() -> &'static Zone {
        static ZONE: OnceLock<Zone> = OnceLock::new();
        ZONE.get_or_init(|| {
            let path = match std::env::var("TZ") {
                Ok(tz) if !tz.is_empty() => {
                    let tz = tz.trim_start_matches(':');
                    if tz.starts_with('/') {
                        tz.to_owned()
                    } else {
                        format!("/usr/share/zoneinfo/{tz}")
                    }
                }
                _ => "/etc/localtime".to_owned(),
            };
            std::fs::read(path)
                .ok()
                .and_then(|b| Zone::parse_tzif(&b))
                .unwrap_or_else(|| Zone::fixed(0))
        })
    }

    /// Parses a TZif file (v1 32-bit data, v2+ 64-bit data when present).
    pub fn parse_tzif(b: &[u8]) -> Option<Zone> {
        fn be32(b: &[u8], at: usize) -> Option<i32> {
            Some(i32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
        }
        fn be64(b: &[u8], at: usize) -> Option<i64> {
            Some(i64::from_be_bytes(b.get(at..at + 8)?.try_into().ok()?))
        }
        struct Header {
            isutcnt: usize,
            isstdcnt: usize,
            leapcnt: usize,
            timecnt: usize,
            typecnt: usize,
            charcnt: usize,
        }
        let header = |at: usize| -> Option<Header> {
            if b.get(at..at + 4)? != b"TZif" {
                return None;
            }
            let c = |i: usize| be32(b, at + 20 + i * 4).map(|v| v as usize);
            Some(Header {
                isutcnt: c(0)?,
                isstdcnt: c(1)?,
                leapcnt: c(2)?,
                timecnt: c(3)?,
                typecnt: c(4)?,
                charcnt: c(5)?,
            })
        };
        let h1 = header(0)?;
        let version = *b.get(4)?;
        let (h, data, tsize) = if version >= b'2' {
            let v1_len = h1.timecnt * 5
                + h1.typecnt * 6
                + h1.charcnt
                + h1.leapcnt * 8
                + h1.isstdcnt
                + h1.isutcnt;
            let at = 44 + v1_len;
            (header(at)?, at + 44, 8)
        } else {
            (h1, 44, 4)
        };
        let times_at = data;
        let idx_at = times_at + h.timecnt * tsize;
        let types_at = idx_at + h.timecnt;
        let offset_of = |t: usize| be32(b, types_at + t * 6);
        let mut transitions = Vec::with_capacity(h.timecnt);
        for i in 0..h.timecnt {
            let t = if tsize == 8 {
                be64(b, times_at + i * 8)?
            } else {
                be32(b, times_at + i * 4)? as i64
            };
            let ty = *b.get(idx_at + i)? as usize;
            transitions.push((t, offset_of(ty)?));
        }
        // before the first transition: the first non-DST type (RFC 8536 suggests type 0)
        let initial = offset_of(0)?;
        Some(Zone {
            transitions,
            initial,
        })
    }

    /// The UTC offset (seconds) at `unix`.
    pub fn offset_at(&self, unix: i64) -> i32 {
        match self.transitions.partition_point(|&(t, _)| t <= unix) {
            0 => self.initial,
            i => self.transitions[i - 1].1,
        }
    }

    /// Local calendar fields of `unix`.
    pub fn local(&self, unix: i64) -> LocalTime {
        LocalTime::from_unix(unix + self.offset_at(unix) as i64)
    }
}

/// Calendar fields of a (zone-shifted) time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LocalTime {
    pub year: i64,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    /// Days since 1970-01-01 (for "same day" / "yesterday").
    pub days: i64,
}

impl LocalTime {
    fn from_unix(t: i64) -> LocalTime {
        let days = t.div_euclid(DAY);
        let secs = t.rem_euclid(DAY);
        // Howard Hinnant's civil_from_days
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z.rem_euclid(146_097);
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
        let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
        let year = yoe + era * 400 + i64::from(month <= 2);
        LocalTime {
            year,
            month,
            day,
            hour: (secs / 3600) as u32,
            minute: (secs % 3600 / 60) as u32,
            days,
        }
    }

    /// "2026-10-15" (macOS medium date of the user's locale, en_US@rg=SE: `y-MM-dd`).
    pub fn date(&self) -> String {
        format!("{}-{:02}-{:02}", self.year, self.month, self.day)
    }

    /// "11:46" (24 h, `HH:mm`).
    pub fn time(&self) -> String {
        format!("{:02}:{:02}", self.hour, self.minute)
    }
}

/// `Math.rint`: round half to even.
fn rint(x: f64) -> f64 {
    let r = x.round();
    if (x - x.trunc()).abs() == 0.5 && r % 2.0 != 0.0 {
        r - x.signum()
    } else {
        r
    }
}

/// `DateFormatUtil.doFormatPretty`: Some("Today ..." / "Yesterday ..." / "N minutes ago") or
/// None for the plain date.
fn pretty(unix: i64, now: i64, zone: &Zone, with_time: bool) -> Option<String> {
    let delta = now - unix;
    if with_time && (0..=61 * 60).contains(&delta) {
        let n = rint(delta as f64 / 60.0) as i64;
        return Some(match n {
            0 => "Moments ago".into(),
            1 => "A minute ago".into(),
            2..=59 => format!("{n} minutes ago"),
            _ => "1 hour ago".into(),
        });
    }
    let t = zone.local(unix);
    let today = zone.local(now);
    let suffix = |word: &str| {
        if with_time {
            format!("{word} {}", t.time())
        } else {
            word.to_owned()
        }
    };
    if t.days == today.days {
        return Some(suffix("Today"));
    }
    if t.days + 1 == today.days {
        return Some(suffix("Yesterday"));
    }
    None
}

/// The log's Date column (`formatPrettyDateTime`) for `unix` seen at `now`.
pub fn format_log_date(unix: i64, now: i64, zone: &Zone) -> String {
    if unix < 0 {
        return String::new();
    }
    pretty(unix, now, zone, true).unwrap_or_else(|| {
        let t = zone.local(unix);
        format!("{}, {}", t.date(), t.time())
    })
}

/// Annotate's date (`formatPrettyDate`): "Today", "Yesterday", "2026-10-15".
pub fn format_pretty_date(unix: i64, now: i64, zone: &Zone) -> String {
    pretty(unix, now, zone, false).unwrap_or_else(|| zone.local(unix).date())
}

/// Commit details' full date: "2026-10-15, 11:56" (Lua details used "%Y-%m-%d at %H:%M").
pub fn format_date_time(unix: i64, zone: &Zone) -> String {
    let t = zone.local(unix);
    format!("{}, {}", t.date(), t.time())
}

/// The current time (seconds since the epoch).
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

/// `VcsUserUtil.getName`: the name, else the email's local part, else the email.
pub fn display_name(p: &Person) -> &str {
    if !p.name.is_empty() {
        return &p.name;
    }
    match p.email.split_once('@') {
        Some((local, _)) if !local.is_empty() => local,
        _ => &p.email,
    }
}

/// `VcsUserUtil.nameToLowerCase` after `getName`: "john.doe" and "John Doe" are one person.
fn normalized_name(p: &Person) -> String {
    let name = display_name(p);
    // NAME_PATTERN (\w+)[\p{Punct}\s](\w+), full match (ASCII \w / \p{Punct} as in Java)
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let sep = name.char_indices().find(|&(_, c)| !word(c));
    if let Some((i, c)) = sep {
        let (a, b) = (&name[..i], &name[i + c.len_utf8()..]);
        if (c.is_ascii_punctuation() || c.is_whitespace())
            && !a.is_empty()
            && !b.is_empty()
            && b.chars().all(word)
        {
            return format!("{} {}", a.to_lowercase(), b.to_lowercase());
        }
    }
    if name.chars().all(|c| (' '..='~').contains(&c)) {
        name.to_lowercase()
    } else {
        name.to_owned()
    }
}

/// `VcsUserUtil.isSamePerson`.
pub fn same_person(a: &Person, b: &Person) -> bool {
    normalized_name(a) == normalized_name(b)
}

/// The Author column: "Name", "Name*" when someone else committed it (WS's rule: names compared
/// loosely, emails ignored; the Lua log also starred a different email).
pub fn author_text(author: &Person, committer: &Person) -> String {
    let unknown = committer.name.is_empty() && committer.email.is_empty();
    let star = if unknown || same_person(author, committer) {
        ""
    } else {
        "*"
    };
    format!("{}{star}", display_name(author))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(name: &str, email: &str) -> Person {
        Person {
            name: name.into(),
            email: email.into(),
        }
    }

    // 2026-10-17 12:00 UTC
    const NOW: i64 = 1_792_238_400;

    #[test]
    fn calendar_fields() {
        let t = LocalTime::from_unix(NOW);
        assert_eq!(
            (t.year, t.month, t.day, t.hour, t.minute),
            (2026, 10, 17, 12, 0)
        );
        let t = LocalTime::from_unix(951_782_400); // 2000-02-29
        assert_eq!((t.year, t.month, t.day), (2000, 2, 29));
        let t = LocalTime::from_unix(-1);
        assert_eq!((t.year, t.month, t.day, t.hour), (1969, 12, 31, 23));
    }

    struct LogDate {
        name: &'static str,
        zone: i32,
        now: i64,
        t: i64,
        want: &'static str,
    }

    const fn at(name: &'static str, ago: i64, want: &'static str) -> LogDate {
        LogDate {
            name,
            zone: 2 * 3600,
            now: NOW,
            t: NOW - ago,
            want,
        }
    }

    // 2026-01-01 01:00 UTC
    const JAN1: i64 = 1_767_225_600 + 3600;

    // NOW is 14:00 local in these rows
    const LOG_DATES: &[LogDate] = &[
        at("now", 0, "Moments ago"),
        at("29 s", 29, "Moments ago"),
        at("31 s", 31, "A minute ago"),
        at("2.5 minutes round down", 150, "2 minutes ago"),
        at("45 minutes", 45 * 60, "45 minutes ago"),
        at("60 minutes", 60 * 60, "1 hour ago"),
        at("61 minutes", 61 * 60, "1 hour ago"),
        at("62 minutes: the time today", 62 * 60, "Today 12:58"),
        at("midnight", 14 * 3600, "Today 00:00"),
        at(
            "a minute before midnight",
            14 * 3600 + 60,
            "Yesterday 23:59",
        ),
        at(
            "two days back: the date",
            38 * 3600 + 60,
            "2026-10-15, 23:59",
        ),
        at("later today", -3600, "Today 15:00"),
        at("tomorrow: the date", -DAY, "2026-10-18, 14:00"),
        LogDate {
            name: "before 1970: blank",
            zone: 2 * 3600,
            now: NOW,
            t: -5,
            want: "",
        },
        LogDate {
            name: "yesterday across a year boundary",
            zone: 0,
            now: JAN1,
            t: JAN1 - 2 * 3600,
            want: "Yesterday 23:00",
        },
    ];

    #[test]
    fn log_dates_read_like_webstorm() {
        for row in LOG_DATES {
            let z = Zone::fixed(row.zone);
            assert_eq!(
                format_log_date(row.t, row.now, &z),
                row.want,
                "{}",
                row.name
            );
        }
        let z = Zone::fixed(2 * 3600);
        assert_eq!(format_pretty_date(NOW - 60, NOW, &z), "Today");
        assert_eq!(format_pretty_date(NOW - DAY, NOW, &z), "Yesterday");
        assert_eq!(format_pretty_date(NOW - 3 * DAY, NOW, &z), "2026-10-14");
        assert_eq!(format_date_time(NOW, &z), "2026-10-17, 14:00");
    }

    #[test]
    fn tzif_zone_offsets() {
        let Ok(b) = std::fs::read("/usr/share/zoneinfo/Europe/Stockholm") else {
            return;
        };
        let z = Zone::parse_tzif(&b).unwrap();
        assert_eq!(z.offset_at(NOW), 7200, "summer time");
        assert_eq!(z.offset_at(1_768_000_000), 3600, "winter");
        let z = Zone::system();
        let _ = z.offset_at(NOW);
    }

    #[test]
    fn another_author_gets_a_star() {
        let a = p("Ada Example", "ada@x.se");
        assert_eq!(author_text(&a, &a), "Ada Example");
        // email ignored, names compared loosely
        assert_eq!(author_text(&a, &p("ada example", "other@y")), "Ada Example");
        assert_eq!(
            author_text(&p("john.doe", ""), &p("John Doe", "")),
            "john.doe"
        );
        assert_eq!(author_text(&a, &p("Max", "m@x.se")), "Ada Example*");
        assert_eq!(author_text(&p("", "bob@x"), &p("bob", "")), "bob");
        assert_eq!(author_text(&a, &Person::default()), "Ada Example");
        assert!(!same_person(&p("Åsa Öberg", ""), &p("åsa öberg", "")));
    }
}
