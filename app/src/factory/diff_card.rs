//! The rendered Chat's diff card (`chat-components.ts` `DiffCard`, board R-Anatomy): one changed
//! file, its 26 px header (chevron, file icon, the path in the path colour, `+3 −1`, the dim note)
//! and under it, unless folded, a unified diff: line numbers, the sign, the code in the editor's
//! mono at 12 / 18 on the diff's line backgrounds, then a dim `show N more` row.
//!
//! The code is coloured with the DS editor tokens (Darcula Contrast's syntax colours) by a small
//! JS / TS lexer here ([`spans`]): the Factory view has no Neovim of its own to colour with
//! (the spec: diff colouring through the DS syntax tokens). Another language draws plain.

use std::ops::Range;

use gpui_kit::{
    AnyElement, HighlightStyle, InteractiveElement as _, IntoElement, ParentElement as _, Rgba,
    SharedString, Styled as _, StyledText, div, prelude::FluentBuilder as _, px,
};
use serde::Deserialize;

use super::draw::{Drawn, clickable, selector};
use super::transcript::{MONO_LINE, MONO_SIZE, counts, selection_bg, small};
use crate::kit::{Icon, IconName, for_file};
use crate::look;
use crate::render::EDITOR_FONT;

/// px (board `.nv-rdiff`): the header, the code block's arc, the number and sign columns.
const HEAD_H: f32 = 26.;
const DOC_CODE_ARC: f32 = 5.;
const NUM_W: f32 = 30.;
const SIGN_W: f32 = 14.;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LineKind {
    Context,
    Inserted,
    Deleted,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct DiffLine {
    pub kind: LineKind,
    pub number: Option<u64>,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct DiffMore {
    pub count: u64,
    pub id: Option<String>,
    /// The transcript's cursor is on the row (t113d).
    #[serde(default)]
    pub selected: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct DiffCardProps {
    pub path: String,
    pub added: u64,
    pub removed: u64,
    #[serde(default)]
    pub lines: Vec<DiffLine>,
    pub note: Option<String>,
    #[serde(default)]
    pub folded: bool,
    pub more: Option<DiffMore>,
    #[serde(default)]
    pub selected: bool,
    pub lang: Option<String>,
    /// In place of the path in the header (a prototype change's `2 · JS · the VAT line`);
    /// the path still names its icon and colours.
    pub title: Option<String>,
    /// Drawn dim: a prototype change undone since.
    #[serde(default)]
    pub dim: bool,
}

/// A token's look: the DS syntax token it takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tok {
    Keyword,
    String,
    Number,
    Comment,
    Func,
    Field,
    /// `;` and `,` (`.vs-code .tok-punct`: the keyword colour).
    Punct,
}

impl Tok {
    pub fn color(self) -> Rgba {
        match self {
            Tok::Keyword | Tok::Punct => look::SYNTAX_KEYWORD.rgba(),
            Tok::String => look::SYNTAX_STRING.rgba(),
            Tok::Number => look::SYNTAX_NUMBER.rgba(),
            Tok::Comment => look::SYNTAX_COMMENT.rgba(),
            Tok::Func => look::SYNTAX_FUNC.rgba(),
            Tok::Field => look::SYNTAX_FIELD.rgba(),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Tok::Keyword => "keyword",
            Tok::String => "string",
            Tok::Number => "number",
            Tok::Comment => "comment",
            Tok::Func => "func",
            Tok::Field => "field",
            Tok::Punct => "punct",
        }
    }
}

const KEYWORDS: &[&str] = &[
    "abstract",
    "any",
    "as",
    "async",
    "await",
    "bigint",
    "boolean",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "declare",
    "default",
    "delete",
    "do",
    "else",
    "enum",
    "export",
    "extends",
    "false",
    "finally",
    "for",
    "from",
    "function",
    "if",
    "implements",
    "import",
    "in",
    "instanceof",
    "interface",
    "keyof",
    "let",
    "new",
    "never",
    "null",
    "number",
    "object",
    "of",
    "private",
    "protected",
    "public",
    "readonly",
    "return",
    "satisfies",
    "static",
    "string",
    "super",
    "switch",
    "symbol",
    "this",
    "throw",
    "true",
    "try",
    "type",
    "typeof",
    "undefined",
    "unknown",
    "var",
    "void",
    "while",
    "yield",
];

/// Whether the card's code is coloured: JS / TS by its `lang`, else by the path's extension.
pub fn colours(path: &str, lang: Option<&str>) -> bool {
    let word = match lang {
        Some(l) => l.to_ascii_lowercase(),
        None => path
            .rsplit_once('.')
            .map_or_else(String::new, |(_, e)| e.to_ascii_lowercase()),
    };
    matches!(
        word.as_str(),
        "ts" | "tsx"
            | "mts"
            | "cts"
            | "js"
            | "jsx"
            | "mjs"
            | "cjs"
            | "typescript"
            | "javascript"
            | "typescriptreact"
            | "javascriptreact"
    )
}

/// One line of JS / TS as coloured byte ranges (sorted, apart): keywords, strings, numbers,
/// comments, a call's name, a field after `.`, `;` and `,`; the rest the editor's plain colour.
pub fn spans(line: &str) -> Vec<(Range<usize>, Tok)> {
    let b = line.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    let ident = |c: u8| c.is_ascii_alphanumeric() || c == b'_' || c == b'$';
    while i < b.len() {
        let c = b[i];
        if c == b'/' && b.get(i + 1) == Some(&b'/') {
            out.push((i..b.len(), Tok::Comment));
            break;
        }
        if c == b'/' && b.get(i + 1) == Some(&b'*') {
            let end = line[i + 2..].find("*/").map_or(b.len(), |e| i + 2 + e + 2);
            out.push((i..end, Tok::Comment));
            i = end;
            continue;
        }
        if c == b'"' || c == b'\'' || c == b'`' {
            let mut j = i + 1;
            while j < b.len() && b[j] != c {
                j += if b[j] == b'\\' { 2 } else { 1 };
            }
            let end = (j + 1).min(b.len());
            out.push((i..end, Tok::String));
            i = end;
            continue;
        }
        if c.is_ascii_digit() && (i == 0 || !ident(b[i - 1])) {
            let mut j = i;
            while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b'.' || b[j] == b'_') {
                j += 1;
            }
            out.push((i..j, Tok::Number));
            i = j;
            continue;
        }
        if ident(c) {
            let mut j = i;
            while j < b.len() && ident(b[j]) {
                j += 1;
            }
            let word = &line[i..j];
            let after = line[j..].trim_start();
            let dotted = i > 0 && b[i - 1] == b'.';
            let tok = if after.starts_with('(') && !KEYWORDS.contains(&word) {
                Some(Tok::Func)
            } else if dotted {
                Some(Tok::Field)
            } else if KEYWORDS.contains(&word) {
                Some(Tok::Keyword)
            } else {
                None
            };
            if let Some(t) = tok {
                out.push((i..j, t));
            }
            i = j;
            continue;
        }
        if c == b';' || c == b',' {
            out.push((i..i + 1, Tok::Punct));
        }
        // a multi-byte character: step over it whole
        i += line[i..].chars().next().map_or(1, char::len_utf8);
    }
    out
}

fn sign(kind: LineKind) -> (&'static str, Rgba, Option<Rgba>) {
    match kind {
        LineKind::Context => (" ", look::TEXT_DIM.rgba(), None),
        LineKind::Inserted => (
            "+",
            look::GIT_ADDED.rgba(),
            Some(look::DIFF_INSERTED_BG.rgba()),
        ),
        LineKind::Deleted => (
            "−",
            look::ABE_BAD.rgba(),
            Some(look::DIFF_DELETED_BG.rgba()),
        ),
    }
}

/// The editor's mono, ligatures as in the editor (off by default: `=>` stays two characters).
pub(super) fn mono() -> gpui_kit::Div {
    div()
        .font(gpui_kit::font(EDITOR_FONT))
        .font_features(crate::render::editor_features())
        .text_size(px(MONO_SIZE))
        .line_height(px(MONO_LINE))
}

/// `#rrggbb` (what tests read of a drawn colour).
pub fn hex(c: Rgba) -> String {
    let b = |v: f32| (v * 255.).round() as u8;
    format!("#{:02x}{:02x}{:02x}", b(c.r), b(c.g), b(c.b))
}

fn line(l: &DiffLine, coloured: bool, drawn: &mut Drawn) -> AnyElement {
    let (glyph, sign_fg, bg) = sign(l.kind);
    let num = l.number.map(|n| n.to_string()).unwrap_or_default();
    drawn.add("DiffLine", format!("{num} {glyph} {}", l.text));
    drawn.add("DiffLineBg", bg.map_or_else(|| "none".to_owned(), hex));
    let toks = if coloured { spans(&l.text) } else { Vec::new() };
    if coloured {
        drawn.add(
            "DiffSpans",
            toks.iter()
                .map(|(r, t)| format!("{}={} {}", &l.text[r.clone()], t.name(), hex(t.color())))
                .collect::<Vec<_>>()
                .join(" "),
        );
    }
    let code = StyledText::new(SharedString::from(l.text.clone())).with_highlights(
        toks.into_iter().map(|(r, t)| {
            (
                r,
                HighlightStyle {
                    color: Some(t.color().into()),
                    ..HighlightStyle::default()
                },
            )
        }),
    );
    div()
        .flex_none()
        .w_full()
        .h(px(MONO_LINE))
        .flex()
        .overflow_hidden()
        .whitespace_nowrap()
        .when_some(bg, |d, bg| d.bg(bg))
        .child(
            mono()
                .flex_none()
                .w(px(NUM_W))
                .pr(px(6.))
                .flex()
                .justify_end()
                .text_color(look::EDITOR_LINE_NUMBER)
                .child(SharedString::from(num)),
        )
        .child(
            mono()
                .flex_none()
                .w(px(SIGN_W))
                .text_color(sign_fg)
                .child(glyph),
        )
        .child(
            mono()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .text_color(look::EDITOR_FG)
                .child(code),
        )
        .into_any_element()
}

pub fn diff_card(id: Option<&str>, p: &DiffCardProps, drawn: &mut Drawn) -> AnyElement {
    let shown = p.title.clone().unwrap_or_else(|| p.path.clone());
    let ix = drawn.add("DiffCard", shown.clone());
    let sel = selector("DiffCard", ix, id);
    if !p.dim {
        drawn.add("DiffStat", format!("+{} −{}", p.added, p.removed));
    }
    if p.selected {
        drawn.add("Selection", p.path.clone());
    }
    let name = p.path.rsplit('/').next().unwrap_or(&p.path);
    let head = div()
        .id(SharedString::from(format!("{sel}-head")))
        .debug_selector({
            let sel = sel.clone();
            move || format!("{sel}-head")
        })
        .flex_none()
        .w_full()
        .h(px(HEAD_H))
        .flex()
        .items_center()
        .gap(px(6.))
        .pl(px(6.))
        .pr(px(8.))
        .overflow_hidden()
        .whitespace_nowrap()
        .bg(if p.selected {
            selection_bg(drawn)
        } else {
            look::PANEL_BG.rgba()
        })
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .when(!p.folded, |d| d.border_b_1().border_color(look::SEPARATOR))
        .child(
            Icon::new(if p.folded {
                IconName::ChevronRight
            } else {
                IconName::ChevronDown
            })
            .size(px(12.)),
        )
        .child(Icon::new(for_file(name)).size(px(14.)))
        .child(
            div()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .text_color(if p.dim {
                    look::TEXT_DISABLED
                } else if p.title.is_some() {
                    look::TEXT
                } else {
                    look::ABE_PATH
                })
                .child(SharedString::from(shown)),
        )
        .when(!p.dim, |d| {
            d.children(counts(Some(p.added), Some(p.removed), false))
        })
        .when_some(p.note.clone(), |d, n| {
            drawn.add("DiffNote", n.clone());
            d.child(small(n, look::TEXT_DISABLED.rgba()).ml_auto())
        });
    let head = clickable(head, id, drawn);
    let body = (!p.folded).then(|| {
        let coloured = colours(&p.path, p.lang.as_deref());
        let lines: Vec<AnyElement> = p.lines.iter().map(|l| line(l, coloured, drawn)).collect();
        let more = p.more.as_ref().map(|m| {
            let words = format!("show {} more", m.count);
            drawn.add("DiffMore", words.clone());
            if m.selected {
                drawn.add("Selection", words.clone());
            }
            let more_sel = format!("{sel}-more");
            let row = div()
                .id(SharedString::from(more_sel.clone()))
                .debug_selector(move || more_sel)
                .flex_none()
                .w_full()
                .h(px(MONO_LINE))
                .pl(px(NUM_W + SIGN_W))
                .flex()
                .items_center()
                .when(m.selected, |d| d.bg(selection_bg(drawn)))
                .hover(|s| s.bg(look::HOVER_BG))
                .child(small(words, look::TEXT_DIM.rgba()));
            clickable(row, m.id.as_deref(), drawn)
        });
        div()
            .flex_none()
            .w_full()
            .flex()
            .flex_col()
            .py(px(2.))
            .children(lines)
            .children(more)
    });
    div()
        .debug_selector(move || sel)
        .flex_none()
        .w_full()
        .flex()
        .flex_col()
        .overflow_hidden()
        .rounded(px(DOC_CODE_ARC))
        .border_1()
        .border_color(look::SEPARATOR)
        .bg(look::EDITOR_BG)
        .child(head)
        .children(body)
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named(line: &str) -> Vec<(&str, Tok)> {
        spans(line)
            .into_iter()
            .map(|(r, t)| (&line[r], t))
            .collect()
    }

    /// (line, its coloured tokens)
    const LEXED: &[(&str, &[(&str, Tok)])] = {
        use Tok::*;
        &[
            (
                "export function cartTotal(cart: Cart): number {",
                &[
                    ("export", Keyword),
                    ("function", Keyword),
                    ("cartTotal", Func),
                    ("number", Keyword),
                ],
            ),
            (
                "  const vat = marketFor(cart.market).vat;",
                &[
                    ("const", Keyword),
                    ("marketFor", Func),
                    ("market", Field),
                    ("vat", Field),
                    (";", Punct),
                ],
            ),
            (
                "      return sum + line.price * line.quantity;",
                &[
                    ("return", Keyword),
                    ("price", Field),
                    ("quantity", Field),
                    (";", Punct),
                ],
            ),
            (
                "  const subtotal = cart.lines.reduce(",
                &[("const", Keyword), ("lines", Field), ("reduce", Func)],
            ),
            ("    0,", &[("0", Number), (",", Punct)]),
            (
                r#"import { a } from "./m"; // why"#,
                &[
                    ("import", Keyword),
                    ("from", Keyword),
                    (r#""./m""#, String),
                    (";", Punct),
                    ("// why", Comment),
                ],
            ),
            (
                "x2 = 'a\\'b' /* c */ é",
                &[("'a\\'b'", String), ("/* c */", Comment)],
            ),
            ("'open", &[("'open", String)]),
        ]
    };

    #[test]
    fn the_lexer_colours_js_and_ts_tokens() {
        for (line, want) in LEXED {
            assert_eq!(named(line), *want, "{line}");
        }
    }

    #[test]
    fn only_js_and_ts_take_colours() {
        assert!(colours("api/src/cart.ts", None));
        assert!(colours("web/App.jsx", None));
        assert!(colours("README", Some("typescript")));
        assert!(!colours("README.md", None));
        assert!(!colours("web/src/total.js", Some("text")));
    }
}
