//! What the editor draws: the real nvim + config composed through the app's UI state, its grid
//! cells' text and colors, the colors of the native lists' selection and git status, the minimap
//! and local echo in a box's editor.

use crate::common;

use common::{Opts, Session};

use std::time::{Duration, Instant};

use vimstorm::nvim::UiState;

/// Generous: vtsls loads the project on first use.
const LSP_TIMEOUT: Duration = Duration::from_secs(60);

/// hl id of the composed screen's cell (row, col): the topmost grid there.
fn hl_at(ui: &UiState, row: usize, col: usize) -> Option<u32> {
    let (r, c) = (row as i64, col as i64);
    ui.layers().iter().rev().find_map(|l| {
        if !l.contains(r, c) {
            return None;
        }
        let g = ui.grids.get(&l.grid)?;
        Some(g.cell((r - l.row) as usize, (c - l.col) as usize)?.hl)
    })
}

/// Polls `check` (Err: what's wrong) until it passes; panics with the last Err after `timeout`.
fn poll(
    v: &mut common::view::View,
    label: &str,
    timeout: Duration,
    mut check: impl FnMut(&mut common::view::View) -> Result<(), String>,
) {
    let deadline = Instant::now() + timeout;
    loop {
        match check(v) {
            Ok(()) => return,
            Err(e) if Instant::now() > deadline => {
                panic!("{label}: {e}\n--- screen ---\n{}", v.screen().join("\n"))
            }
            Err(_) => v.settle(),
        }
    }
}

#[test]
fn opens_a_file_and_its_text_is_on_screen() {
    let s = Session::start(
        "proj",
        Opts {
            args: &["a.ts"],
            ..Default::default()
        },
    );
    s.wait_screen("export function add(x: number, y: number) {");
    // the caret is on the file's first line, in the editor's grid
    let file_row = s
        .screen()
        .iter()
        .position(|l| l.contains("export const a = 1;"))
        .unwrap() as i64;
    let caret = s.ui(|ui| ui.caret()).expect("caret");
    assert_eq!(caret.row, file_row);
    assert_ne!(s.ui(|ui| ui.cursor.grid), 1, "cursor on a window grid");
}

#[test]
fn typing_inserts_text_and_changes_mode() {
    let s = Session::start(
        "proj",
        Opts {
            args: &["multi.txt"],
            ..Default::default()
        },
    );
    s.wait_screen("alpha one");
    s.input("i");
    s.wait_for("insert mode", |ui| ui.mode == "insert");
    assert_eq!(s.mode(), "i");
    s.input("text<Esc>");
    s.wait_for("normal mode", |ui| ui.mode == "normal");
    s.wait_screen("textalpha one");
    let line = s.lua("return vim.api.nvim_get_current_line()");
    assert_eq!(line.as_str(), Some("textalpha one"));
}

#[test]
fn float_composes_at_its_position_over_the_editor() {
    let s = Session::start(
        "proj",
        Opts {
            args: &["multi.txt"],
            ..Default::default()
        },
    );
    s.wait_screen("alpha one");
    // a float relative to the editor window's text area (below its tab bar), no border
    s.lua(
        "local buf = vim.api.nvim_create_buf(false, true) \
         vim.api.nvim_buf_set_lines(buf, 0, -1, false, { 'FLOATTEXT' }) \
         vim.g.test_float = vim.api.nvim_open_win(buf, false, { relative = 'win', row = 2, col = 3, \
           width = 12, height = 1, style = 'minimal', border = 'none', zindex = 60 }) \
         return true",
    );
    s.wait_screen("FLOATTEXT");
    // where nvim itself puts it: the window's text area origin + (2, 3)
    let pos = s.lua(
        "local w = vim.fn.getwininfo(vim.fn.win_getid())[1] \
         local f = vim.api.nvim_win_get_position(vim.g.test_float) \
         return { w.winrow - 1 + w.winbar + 2, w.wincol - 1 + 3, f[1], f[2] }",
    );
    let pos: Vec<i64> = pos
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_i64().unwrap())
        .collect();
    assert_eq!((pos[2], pos[3]), (pos[0], pos[1]), "nvim's float position");
    let (row, col) = (pos[2] as usize, pos[3] as usize);
    let screen = s.screen();
    let line: String = screen[row].chars().skip(col).take(9).collect();
    assert_eq!(
        line,
        "FLOATTEXT",
        "float at ({row}, {col})\n{}",
        screen.join("\n")
    );
    // the float's grid wins the hit-test there and is placed at that cell
    let (grid, r, c) = s.ui(|ui| ui.hit_test(row as i64, col as i64)).unwrap();
    assert_eq!((r, c), (0, 0));
    assert!(s.ui(|ui| ui.layers().iter().any(|l| l.grid == grid && l.floating)));
}

#[test]
fn resize_reflows_the_screen() {
    let s = Session::start(
        "proj",
        Opts {
            args: &["multi.txt"],
            cols: 120,
            rows: 40,
        },
    );
    s.wait_screen("alpha one");
    s.resize(90, 30);
    s.wait_for("editor redrawn at 90x30", |ui| {
        let lines = ui.screen_lines();
        lines.len() == 30
            && lines.iter().all(|l| l.chars().count() == 90)
            && lines.iter().any(|l| l.contains("alpha one"))
    });
    let (cols, rows) = (s.lua("return vim.o.columns"), s.lua("return vim.o.lines"));
    assert_eq!((cols.as_u64(), rows.as_u64()), (Some(90), Some(30)));
}

#[test]
fn multiline_message_scrolls_over_the_windows_with_a_separator() {
    let s = Session::start(
        "proj",
        Opts {
            args: &["a.ts"],
            cols: 100,
            rows: 14,
        },
    );
    s.wait_screen("export function add");
    // `<Cmd>`: no command line drawn while it runs
    s.input("<Cmd>echo \"line1\\nline2\\nline3\"<CR>");
    s.wait_screen("Press ENTER");
    let screen = s.screen();
    let tail: Vec<&str> = screen[9..].iter().map(|l| l.trim_end()).collect();
    // separator row (fill char ' '), then the message grid
    assert_eq!(
        tail,
        [
            "",
            "line1",
            "line2",
            "line3",
            "Press ENTER or type command to continue"
        ]
    );
    s.input("<CR>");
    s.wait_for("message gone", |ui| {
        !ui.screen_lines().iter().any(|l| l.contains("line1"))
    });
}

#[test]
fn caret_has_one_fixed_color_on_a_colored_token() {
    let s = Session::start(
        "proj",
        Opts {
            args: &["a.ts"],
            ..Default::default()
        },
    );
    s.wait_screen("export const a = 1;");
    // `export` is a keyword (colored); the caret on it keeps WebStorm's caret color
    let under = |ui: &vimstorm::nvim::UiState| {
        let g = ui.grids.get(&ui.cursor.grid)?;
        let cell = g.cell(ui.cursor.row, ui.cursor.col)?;
        Some((cell.text.clone(), ui.colors(cell.hl).0))
    };
    s.wait_for("caret on the colored `e` of export", |ui| {
        under(ui)
            .is_some_and(|(t, fg)| t == vimstorm::nvim::CellText::Char('e') && fg != ui.default_fg)
    });
    for mode in ["normal", "insert"] {
        if mode == "insert" {
            s.input("i");
            s.wait_for("insert mode", |ui| ui.mode == "insert");
        }
        let (fill, text, fg, bg) = s.ui(|ui| {
            let caret = ui.caret().expect("caret");
            let (fill, text) = ui.caret_colors(caret.attr_id);
            (fill, text, under(ui).unwrap().1, ui.default_bg)
        });
        assert_eq!(fill, vimstorm::nvim::CARET_COLOR, "{mode}: caret fill");
        assert_ne!(fill, fg, "{mode}: not the token's color");
        assert_eq!(text, bg, "{mode}: char under the caret in the editor bg");
    }
}

/// How the editor draws a selection, diagnostics, semantic colors and the matched bracket, read
/// from the grid cells on the real Workspace (vtsls for the LSP colors). Keys go straight to nvim
/// (`nvim_input`) except Cmd+W, a real keystroke.
mod editor_look {
    use super::{LSP_TIMEOUT, common, hl_at, poll};
    use std::collections::BTreeMap;
    use std::path::Path;
    use std::time::Duration;

    use common::view::View;

    fn project(prefix: &str, files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::Builder::new().prefix(prefix).tempdir().unwrap();
        for (name, text) in files {
            let path = dir.path().join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        dir
    }

    fn start(dir: &Path, file: &str) -> View {
        let v = View::start(dir.to_str().unwrap(), &[file]);
        v.lua(&format!("vim.cmd.edit('{file}') return true"));
        v
    }

    /// Keys in nvim notation straight to nvim (`nvim_input`).
    fn input(v: &View, keys: &str) {
        v.request("nvim_input", vec![keys.into()]);
    }

    fn at(v: &View, line: usize, col: usize) {
        v.lua(&format!(
            "vim.api.nvim_win_set_cursor(0, {{ {line}, {col} }}) return true"
        ));
    }

    // Selection drawn as a block -----------------------------------------------------------------------

    const SEL_TS: &[&str] = &[
        "const getPeriod = (startDate: Date, endDate: Date) => {",
        "  const period = {",
        "    from: format(startDate, 'YYYY-MM-DD'),",
        "    to: format(endDate, 'YYYY-MM-DD'),",
        "  };",
        "  return period;",
        "};",
    ];
    const LOOK_TS: &[&str] = &[
        "function a() {",
        "  const x = 1;",
        "  if (x) {",
        "    return foo(2);",
        "",
        "  }",
        "  return 3;",
        "}",
        "const z = 4;",
    ];

    /// The file in the split with its fixture text, normal mode, one caret, at the top.
    fn fresh(v: &mut View, name: &str, lines: &[&str]) {
        input(v, "<Esc><Esc>");
        let lines = lines
            .iter()
            .map(|l| format!("{l:?}"))
            .collect::<Vec<_>>()
            .join(", ");
        v.lua(&format!(
            "pcall(function() require('multicursor-nvim').clearCursors() end) \
             require('config.focus').editor() \
             vim.cmd('silent! wall') \
             vim.cmd('edit ' .. vim.fn.fnameescape('{name}')) \
             vim.api.nvim_buf_set_lines(0, 0, -1, false, {{ {lines} }}) \
             vim.cmd('normal! gg0') return true"
        ));
        v.wait_lua(
            &format!("{name} fresh"),
            &format!(
                "return vim.fn.expand('%:t') == '{name}' and vim.api.nvim_get_mode().mode == 'n'"
            ),
        );
    }

    /// Drawn selection of buffer lines `lnums` in the current split: one char per text column, "S" =
    /// the Visual bg in the app's grid cell, "." = not.
    fn looks(v: &mut View, visual: u32, lnums: &[i64]) -> BTreeMap<i64, String> {
        let mut out = BTreeMap::new();
        for &l in lnums {
            let p = v.lua(&format!(
                "local w = vim.api.nvim_get_current_win() local i = vim.fn.getwininfo(w)[1] \
                 return {{ vim.fn.screenpos(w, {l}, 1).row, i.wincol + i.textoff, i.wincol + i.width - 1 }}"
            ));
            let p: Vec<i64> = p
                .as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_i64().unwrap())
                .collect();
            let (row, c0, c1) = (p[0], p[1], p[2]);
            let s = v.ui(|ui| {
                (c0..=c1)
                    .map(|c| {
                        let bg = (row > 0)
                            .then(|| hl_at(ui, row as usize - 1, c as usize - 1))
                            .flatten()
                            .map(|hl| ui.colors(hl).1);
                        if bg == Some(visual) { 'S' } else { '.' }
                    })
                    .collect()
            });
            out.insert(l, s);
        }
        out
    }

    /// "2=SSS.12" style: trailing dots counted.
    fn show(lk: &BTreeMap<i64, String>) -> String {
        lk.iter()
            .map(|(l, s)| {
                let t = s.trim_end_matches('.');
                let dots = s.len() - t.len();
                if dots > 0 {
                    format!("{l}={t}.{dots}")
                } else {
                    format!("{l}={t}")
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn full(s: &str) -> bool {
        !s.is_empty() && s.chars().all(|c| c == 'S')
    }

    fn none(s: &str) -> bool {
        !s.contains('S')
    }

    /// `n` dots, then the Visual color to the edge (`^.{n}S+$`).
    fn from_col(s: &str, n: usize) -> bool {
        s.len() > n && none(&s[..n]) && full(&s[n..])
    }

    /// `n` cells in the Visual color, then none (`^S{n}.+$`).
    fn up_to(s: &str, n: usize) -> bool {
        s.len() > n && full(&s[..n]) && !s[n..].contains('S')
    }

    /// Waits until the drawn selection of `lnums` passes `pred`.
    fn wait_looks(
        v: &mut View,
        visual: u32,
        lnums: &[i64],
        label: &str,
        pred: impl Fn(&BTreeMap<i64, String>) -> bool,
    ) -> BTreeMap<i64, String> {
        let mut last = BTreeMap::new();
        poll(v, label, Duration::from_secs(5), |v| {
            last = looks(v, visual, lnums);
            if pred(&last) {
                Ok(())
            } else {
                Err(show(&last))
            }
        });
        last
    }

    /// Selected text (visual mode), "" outside it.
    const SEL: &str = "local v, c = vim.fn.getpos('v'), vim.fn.getpos('.') \
        if not vim.fn.mode():match('^[vV]') then return '' end \
        if v[2] > c[2] or (v[2] == c[2] and v[3] > c[3]) then v, c = c, v end \
        local ec = vim.fn.mode() == 'V' and #vim.fn.getline(c[2]) or math.min(c[3], #vim.fn.getline(c[2])) \
        local sc = vim.fn.mode() == 'V' and 1 or v[3] \
        return table.concat(vim.api.nvim_buf_get_text(0, v[2] - 1, sc - 1, c[2] - 1, ec, {}), '\\n')";

    #[test]
    fn selection_drawn_as_block() {
        let dir = project(
            "vimstorm-parity-look-",
            &[
                ("sel.ts", &(SEL_TS.join("\n") + "\n")),
                ("look.ts", &(LOOK_TS.join("\n") + "\n")),
            ],
        );
        let mut v = start(dir.path(), "sel.ts");
        let visual = v
            .lua("return vim.api.nvim_get_hl(0, { name = 'Visual', link = false }).bg")
            .as_u64()
            .expect("Visual has a bg") as u32;

        // a selection with two carets, then Esc: no selection color left
        fresh(&mut v, "look.ts", LOOK_TS);
        input(&v, "2G<C-ö>");
        v.settle();
        input(&v, "v3G");
        v.settle();
        input(&v, "<Esc><Esc><Esc>");
        v.wait_lua("normal mode", "return vim.api.nvim_get_mode().mode == 'n'");
        wait_looks(
            &mut v,
            visual,
            &[2, 3, 4],
            "two carets with a selection, Esc: no selection color left",
            |lk| lk.values().all(|s| none(s)),
        );

        // v over lines: first row from the start to the edge, middle rows (empty too) full,
        // last row up to the caret (the caret's own cell isn't drawn in the Visual color)
        fresh(&mut v, "look.ts", LOOK_TS);
        input(&v, "3G5|v6G2|");
        wait_looks(&mut v, visual, &[3, 4, 5, 6], "v over lines", |lk| {
            from_col(&lk[&3], 4) && full(&lk[&4]) && full(&lk[&5]) && up_to(&lk[&6], 1)
        });
        input(&v, "<Esc>");
        wait_looks(
            &mut v,
            visual,
            &[3, 4, 5, 6],
            "Esc clears the selection block",
            |lk| lk.values().all(|s| none(s)),
        );
        input(&v, "2GV4G");
        wait_looks(
            &mut v,
            visual,
            &[1, 2, 3, 4, 5],
            "V: every selected row full width, nothing around",
            |lk| none(&lk[&1]) && full(&lk[&2]) && full(&lk[&3]) && full(&lk[&4]) && none(&lk[&5]),
        );
        input(&v, "<Esc>");

        // v upward, then o (other end) keeps the block
        input(&v, "7G3|v2G0");
        let rows = [2, 3, 4, 5, 6, 7];
        wait_looks(&mut v, visual, &rows, "v upward", |lk| {
            (2..=6).all(|r| full(&lk[&r])) && up_to(&lk[&7], 3)
        });
        input(&v, "o");
        wait_looks(
            &mut v,
            visual,
            &rows,
            "o (other end) keeps the block",
            |lk| (2..=6).all(|r| full(&lk[&r])) && up_to(&lk[&7], 2),
        );
        input(&v, "<Esc>");

        // Cmd+W moves the start without moving the caret: the block follows
        v.wait_lua("normal mode", "return vim.api.nvim_get_mode().mode == 'n'");
        input(&v, "4G7|");
        for _ in 0..6 {
            v.keystrokes("cmd-w");
            v.settle();
            if v.lua("return vim.fn.line('v') ~= vim.fn.line('.')")
                .as_bool()
                == Some(true)
            {
                break;
            }
        }
        let s = v.lua(
            "local v, c = vim.fn.getpos('v'), vim.api.nvim_win_get_cursor(0) \
             local sr, sc, er = v[2], v[3] - 1, c[1] \
             if sr > er or (sr == er and sc > c[2]) then sr, sc, er = er, c[2], sr end \
             return { sr, sc, er, vim.api.nvim_get_mode().mode }",
        );
        let s = s.as_array().unwrap();
        let (sr, sc, er) = (
            s[0].as_i64().unwrap(),
            s[1].as_i64().unwrap() as usize,
            s[2].as_i64().unwrap(),
        );
        let mode = s[3].as_str().unwrap().to_owned();
        assert!(er > sr, "Cmd+W reached several lines: {s:?}");
        let rows: Vec<i64> = (sr..=er - if mode == "V" { 0 } else { 1 }).collect();
        wait_looks(
            &mut v,
            visual,
            &rows,
            &format!("Cmd+W to several lines: drawn as a block too ({s:?})"),
            |lk| {
                rows.iter().all(|r| {
                    if *r == sr && mode == "v" {
                        from_col(&lk[r], sc)
                    } else {
                        full(&lk[r])
                    }
                })
            },
        );
        input(&v, "<Esc>");

        // the selection stays visible over other highlights
        fresh(&mut v, "sel.ts", SEL_TS);
        v.lua(
            "local ns = vim.api.nvim_create_namespace('test_hl') \
             vim.hl.range(0, ns, 'LspReferenceText', {1, 8}, {1, 14}, { priority = 200 }) \
             vim.diagnostic.set(ns, 0, {{ lnum = 5, col = 9, end_col = 15, severity = vim.diagnostic.severity.WARN, message = 'w' }}) \
             vim.fn.setreg('/', 'format') vim.o.hlsearch = true return true",
        );
        for (label, l, c, row_text, dx) in [
            (
                "selection drawn over the highlighted word under the caret",
                2,
                8,
                "const period",
                6,
            ),
            (
                "selection drawn over a search match",
                3,
                10,
                "from: format",
                6,
            ),
            ("selection drawn over a warning", 6, 9, "return period", 7),
        ] {
            at(&v, l, c);
            v.keystrokes("cmd-w");
            v.wait_lua(
                "a selection",
                &format!("return (function() {SEL} end)() ~= ''"),
            );
            // the last selected cell is the caret: the 5 before it
            poll(&mut v, label, Duration::from_secs(5), |v| {
                let (row, col) = v.cell_of(row_text);
                let bgs: Vec<u32> = v.ui(|ui| {
                    (0..5)
                        .map(|i| hl_at(ui, row, col + dx + i).map_or(0, |hl| ui.colors(hl).1))
                        .collect()
                });
                if bgs.iter().all(|&b| b == visual) {
                    Ok(())
                } else {
                    Err(format!("{visual:06x} vs {bgs:06x?}"))
                }
            });
            input(&v, "<Esc>");
            v.wait_lua("normal mode", "return vim.api.nvim_get_mode().mode == 'n'");
        }
    }

    // LSP: errors and semantic colors ------------------------------------------------------------------

    /// What a cell shows: fg, bold, italic, undercurl.
    #[derive(Debug, PartialEq)]
    struct Look {
        fg: u32,
        bold: bool,
        italic: bool,
        undercurl: bool,
    }

    /// The look of the cell `dx` columns into `text`'s first occurrence on screen.
    fn look_of(v: &mut View, text: &str, dx: usize) -> Option<Look> {
        let screen = v.screen();
        let (row, col) = screen
            .iter()
            .enumerate()
            .find_map(|(r, l)| Some((r, l[..l.find(text)?].chars().count())))?;
        v.ui(|ui| {
            let hl = hl_at(ui, row, col + dx)?;
            let a = ui.hl_attr(hl);
            Some(Look {
                fg: ui.colors(hl).0,
                bold: a.bold,
                italic: a.italic,
                undercurl: a.undercurl,
            })
        })
    }

    fn colored(fg: u32, bold: bool, italic: bool) -> impl Fn(&Option<Look>) -> bool {
        move |l| {
            l.as_ref()
                .is_some_and(|l| l.fg == fg && l.bold == bold && l.italic == italic)
        }
    }

    const GOLD: u32 = 0xffc66d;
    /// JS.GLOBAL_VARIABLE: #9876aa bold italic.
    const GLOBAL: u32 = 0x9876aa;
    const PLAIN: u32 = 0xa9b7c6;

    #[test]
    fn lsp_error_and_semantic_colors() {
        let dir = project(
            "vimstorm-parity-lsp-look-",
            &[
                (
                    "tsconfig.json",
                    r#"{ "compilerOptions": { "strict": true }, "include": ["**/*.ts"] }"#,
                ),
                (
                    "err.ts",
                    "export function period(start: Date) {\n  const range = {\n    from: quux(start, 'YYYY'),\n  };\n  return range;\n}\n",
                ),
                (
                    "zlike.ts",
                    "export const object = <T>(shape: T) => shape;\nexport const string = () => '';\n",
                ),
                (
                    "schema.ts",
                    "import * as z from './zlike';\nexport const schema = z.object({ name: z.string() });\n",
                ),
                (
                    "node_modules/zod/package.json",
                    r#"{ "name": "zod", "types": "./index.d.ts" }"#,
                ),
                (
                    "node_modules/zod/index.d.ts",
                    "import * as z from \"./external\";\nexport * from \"./external\";\nexport { z };\n",
                ),
                (
                    "node_modules/zod/external.d.ts",
                    "export declare class ZodLiteral<T> {\n  static create: <T extends string>(value: T, params?: { message?: string }) => ZodLiteral<T>;\n}\ndeclare const literalType: typeof ZodLiteral.create;\nexport declare function pick<T>(value: T): T;\nexport { literalType as literal };\n",
                ),
                (
                    "report.ts",
                    "import { z, pick } from 'zod';\nimport { gone } from 'nowhere';\nexport const dir = z.literal('ASC');\nexport const p = pick('P');\nexport const g = gone;\n",
                ),
            ],
        );
        let mut v = start(dir.path(), "err.ts");

        // the error is only a wavy underline: no inline text, no gutter letter
        poll(&mut v, "vtsls reports the error", LSP_TIMEOUT, |v| match v
            .lua("return #vim.diagnostic.get(0, { lnum = 2 }) > 0")
            .as_bool()
        {
            Some(true) => Ok(()),
            _ => Err("no diagnostic yet".into()),
        });
        poll(
            &mut v,
            "error: only a wavy underline in the code, no inline text or gutter letter",
            Duration::from_secs(5),
            |v| {
                let cell = look_of(v, "quux(", 0);
                let screen = v.screen();
                let row = screen
                    .iter()
                    .find(|l| l.contains("from: quux"))
                    .cloned()
                    .unwrap_or_default();
                let gutter = row.split("from: quux").next().unwrap_or_default().trim();
                let tail = row.split("'YYYY'),").nth(1).unwrap_or("x").trim();
                let ok = cell.as_ref().is_some_and(|c| c.undercurl)
                    && !screen.iter().any(|l| l.contains("Cannot find"))
                    && gutter == "3"
                    && tail.is_empty();
                if ok {
                    Ok(())
                } else {
                    Err(format!("{cell:?} {row:?}"))
                }
            },
        );

        // member calls of function exports stay gold once semantic tokens are in
        v.lua("vim.cmd.edit('schema.ts') return true");
        poll(
            &mut v,
            "member call of a function export (z.object, z.string) stays gold after semantic tokens",
            LSP_TIMEOUT,
            |v| {
                if v.lua("return #vim.inspect_pos(0, 1, 24).semantic_tokens > 0")
                    .as_bool()
                    != Some(true)
                {
                    return Err("no semantic tokens yet".into());
                }
                let gold = (
                    look_of(v, "object(", 0).map(|l| l.fg),
                    look_of(v, "string()", 0).map(|l| l.fg),
                );
                if gold == (Some(GOLD), Some(GOLD)) {
                    Ok(())
                } else {
                    Err(format!("{gold:06x?}"))
                }
            },
        );
        poll(
            &mut v,
            "`import * as z`: z purple bold italic (module namespace = global variable)",
            Duration::from_secs(10),
            |v| {
                let l = look_of(v, "z.object", 0);
                if colored(GLOBAL, true, true)(&l) {
                    Ok(())
                } else {
                    Err(format!("{l:?}"))
                }
            },
        );

        // zod's `import { z }` purple bold italic where imported and used; an unresolved
        // import stays plain
        v.lua("vim.cmd.edit('report.ts') return true");
        poll(
            &mut v,
            "zod namespace import z: purple bold italic where imported and where used",
            LSP_TIMEOUT,
            |v| {
                let (used, imported) = (look_of(v, "z.literal", 0), look_of(v, "{ z,", 2));
                if colored(GLOBAL, true, true)(&used) && colored(GLOBAL, true, true)(&imported) {
                    Ok(())
                } else {
                    Err(format!("{used:?} / {imported:?}"))
                }
            },
        );
        let gone = look_of(&mut v, "{ gone }", 2);
        assert!(
            colored(PLAIN, false, false)(&gone),
            "unresolved import stays plain text: {gone:?}"
        );
    }

    /// The matching bracket gets WebStorm's matched-brace background (config/autocmds.lua runs Vim's
    /// matchparen right after the frame, not before it): on a caret move onto a bracket, gone once the
    /// caret leaves it.
    #[test]
    fn matching_bracket_highlighted_after_the_frame() {
        const MATCHED: u32 = 0x326146;
        let dir = project("vimstorm-plook-paren-", &[("a.ts", "")]);
        let mut v = start(dir.path(), "a.ts");
        fresh(&mut v, "a.ts", LOOK_TS);
        let bg = |v: &mut View, text: &str, dx: usize| -> Option<u32> {
            let screen = v.screen();
            let (row, col) = screen
                .iter()
                .enumerate()
                .find_map(|(r, l)| Some((r, l[..l.find(text)?].chars().count())))?;
            v.ui(|ui| Some(ui.colors(hl_at(ui, row, col + dx)?).1))
        };
        // the caret on foo's "(": its ")" (and the "(") matched
        at(&v, 4, 14);
        poll(
            &mut v,
            "foo( ) matched",
            Duration::from_secs(10),
            |v| match (bg(v, "foo(2)", 3), bg(v, "foo(2)", 5)) {
                (Some(MATCHED), Some(MATCHED)) => Ok(()),
                other => Err(format!("( / ) backgrounds {other:x?}")),
            },
        );
        // off the bracket: no match drawn
        input(&v, "l");
        poll(
            &mut v,
            "match gone",
            Duration::from_secs(10),
            |v| match bg(v, "foo(2)", 5) {
                Some(c) if c != MATCHED => Ok(()),
                other => Err(format!(") background {other:x?}")),
            },
        );
    }
}

/// The colors drawn in the default look: syntax and editor colors from the grid cells (expected:
/// nvim/lua/darcula.lua), the native lists' selection pills from the painted quads and the git
/// status colors from the color a changes tree row's name is drawn in (expected:
/// app/src/look/theme.rs).
// GPUI records debug selectors only with debug assertions (rows are found by them).
#[cfg(debug_assertions)]
mod colors {
    use super::{LSP_TIMEOUT, common, hl_at, poll};
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::Duration;

    use common::gitui::{active, open_git, wait_target};
    use common::view::View;
    use gpui_kit::{Bounds, Pixels, Rgba, point, px, size};
    use vimstorm::editor::statusbar::Status;
    use vimstorm::git::window::TabId;
    use vimstorm::kit::RowKind;
    use vimstorm::look;

    /// The sample file: vtsls semantic tokens, treesitter (+ JSDoc / regex injections) and
    /// diagnostics layered.
    const SAMPLE: &[&str] = &[
        "import { useState } from 'react';", // 1
        "import { helper } from './helper';",
        "",
        "/**",
        " * Doc comment.", // 5
        " * @param name the name",
        " */",
        "export const API_URL = 'https://x';",
        "const LIMIT = 10;",
        "", // 10
        "export const Panel = ({ name }: { name: string }) => {",
        "  const [open, setOpen] = useState(false);",
        "  const items = [1, 2].map((n) => n * LIMIT);",
        "  helper(name);",
        "  console.log(`hi ${name}`, /ab+c/g);", // 15
        "  return (",
        "    <div className=\"panel\" onClick={() => setOpen(!open)}>",
        "      <Child value={items.length} />",
        "    </div>",
        "  );", // 20
        "};",
        "",
        "function localFn(a: number): number {",
        "  // plain comment",
        "  return a ?? 0;", // 25
        "}",
        "",
        "const Child = (p: { value: number }) => <i>{p.value}</i>;",
        "export const Use = () => <Child value={localFn(1)} />;",
        "function deadFn() {}", // 30
        "function memo<T>(fn: T): T { return fn; }",
        "export const wrapped = memo(localFn);",
        "enum Dir { UP = 1 }",
        "const opts = { wrapped, run: memo(localFn), size: Dir.UP } as const;",
        "export const used = [opts, Number(1), setTimeout(() => {}, 1), new Error('x')];", // 35
        "export class Box { static count = 0; get size() { return Box.count; } }",
        "export const shadow = (location: string) => location.length;",
    ];

    const TEXT: u32 = 0xa9b7c6;
    const KEYWORD: u32 = 0xcc7832;
    const STRING: u32 = 0x6a8759;
    const FUNC: u32 = 0xffc66d;
    const FIELD: u32 = 0x9876aa;
    const TAG: u32 = 0xe8bf6a;
    const ATTR: u32 = 0xbababa;
    const REGEXP: u32 = 0x6897bb;
    const TYPE_PARAM: u32 = 0x507874;

    /// Style to check: None = not checked, Some((bold, italic)).
    type Style = Option<(bool, bool)>;
    const PLAIN_STYLE: Style = Some((false, false));
    const BOLD_ITALIC: Style = Some((true, true));
    const ITALIC: Style = Some((false, true));

    /// The tokens to check: (what, line, text on that line, columns right of its start, fg, style,
    /// only once the language server answered).
    const SYNTAX: &[(&str, usize, &str, usize, u32, Style, bool)] = &[
        ("import keyword", 1, "import", 0, KEYWORD, None, false),
        ("string", 1, "'react'", 0, STRING, None, false),
        ("imported name plain", 1, "useState", 0, TEXT, None, false),
        (
            "doc comment green italic",
            5,
            "Doc",
            0,
            0x629755,
            ITALIC,
            false,
        ),
        (
            "exported const purple bold italic",
            8,
            "API_URL",
            0,
            FIELD,
            BOLD_ITALIC,
            false,
        ),
        ("ALL_CAPS const plain", 9, "LIMIT", 0, TEXT, None, false),
        (
            "exported arrow function gold, not bold / italic",
            11,
            "Panel",
            0,
            FUNC,
            PLAIN_STYLE,
            false,
        ),
        ("function call plain", 12, "useState", 0, TEXT, None, false),
        ("method call gold", 13, "map", 0, FUNC, None, false),
        ("comma orange", 13, ",", 0, KEYWORD, None, false),
        ("dot plain", 13, ".map", 0, TEXT, None, false),
        (
            "imported function call plain",
            14,
            "helper",
            0,
            TEXT,
            None,
            false,
        ),
        (
            "console global purple bold italic",
            15,
            "console",
            0,
            FIELD,
            BOLD_ITALIC,
            false,
        ),
        ("template ${ plain", 15, "${", 0, TEXT, None, false),
        ("regexp text blue", 15, "ab+c", 1, REGEXP, None, false),
        ("regexp quantifier blue", 15, "ab+c", 2, REGEXP, None, false),
        ("regexp flags blue", 15, "/g", 1, REGEXP, None, false),
        ("semicolon orange", 15, ");", 1, KEYWORD, None, false),
        ("JSX tag", 17, "div", 0, TAG, None, false),
        ("JSX attribute", 17, "className", 0, ATTR, None, false),
        ("JSX attribute value", 17, "panel", 0, STRING, None, false),
        ("JSX component tag", 18, "Child", 0, TAG, None, false),
        (
            "property access purple",
            18,
            "length",
            0,
            FIELD,
            None,
            false,
        ),
        (
            "function declaration gold",
            23,
            "localFn",
            0,
            FUNC,
            None,
            false,
        ),
        (
            "primitive type keyword",
            23,
            "number",
            0,
            KEYWORD,
            None,
            false,
        ),
        (
            "type annotation colon plain",
            23,
            ": number",
            0,
            TEXT,
            None,
            false,
        ),
        (
            "line comment gray, not italic",
            24,
            "plain",
            0,
            0x808080,
            Some((false, false)),
            false,
        ),
        (
            "resolved JSX component tag stays tag color",
            29,
            "Child",
            0,
            TAG,
            None,
            false,
        ),
        (
            "resolved JSX attribute stays attribute color",
            29,
            "value",
            0,
            ATTR,
            None,
            false,
        ),
        (
            "unused declaration gray",
            30,
            "deadFn",
            0,
            0x72737a,
            None,
            true,
        ),
        (
            "type parameter declaration",
            31,
            "T>",
            0,
            TYPE_PARAM,
            None,
            false,
        ),
        (
            "type parameter use",
            31,
            "T): T",
            4,
            TYPE_PARAM,
            None,
            false,
        ),
        (
            "const holding a call: exported variable, not a function",
            32,
            "wrapped",
            0,
            FIELD,
            BOLD_ITALIC,
            false,
        ),
        (
            "enum member declaration purple italic",
            33,
            "UP",
            0,
            FIELD,
            ITALIC,
            false,
        ),
        (
            "shorthand property is the variable",
            34,
            "wrapped",
            0,
            TEXT,
            PLAIN_STYLE,
            false,
        ),
        (
            "property holding a call purple, not a method",
            34,
            "run",
            0,
            FIELD,
            None,
            false,
        ),
        (
            "enum member access purple italic",
            34,
            "UP",
            0,
            FIELD,
            ITALIC,
            false,
        ),
        ("as const keyword", 34, "const;", 0, KEYWORD, None, false),
        ("lib class plain", 35, "Number", 0, TEXT, None, false),
        ("lib function gold", 35, "setTimeout", 0, FUNC, None, false),
        ("Error class plain", 35, "Error", 0, TEXT, None, false),
        (
            "static field declaration italic",
            36,
            "count",
            0,
            FIELD,
            ITALIC,
            false,
        ),
        ("getter declaration gold", 36, "size", 0, FUNC, None, false),
        (
            "parameter named like a lib global plain",
            37,
            "location",
            0,
            TEXT,
            PLAIN_STYLE,
            false,
        ),
    ];

    /// The semantic tokens are in (`API_URL`).
    const SEMANTIC: &str = "#vim.inspect_pos(0, 7, 13).semantic_tokens > 0";

    fn sh(dir: &Path, script: &str) {
        let out = Command::new("sh")
            .arg("-c")
            .arg(script)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "sh {script}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn write(dir: &Path, rel: &str, text: &str) {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    /// The sample repo: sample.tsx changed (line 2) and lines added, new.ts unversioned, the
    /// last commit modifies lib/mod.ts, adds lib/added.ts and deletes lib/old.ts; ignored.log and
    /// node_modules/ (excluded); a symlinked folder.
    fn project() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::Builder::new()
            .prefix("vimstorm-parity-look-")
            .tempdir()
            .unwrap();
        let dir = tmp.path().canonicalize().unwrap().join("look");
        let mut first: Vec<String> = SAMPLE[..29].iter().map(|s| s.to_string()).collect();
        first[1] = "import { helper } from './old';".into();
        write(&dir, "sample.tsx", &(first.join("\n") + "\n"));
        write(&dir, ".gitignore", "node_modules\n*.log\n");
        write(&dir, "lib/mod.ts", "export const m = 1;\n");
        write(&dir, "lib/old.ts", "export const o = 1;\n");
        sh(
            &dir,
            "git init -q -b main && git add -A && git -c user.name=T -c user.email=t@x commit -q -m 'First commit' \
             && echo 'export const m = 2;' > lib/mod.ts && echo 'export const n = 1;' > lib/added.ts && git rm -q lib/old.ts \
             && git add -A && git -c user.name=T -c user.email=t@x commit -q -m 'Second commit'",
        );
        write(&dir, "sample.tsx", &(SAMPLE.join("\n") + "\n"));
        write(&dir, "new.ts", "export const fresh = 1;\n");
        write(&dir, "ignored.log", "log\n");
        write(&dir, "node_modules/lib/index.js", "module.exports = {}\n");
        std::os::unix::fs::symlink(dir.join("lib"), dir.join("linked")).unwrap();
        (tmp, dir)
    }

    /// A wide window: every sample line fits.
    fn start(dir: &Path) -> View {
        let mut v = View::start(dir.to_str().unwrap(), &["sample.tsx"]);
        v.cx.simulate_resize(size(px(1500.), px(1150.)));
        v.wait_for("relaid out", |e| {
            e.geometry().layout.frame.viewport.height == px(1150.)
        });
        v.settle();
        v
    }

    // Editor grid cells ---------------------------------------------------------------------------------

    /// What a cell shows.
    #[derive(Debug, Clone, Copy, PartialEq)]
    struct Look {
        fg: u32,
        bg: u32,
        bold: bool,
        italic: bool,
    }

    fn look_at(v: &mut View, row: usize, col: usize) -> Option<Look> {
        v.ui(|ui| {
            let hl = hl_at(ui, row, col)?;
            let a = ui.hl_attr(hl);
            let (fg, bg, _) = ui.colors(hl);
            Some(Look {
                fg,
                bg,
                bold: a.bold,
                italic: a.italic,
            })
        })
    }

    /// Buffer line `lnum` of the current split on the screen: (0-based screen row, 0-based screen col
    /// of the first text cell (right of the gutter), 0-based col of the window's first cell).
    fn line_pos(v: &View, lnum: usize) -> (usize, usize, usize) {
        let p = v.lua(&format!(
            "local w = vim.api.nvim_get_current_win() local i = vim.fn.getwininfo(w)[1] \
             return {{ vim.fn.screenpos(w, {lnum}, 1).row, i.wincol + i.textoff, i.wincol }}"
        ));
        let p: Vec<i64> = p
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_i64().unwrap())
            .collect();
        assert!(p[0] > 0, "line {lnum} on screen");
        (p[0] as usize - 1, p[1] as usize - 1, p[2] as usize - 1)
    }

    /// Screen col of `text`'s first occurrence on screen row `row` at or right of col `from`.
    fn col_of(v: &mut View, row: usize, text: &str, from: usize) -> Option<usize> {
        let line: Vec<char> = v.screen().get(row)?.chars().collect();
        let tail: String = line.get(from..)?.iter().collect();
        let byte = tail.find(text)?;
        Some(from + tail[..byte].chars().count())
    }

    /// The look of the cell `dx` columns into `text` on buffer line `lnum`'s code.
    fn token(v: &mut View, lnum: usize, text: &str, dx: usize) -> Option<Look> {
        let (row, code, _) = line_pos(v, lnum);
        let c = col_of(v, row, text, code)?;
        look_at(v, row, c + dx)
    }

    /// The tokens not in their color / style (`before_lsp`: the
    /// server-only rows skipped).
    fn syntax_bad(v: &mut View, before_lsp: bool) -> Vec<String> {
        let mut bad = Vec::new();
        for &(label, lnum, text, dx, fg, style, lsp_only) in SYNTAX {
            if before_lsp && lsp_only {
                continue;
            }
            let l = token(v, lnum, text, dx);
            let ok = l.is_some_and(|l| {
                l.fg == fg && style.is_none_or(|(b, i)| l.bold == b && l.italic == i)
            });
            if !ok {
                bad.push(format!("{label}: {l:x?} (want {fg:06x} {style:?})"));
            }
        }
        bad
    }

    /// Waits for vtsls: semantic tokens and the unused-declaration diagnostic (line 30).
    fn wait_lsp(v: &mut View) {
        poll(v, "vtsls answered", LSP_TIMEOUT, |v| {
            match v
                .lua(&format!(
                    "return {SEMANTIC} and #vim.diagnostic.get(0, {{ lnum = 29 }}) > 0"
                ))
                .as_bool()
            {
                Some(true) => Ok(()),
                _ => Err("no semantic tokens / diagnostics yet".into()),
            }
        });
    }

    #[test]
    fn syntax_colors_darcula_contrast() {
        let (_tmp, dir) = project();
        let mut v = start(&dir);
        wait_lsp(&mut v);
        // the caret on an empty line: no word highlight over the sample
        v.lua("vim.api.nvim_win_set_cursor(0, { 3, 0 }) return true");
        poll(
            &mut v,
            "syntax colors: every sample token has its Darcula Contrast color (keywords, strings, functions, JSX, regexp, unused)",
            Duration::from_secs(10),
            |v| {
                let bad = syntax_bad(v, false);
                if bad.is_empty() {
                    Ok(())
                } else {
                    Err(bad.join("\n"))
                }
            },
        );
        // what is drawn before the semantic tokens arrive (treesitter) is already final: the server's
        // tokens switched off to see it
        v.lua("vim.lsp.semantic_tokens.enable(false, { bufnr = 0 }) return true");
        v.wait_lua("semantic tokens off", &format!("return not ({SEMANTIC})"));
        poll(
            &mut v,
            "syntax colors before the language server answers are already the final ones (no change seconds later)",
            Duration::from_secs(5),
            |v| {
                let bad = syntax_bad(v, true);
                if bad.is_empty() {
                    Ok(())
                } else {
                    Err(bad.join("\n"))
                }
            },
        );
    }

    /// code bg, line numbers, the caret row's number (not bold) and band, inlay hints.
    #[test]
    fn editor_gutter_and_inlay_colors() {
        let (_tmp, dir) = project();
        let mut v = start(&dir);
        wait_lsp(&mut v);
        v.lua("vim.api.nvim_win_set_cursor(0, { 3, 0 }) return true");
        // vtsls' parameter name hint: localFn(a: 1)
        poll(&mut v, "inlay hint drawn", LSP_TIMEOUT, |v| {
            if v.screen().iter().any(|l| l.contains("localFn(a: 1)")) {
                Ok(())
            } else {
                Err("no inlay hint yet".into())
            }
        });
        poll(
            &mut v,
            "editor colors: background, line numbers, caret row, inlay hints",
            Duration::from_secs(5),
            |v| {
                let (r9, code9, win9) = line_pos(v, 9);
                let (r3, code3, win3) = line_pos(v, 3);
                let (r29, code29, _) = line_pos(v, 29);
                let lnr9 = col_of(v, r9, "9", win9).filter(|c| *c < code9);
                let lnr3 = col_of(v, r3, "3", win3).filter(|c| *c < code3);
                let hint = col_of(v, r29, "a: 1", code29);
                let limit = col_of(v, r9, "LIMIT", code9);
                let checks = [
                    (
                        "code bg",
                        limit.and_then(|c| look_at(v, r9, c)).map(|l| l.bg),
                        0x1e1f22,
                    ),
                    (
                        "line number",
                        lnr9.and_then(|c| look_at(v, r9, c)).map(|l| l.fg),
                        0x4e5157,
                    ),
                    (
                        "caret row number",
                        lnr3.and_then(|c| look_at(v, r3, c)).map(|l| l.fg),
                        0x9da0a8,
                    ),
                    (
                        "caret row number not bold",
                        lnr3.and_then(|c| look_at(v, r3, c)).map(|l| l.bold as u32),
                        0,
                    ),
                    (
                        "caret row bg",
                        look_at(v, r3, code3 + 8).map(|l| l.bg),
                        0x2b2d30,
                    ),
                    (
                        "inlay hint",
                        hint.and_then(|c| look_at(v, r29, c)).map(|l| l.fg),
                        0x787878,
                    ),
                    (
                        "inlay hint bg",
                        hint.and_then(|c| look_at(v, r29, c)).map(|l| l.bg),
                        0x3b3b3b,
                    ),
                ];
                let bad: Vec<String> = checks
                    .iter()
                    .filter(|(_, got, want)| *got != Some(*want))
                    .map(|(l, got, want)| format!("{l}: {got:x?} (want {want:06x})"))
                    .collect();
                if bad.is_empty() {
                    Ok(())
                } else {
                    Err(bad.join(", "))
                }
            },
        );
    }

    // Native selection quads ----------------------------------------------------------------------------

    fn bounds(v: &mut View, selector: &str) -> Option<Bounds<Pixels>> {
        v.pump();
        v.cx.debug_bounds(Box::leak(selector.to_owned().into_boxed_str()))
    }

    /// A painted quad of `color` spanning `row`'s height (logical px): (left, right, corner radius)
    /// relative to the row's left / right edges (insets), or None.
    fn quad_in_row(v: &mut View, row: Bounds<Pixels>, color: Rgba) -> Option<(f32, f32, f32)> {
        v.pump();
        v.cx.update(|window, _| {
            let s = window.scale_factor();
            let near = |a: f32, b: f32| (a - b).abs() < 1.5;
            let (top, h) = (row.top().as_f32() * s, row.size.height.as_f32() * s);
            let (left, right) = (row.left().as_f32() * s, row.right().as_f32() * s);
            window.painted_quads().into_iter().find_map(|q| {
                let b = q.bounds;
                let fits = q.background.as_solid() == Some(look::hsla(color))
                    && near(b.origin.y.0, top)
                    && near(b.size.height.0, h)
                    && b.origin.x.0 >= left - 1.
                    && b.origin.x.0 + b.size.width.0 <= right + 1.;
                fits.then(|| {
                    (
                        (b.origin.x.0 - left) / s,
                        (right - b.origin.x.0 - b.size.width.0) / s,
                        q.corner_radii.top_left.0 / s,
                    )
                })
            })
        })
    }

    fn tree_row(v: &mut View, rel: &str) -> Bounds<Pixels> {
        let tree = v.read_ws(|ws, _| ws.tree().clone());
        let ix = tree
            .read_with(&v.cx, |t, _| t.row_index(rel))
            .unwrap_or_else(|| panic!("{rel} not shown"));
        bounds(v, &format!("tree-row-{ix}")).unwrap_or_else(|| panic!("{rel}'s row not drawn"))
    }

    fn tree_select(v: &mut View, rel: &str) {
        let tree = v.read_ws(|ws, _| ws.tree().clone());
        let rel2 = rel.to_owned();
        v.cx.update(|window, cx| {
            tree.update(cx, |t, cx| {
                let p = t.root().join(&rel2);
                t.test_select(&p, window, cx)
            })
        });
        v.wait_until(&format!("{rel} selected"), |v| {
            let t = v.read_ws(|ws, _| ws.tree().clone());
            t.read_with(&v.cx, |t, _| t.cursor()).as_deref() == Some(rel)
        });
    }

    /// The tree's pill on `rel`: `color`, inset SELECTION_INSET_X both sides, round ends.
    fn tree_pill(v: &mut View, rel: &str, color: Rgba, label: &str) {
        tree_select(v, rel);
        let mut last = None;
        v.wait_until(label, |v| {
            let row = tree_row(v, rel);
            last = quad_in_row(v, row, color);
            last.is_some()
        });
        let (l, r, arc) = last.unwrap();
        assert!(
            (l - look::SELECTION_INSET_X).abs() < 1. && (r - look::SELECTION_INSET_X).abs() < 1.,
            "{label}: inset {l} / {r}"
        );
        assert!(
            (arc - look::SELECTION_ARC).abs() < 0.5,
            "{label}: round ends {arc}"
        );
    }

    /// The excluded tint across the whole row.
    fn excluded_tint(v: &mut View, rel: &str) -> bool {
        let row = tree_row(v, rel);
        quad_in_row(v, row, look::EXCLUDED_ROW_BG.rgba())
            .is_some_and(|(l, r, _)| l.abs() < 1. && r.abs() < 1.)
    }

    fn wait_target_is(v: &mut View, want: &str) {
        wait_target(v, want);
    }

    fn open_log(v: &mut View) {
        open_git(v);
        for _ in 0..3 {
            if active(v) == TabId::Log {
                break;
            }
            v.keystrokes("alt-cmd-right");
        }
        v.wait_until("Log rows", |v| {
            active(v) == TabId::Log
                && v.read_ws(|ws, cx| {
                    let l = ws.git().read(cx).log().read(cx);
                    !l.loading && !l.model.is_empty() && l.rows_painted_at.is_some()
                })
        });
    }

    /// The selected commit's pill in the Log: (insets, radius) of a `color` quad on its row.
    fn log_pill(v: &mut View, color: Rgba) -> Option<(f32, f32, f32)> {
        let ix = v.read_ws(|ws, cx| ws.git().read(cx).log().read(cx).model.cursor())?;
        let subject = bounds(v, &format!("git-log-subject-{ix}"))?;
        let git = v.read(|e| {
            e.geometry()
                .role_rect(vimstorm::shell::Role::Git)
                .map(|r| r.island)
        })?;
        v.pump();
        // match the quad by the row band (the table's row is VCS_LOG_ROW_HEIGHT tall around it)
        v.cx.update(|window, _| {
            let s = window.scale_factor();
            let cy = subject.center().y.as_f32() * s;
            window.painted_quads().into_iter().find_map(|q| {
                let b = q.bounds;
                let ok = q.background.as_solid() == Some(look::hsla(color))
                    && b.origin.y.0 <= cy
                    && b.origin.y.0 + b.size.height.0 >= cy
                    && (b.size.height.0 / s - look::VCS_LOG_ROW_HEIGHT).abs() < 1.
                    && b.origin.x.0 / s >= git.left().as_f32()
                    && (b.origin.x.0 + b.size.width.0) / s <= git.right().as_f32();
                ok.then(|| {
                    (
                        b.origin.x.0 / s - git.left().as_f32(),
                        b.size.width.0 / s,
                        q.corner_radii.top_left.0 / s,
                    )
                })
            })
        })
    }

    #[test]
    fn selection_colors_tree_log_menu() {
        let (_tmp, dir) = project();
        let mut v = start(&dir);

        // the tree focused: blue pills; node_modules keeps its tint around the pill
        v.key("super+digit_1");
        wait_target_is(&mut v, "tree");
        tree_pill(
            &mut v,
            "node_modules",
            look::SELECTION_BG.rgba(),
            "tree focused: blue pill on the selected excluded row (node_modules)",
        );
        assert!(
            excluded_tint(&mut v, "node_modules"),
            "its tint around the pill"
        );
        tree_pill(
            &mut v,
            "ignored.log",
            look::SELECTION_BG.rgba(),
            "tree focused: blue pill on the selected ignored file",
        );
        tree_pill(
            &mut v,
            "sample.tsx",
            look::SELECTION_BG.rgba(),
            "tree focused: blue pill on the selected file",
        );
        assert!(
            excluded_tint(&mut v, "node_modules"),
            "excluded row keeps its tint when not selected"
        );
        let nm = tree_row(&mut v, "node_modules");
        assert!(
            quad_in_row(&mut v, nm, look::SELECTION_BG.rgba()).is_none(),
            "no pill on the unselected excluded row"
        );

        // Shift+↓ ×2: every selected row gets the pill, the rest none
        tree_select(&mut v, "ignored.log");
        v.key("shift+arrow_down");
        v.key("shift+arrow_down");
        v.wait_until("three selected", |v| {
            let t = v.read_ws(|ws, _| ws.tree().clone());
            t.read_with(&v.cx, |t, _| t.selected().len()) == 3
        });
        for rel in ["ignored.log", "new.ts", "sample.tsx"] {
            let row = tree_row(&mut v, rel);
            assert!(
                quad_in_row(&mut v, row, look::SELECTION_BG.rgba()).is_some(),
                "Shift+↓ in the tree: every selected row is drawn as a blue pill ({rel})"
            );
        }
        let gi = tree_row(&mut v, ".gitignore");
        assert!(
            quad_in_row(&mut v, gi, look::SELECTION_BG.rgba()).is_none(),
            ".gitignore not selected"
        );
        v.key("l"); // a plain move: one selected row again

        // the tree not focused: gray pills
        v.focus_code();
        wait_target_is(&mut v, "split");
        tree_pill(
            &mut v,
            "node_modules",
            look::SELECTION_BG_INACTIVE.rgba(),
            "tree not focused: gray pill on the selected excluded row",
        );
        tree_pill(
            &mut v,
            "sample.tsx",
            look::SELECTION_BG_INACTIVE.rgba(),
            "tree not focused: gray pill on the selected file",
        );

        // the Log: the selected commit blue while it has the keyboard, gray when not
        open_log(&mut v);
        let mut pill = None;
        v.wait_until("Log focused: selected commit is a blue pill", |v| {
            pill = log_pill(v, look::SELECTION_BG.rgba());
            pill.is_some()
        });
        let (inset, width, arc) = pill.unwrap();
        assert!(
            (arc - look::VCS_LOG_SELECTION_ARC).abs() < 0.5,
            "round ends: {arc}"
        );
        assert!(inset > 0. && width > 50., "inset in the table: {pill:?}");
        v.focus_code();
        wait_target_is(&mut v, "split");
        v.wait_until("Log not focused: selected commit is a gray pill", |v| {
            log_pill(v, look::SELECTION_BG_INACTIVE.rgba()).is_some()
        });

        // the context menu: the selected item is a blue pill inset in the popup
        v.keystrokes("cmd-enter");
        let p = v.read_ws(|ws, _| ws.popups().clone());
        v.wait_until("menu", |v| {
            p.read_with(&v.cx, |p, _| p.menu_selected()).is_some()
        });
        let (sel, rows) = p.read_with(&v.cx, |p, _| (p.menu_selected(), p.menu_rows()));
        let ix = rows
            .unwrap()
            .iter()
            .position(|r| Some(r) == sel.as_ref())
            .unwrap();
        let row = bounds(&mut v, &format!("menu-row-{ix}")).expect("menu row drawn");
        // WebStorm's popup menu: a 22 px pill in the 24 px row pitch, 7 in from the item (8 from the edge)
        let pill_y = px(look::MENU_CONTEXT_SELECTION_Y);
        let pill_row = Bounds::new(
            point(row.origin.x, row.origin.y + pill_y),
            size(row.size.width, row.size.height - pill_y * 2.),
        );
        let q = quad_in_row(&mut v, pill_row, look::SELECTION_BG.rgba())
            .expect("context menu: selected item is a blue pill");
        assert!(
            (q.0 - look::MENU_CONTEXT_SELECTION_X).abs() < 1.
                && (q.1 - look::MENU_CONTEXT_SELECTION_X).abs() < 1.,
            "inset in the popup: {q:?}"
        );
        assert!(
            (q.2 - look::LIST_SELECTION_ARC).abs() < 0.5,
            "round ends on the popup bg: {q:?}"
        );
        v.key("escape");
    }

    // Git status colors ---------------------------------------------------------------------------------

    /// The changes tree of Local Changes / the Log's details: (name, its drawn color, a folder).
    fn changes_rows(
        v: &mut View,
        tree: &gpui_kit::Entity<vimstorm::kit::ListView<vimstorm::kit::ChangesTree>>,
    ) -> Vec<(String, Option<Rgba>, bool)> {
        v.pump();
        v.cx.read(|cx| {
            let d = &tree.read(cx).delegate;
            d.rows()
                .iter()
                .enumerate()
                .map(|(ix, r)| {
                    let name = match &r.kind {
                        RowKind::Group(g) => {
                            d.groups()[*g].title.clone().unwrap_or_default().to_string()
                        }
                        RowKind::Dir { name, .. } => name.clone(),
                        RowKind::File(fr) => d.file(*fr).name().to_owned(),
                        RowKind::Empty => String::new(),
                    };
                    (name, d.label_color(ix), r.is_folder())
                })
                .collect()
        })
    }

    fn color_of(rows: &[(String, Option<Rgba>, bool)], name: &str) -> Option<Rgba> {
        rows.iter().find(|r| r.0 == name).and_then(|r| r.1)
    }

    /// A theme color as hex.
    fn hex(c: Rgba) -> u32 {
        let b = |x: f32| (x * 255.).round() as u32;
        (b(c.r) << 16) | (b(c.g) << 8) | b(c.b)
    }

    fn status(v: &mut View) -> Status {
        v.read_ws(|ws, cx| ws.statusbar().read(cx).status().clone())
    }

    #[test]
    fn git_status_colors_in_changes_and_log() {
        let (_tmp, dir) = project();
        let mut v = start(&dir);
        v.lua("vim.cmd.edit('new.ts') return true");
        v.wait_until("status bar on new.ts", |v| status(v).file == "new.ts");

        // Local Changes: unversioned red, modified blue
        open_git(&mut v);
        v.wait_until("Local Changes", |v| active(v) == TabId::Changes);
        let tree = v.read_ws(|ws, cx| ws.git().read(cx).changes().read(cx).tree().clone());
        v.wait_until("Local Changes lists both", |v| {
            let r = changes_rows(v, &tree);
            color_of(&r, "new.ts").is_some() && color_of(&r, "sample.tsx").is_some()
        });
        let r = changes_rows(&mut v, &tree);
        assert_eq!(
            (color_of(&r, "new.ts"), color_of(&r, "sample.tsx")),
            (
                Some(look::GIT_UNTRACKED.rgba()),
                Some(look::GIT_MODIFIED.rgba())
            ),
            "Local Changes: unversioned file red, modified file blue: {r:?}"
        );
        assert_eq!(hex(look::GIT_UNTRACKED.rgba()), 0xe88f89);
        assert_eq!(hex(look::GIT_MODIFIED.rgba()), 0x70aeff);
        // Git has the keyboard, the status bar still shows the file
        wait_target(&mut v, "git");
        assert_eq!(
            status(&mut v).file,
            "new.ts",
            "Git tool window focused: status bar still shows the file"
        );

        // the Log's changed files of the last commit: modified blue, added green, deleted gray; the
        // folder plain with its chevron
        v.keystrokes("alt-cmd-right");
        for _ in 0..2 {
            if active(&mut v) == TabId::Log {
                break;
            }
            v.keystrokes("alt-cmd-right");
        }
        let details = v.read_ws(|ws, cx| {
            let d = ws.git().read(cx).log().read(cx).details.clone();
            d.read(cx).tree().clone()
        });
        v.wait_until("the Log's changed files", |v| {
            active(v) == TabId::Log && color_of(&changes_rows(v, &details), "old.ts").is_some()
        });
        let r = changes_rows(&mut v, &details);
        assert_eq!(
            (
                color_of(&r, "mod.ts"),
                color_of(&r, "added.ts"),
                color_of(&r, "old.ts")
            ),
            (
                Some(look::GIT_MODIFIED.rgba()),
                Some(look::GIT_ADDED.rgba()),
                Some(look::GIT_DELETED.rgba())
            ),
            "Log changed files: modified blue, added green, deleted gray: {r:?}"
        );
        assert_eq!(hex(look::GIT_ADDED.rgba()), 0x73bd79);
        assert_eq!(hex(look::GIT_DELETED.rgba()), 0x6f737a);
        let lib = r
            .iter()
            .find(|x| x.0.starts_with("lib"))
            .unwrap_or_else(|| panic!("the lib folder row: {r:?}"));
        assert!(lib.2, "the folder has a chevron: {lib:?}");
        assert_eq!(
            lib.1,
            Some(look::TEXT.rgba()),
            "the folder name plain: {lib:?}"
        );
    }
}

/// VS Code's minimap: on only with `editor.minimap` (the Feel vscode's), right of the code
/// split's grid, the file's lines coloured as treesitter colours them, the slider over the shown
/// lines while the pointer is over it; a click centres a line, a slider drag and the wheel scroll
/// the split. The real nvim + config, real mouse events.
mod minimap {
    use super::common;

    use common::view::View;
    use gpui_kit::{Bounds, Modifiers, MouseButton, Pixels, ScrollDelta, TouchPhase, point, px};
    use vimstorm::editor::minimap;

    /// A TypeScript file of `n` lines: keywords, strings and numbers.
    fn project(n: usize) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let mut text = String::new();
        for i in 0..n {
            if i % 10 == 0 {
                text.push('\n');
            } else {
                text.push_str(&format!(
                    "export const value{i} = \"text {i}\" + {i}; // note\n"
                ));
            }
        }
        std::fs::write(dir.path().join("long.ts"), text).unwrap();
        dir
    }

    fn start(n: usize) -> (View, tempfile::TempDir) {
        let dir = project(n);
        let mut v = View::start(dir.path().to_str().unwrap(), &["long.ts"]);
        v.wait_screen("export const value1 ");
        (v, dir)
    }

    fn win(v: &View) -> i64 {
        v.lua("return vim.api.nvim_get_current_win()")
            .as_i64()
            .unwrap()
    }

    fn topline(v: &View) -> i64 {
        v.lua("return vim.fn.line('w0') - 1").as_i64().unwrap()
    }

    fn minimap_on(v: &mut View, on: bool) {
        v.set_feel(|f| f.editor.minimap = on);
    }

    /// The split's minimap rect in the layout.
    fn rect(v: &mut View, win: i64) -> Option<Bounds<Pixels>> {
        v.read(|e| e.geometry().win_rect(win).and_then(|w| w.minimap))
    }

    fn grid_cols(v: &mut View, win: i64) -> usize {
        v.read(|e| e.geometry().win_rect(win).unwrap().request.0)
    }

    fn drawn(v: &mut View, win: i64) -> Option<(Bounds<Pixels>, usize, usize)> {
        let mm = v.read_ws(|ws, _| ws.minimap().clone());
        v.pump();
        mm.read_with(&v.cx, |m, _| {
            m.drawn()
                .into_iter()
                .find(|d| d.0 == win)
                .map(|d| (d.1, d.2, d.3))
        })
    }

    fn with_minimap<R>(
        v: &mut View,
        f: impl FnOnce(&vimstorm::editor::minimap::MinimapView) -> R,
    ) -> R {
        let mm = v.read_ws(|ws, _| ws.minimap().clone());
        v.pump();
        mm.read_with(&v.cx, |m, _| f(m))
    }

    fn wait_lines(v: &mut View, win: i64) {
        v.wait_until("Lua reported the window's lines", |v| {
            with_minimap(v, |m| m.shapes(win).is_some_and(|s| !s.lines.is_empty()))
        });
    }

    #[test]
    fn the_minimap_shows_only_with_its_setting_and_colours_the_lines_as_the_editor() {
        let (mut v, _dir) = start(300);
        let w = win(&v);
        // VimStorm: no minimap, the grid has the split's whole text area
        let full = grid_cols(&mut v, w);
        assert_eq!(rect(&mut v, w), None);
        assert_eq!(
            v.lua("return require('config.app.minimap').state().on")
                .as_bool(),
            Some(false)
        );
        minimap_on(&mut v, true);
        v.wait_until("a minimap rect at the split's right", |v| {
            rect(v, w).is_some()
        });
        let r = rect(&mut v, w).unwrap();
        let area = v.read(|e| e.geometry().win_rect(w).unwrap().grid_area);
        assert_eq!(r.left(), area.right());
        assert_eq!(r.top(), area.top());
        v.wait_until("nvim's grid narrowed by the minimap", |v| {
            v.read(|e| {
                let g = e.geometry().win_rect(w).unwrap().grid;
                e.ui().grids.get(&g).map(|g| g.width)
            }) == Some(grid_cols(v, w))
        });
        assert!(grid_cols(&mut v, w) < full);
        // Lua reports the lines with treesitter's colours: a keyword's differs from Normal's
        wait_lines(&mut v, w);
        v.wait_until("treesitter's colours in the palette", |v| {
            with_minimap(v, |m| m.shapes(w).is_some_and(|s| s.palette.len() > 2))
        });
        let (s, normal, keyword) = {
            let s = with_minimap(&mut v, |m| m.shapes(w).cloned().unwrap());
            let fg = |name: &str| {
                v.lua(&format!(
                    "return vim.api.nvim_get_hl(0, {{ name = '{name}', link = false }}).fg"
                ))
                .as_u64()
                .unwrap() as u32
            };
            (s, fg("Normal"), fg("@keyword.typescript"))
        };
        assert_eq!(s.total, 300);
        assert_eq!(s.from, 0);
        // line 1: `export const value1 = "text 1" + 1; // note`, the keyword `export` first
        let line = s.line(1).unwrap();
        assert_eq!(
            line.len(),
            "export const value1 = \"text 1\" + 1; // note".len()
        );
        let color = |i: usize| s.palette[(line[i] - b'!') as usize];
        assert_eq!(color(0), keyword);
        assert_ne!(color(0), normal);
        assert_eq!(line[6], b' ');
        // a blank line is empty
        assert_eq!(s.line(10).unwrap(), b"");
        // drawn: runs in two colours at least, the whole file fits (300 lines in the minimap)
        let (_, start, end) = drawn(&mut v, w).unwrap();
        assert_eq!((start, end), (0, 300));
        let runs = with_minimap(&mut v, |m| m.runs(w));
        assert!(runs.len() > 300, "{} runs", runs.len());
        let colours: std::collections::HashSet<_> =
            runs.iter().map(|(_, c)| format!("{c:?}")).collect();
        assert!(colours.len() >= 3, "{colours:?}");
        // an edit: reported again once typing rests
        let tick = s.tick;
        v.lua("vim.api.nvim_buf_set_lines(0, 0, 0, false, { 'let typed = 1' })");
        v.wait_until("the edit reported", |v| {
            with_minimap(v, |m| {
                m.shapes(w).is_some_and(|s| s.tick > tick && s.total == 301)
            })
        });
        let first = with_minimap(&mut v, |m| m.shapes(w).unwrap().line(0).unwrap().to_vec());
        assert_eq!(first.len(), "let typed = 1".len());
        // a split that's no code split (numbers off: no WebStorm gutter) leaves no room; back again it does
        v.lua("vim.wo.number = false require('config.gutter').sync_all() require('config.app.layout').sync()");
        v.wait_until("no minimap without the gutter", |v| rect(v, w).is_none());
        v.lua("vim.wo.number = true require('config.gutter').sync_all() require('config.app.layout').sync()");
        v.wait_until("the minimap back", |v| rect(v, w).is_some());
        // off again: no minimap, the grid gets its columns back, Lua stops
        minimap_on(&mut v, false);
        v.wait_until("the minimap gone", |v| rect(v, w).is_none());
        assert_eq!(grid_cols(&mut v, w), full);
        assert!(drawn(&mut v, w).is_none());
        v.wait_lua(
            "Lua told off",
            "return require('config.app.minimap').state().on == false",
        );
        assert!(v.nvim_errors().is_empty(), "{:?}", v.nvim_errors());
    }

    #[test]
    fn a_click_centres_its_line_dragging_the_slider_and_the_wheel_scroll_the_split() {
        let (mut v, _dir) = start(3000);
        let w = win(&v);
        minimap_on(&mut v, true);
        v.wait_until("a minimap", |v| drawn(v, w).is_some());
        wait_lines(&mut v, w);
        let (r, start, _) = drawn(&mut v, w).unwrap();
        assert_eq!(start, 0);
        // the lines on screen, as nvim's viewport says (botline is one past the last)
        let rows = v.read(|e| {
            let g = e.geometry().win_rect(w).unwrap().grid;
            let vp = e.ui().windows[&g].viewport.unwrap();
            (vp.botline - vp.topline) as usize
        });
        // the pointer over it shows the slider
        let mid = |y: f32| point(r.left() + px(10.), r.top() + px(y));
        assert!(!with_minimap(&mut v, |m| m.slider_shown(w)));
        v.cx.simulate_mouse_move(mid(300.), None, Modifiers::default());
        v.pump();
        assert!(with_minimap(&mut v, |m| m.slider_shown(w)));
        let slider = with_minimap(&mut v, |m| m.slider(w)).unwrap();
        assert_eq!(slider.top(), r.top());
        assert_eq!(slider.size.height, px((rows as f32 * 2.).floor()));
        // a click at line 200 (y 400 is past the slider): 200 in the middle of the split
        let y = 200. * minimap::LINE_H + 1.;
        assert!(y < r.size.height.as_f32());
        v.click(MouseButton::Left, mid(y));
        let want = 200 - rows as i64 / 2;
        v.wait_until("line 200 centred", |v| topline(v) == want);
        // the slider follows nvim's viewport
        v.wait_until("the slider moved", |v| {
            with_minimap(v, |m| m.slider(w)).unwrap().top() > r.top()
        });
        // a slider drag of 100 px: the ratio's lines on
        let layout = minimap::layout(r.size.height.as_f32(), want as usize, rows, 3000);
        let s = with_minimap(&mut v, |m| m.slider(w)).unwrap();
        let from = point(r.left() + px(10.), s.top() + px(5.));
        v.cx.simulate_mouse_down(from, MouseButton::Left, Modifiers::default());
        let to = point(from.x, from.y + px(100.));
        v.cx.simulate_mouse_move(to, MouseButton::Left, Modifiers::default());
        let dragged = minimap::top_for_drag(&layout, want as usize, 100., 3000) as i64;
        assert!(dragged > want + 200, "{dragged}");
        v.wait_until("dragged", |v| topline(v) == dragged);
        v.cx.simulate_mouse_up(to, MouseButton::Left, Modifiers::default());
        v.pump();
        // the minimap scrolled with it: Lua sends the lines it now shows
        v.wait_until("lines around the new view", |v| {
            let Some((_, start, end)) = drawn(v, w) else {
                return false;
            };
            with_minimap(v, |m| {
                m.shapes(w)
                    .is_some_and(|s| s.from <= start && s.from + s.lines.len() >= end)
            })
        });
        // the wheel over the minimap scrolls the split
        let before = topline(&v);
        v.scroll(
            mid(50.),
            ScrollDelta::Lines(point(0., -3.)),
            TouchPhase::Moved,
        );
        v.wait_until("wheel scrolled", |v| topline(v) > before);
        // a click on the minimap doesn't reach nvim as a click: the mode stays normal, no visual
        assert_eq!(v.mode(), "n");
        assert!(v.nvim_errors().is_empty(), "{:?}", v.nvim_errors());
    }
}

/// Local echo in a cloud workspace's editor: text typed in insert mode is drawn before the box's
/// Neovim draws it, and the screen ends as nvim draws it. The "box" here is this Mac's nvim behind
/// a wrapper (`launch`, as `g w`'s attach) that holds everything nvim writes back for
/// [`DELAY_MS`], as a far region's round trip does; keys reach it at once.
#[cfg(debug_assertions)]
mod local_echo {
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    use crate::common::view::View;

    /// How long the wrapper holds nvim's output (redraws, answers) back.
    const DELAY_MS: u64 = 500;

    /// `delay.py <ms> <argv…>`: runs argv with this stdin, writes its stdout `ms` later.
    const DELAY: &str = r#"import collections, os, subprocess, sys, threading, time
delay = float(sys.argv[1]) / 1000
child = subprocess.Popen(sys.argv[2:], stdout=subprocess.PIPE, bufsize=0)
queue, ready = collections.deque(), threading.Condition()
def read():
    while True:
        data = os.read(child.stdout.fileno(), 65536)
        with ready:
            queue.append((time.monotonic() + delay, data))
            ready.notify()
        if not data:
            return
threading.Thread(target=read, daemon=True).start()
while True:
    with ready:
        while not queue:
            ready.wait()
        due, data = queue.popleft()
    time.sleep(max(0.0, due - time.monotonic()))
    if not data:
        sys.exit(child.wait())
    os.write(1, data)
"#;

    fn project(text: &str) -> tempfile::TempDir {
        let dir = tempfile::Builder::new()
            .prefix("vimstorm-echo-")
            .tempdir()
            .unwrap();
        std::fs::write(dir.path().join("a.txt"), text).unwrap();
        dir
    }

    /// nvim started through the delaying wrapper, as a cloud workspace's `launch`.
    fn delayed(dir: &Path) -> impl FnOnce(&mut vimstorm::nvim::NvimConfig) {
        let script: PathBuf = dir.join("delay.py");
        std::fs::write(&script, DELAY).unwrap();
        move |cfg| {
            cfg.launch = Some(vec![
                "python3".into(),
                "-I".into(),
                script.display().to_string(),
                DELAY_MS.to_string(),
                cfg.nvim.display().to_string(),
                "--embed".into(),
            ]);
        }
    }

    fn line_with(lines: &[String], text: &str) -> bool {
        lines.iter().any(|l| l.contains(text))
    }

    /// Insert mode, nvim's answer to `i` in: echo predicts from here.
    fn insert(v: &mut View) {
        v.key("i");
        v.wait_for("insert mode, echo's barrier back", |e| {
            e.ui().mode == "insert" && !e.echo_waits()
        });
    }

    #[test]
    fn typed_text_shows_before_the_box_draws_it_and_ends_as_nvim_draws() {
        let dir = project("alpha one\n");
        let state = tempfile::tempdir().unwrap();
        let mut v = View::start_with(
            dir.path().to_str().unwrap(),
            &["a.txt"],
            delayed(state.path()),
        );
        assert!(v.read(|e| e.local_echo()));
        v.wait_screen("alpha one");
        insert(&mut v);
        let caret = v.read(|e| e.ui().cursor);

        let typed = Instant::now();
        for k in ["h", "e", "space", "j"] {
            v.key(k);
        }
        // a frame with it (the grid element draws echo's grid and caret)
        v.cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
        });
        let shown = v.read(|e| e.shown_screen_lines());
        let nvim = v.screen();
        // drawn before nvim's redraw is back: nvim's screen doesn't have it yet
        assert!(typed.elapsed() < Duration::from_millis(DELAY_MS));
        assert!(line_with(&shown, "he jalpha one"), "{}", shown.join("\n"));
        assert!(!line_with(&nvim, "he j"), "{}", nvim.join("\n"));
        let at = v.read(|e| e.shown_cursor());
        assert_eq!(
            (at.grid, at.row, at.col),
            (caret.grid, caret.row, caret.col + 4)
        );

        // Backspace over a predicted char takes it back
        v.key("backspace");
        let shown = v.read(|e| e.shown_screen_lines());
        assert!(line_with(&shown, "he alpha one"), "{}", shown.join("\n"));
        assert_eq!(v.read(|e| e.shown_cursor()).col, caret.col + 3);

        // nvim catches up: its own picture, the same text, each key typed once
        v.wait_for("nvim drew every key", |e| {
            e.echo_pending() == 0 && line_with(&e.ui().screen_lines(), "he alpha one")
        });
        assert_eq!(v.read(|e| e.shown_screen_lines()), v.screen());
        assert_eq!(v.read(|e| e.shown_cursor()), v.read(|e| e.ui().cursor));
        v.wait_lua(
            "typed once",
            "return vim.api.nvim_get_current_line() == 'he alpha one'",
        );
    }

    /// Echo predicts only text typed in insert mode in a box's editor: a key it does not predict drops
    /// what it drew, and a local editor never echoes.
    #[test]
    fn echo_predicts_only_insert_text_in_a_box_editor() {
        let dir = project("alpha one\n");
        let state = tempfile::tempdir().unwrap();
        let mut v = View::start_with(
            dir.path().to_str().unwrap(),
            &["a.txt"],
            delayed(state.path()),
        );
        v.wait_screen("alpha one");
        insert(&mut v);
        v.key("x");
        assert!(line_with(&v.read(|e| e.shown_screen_lines()), "xalpha one"));
        // Esc: nvim's picture until it draws the change itself
        v.key("escape");
        assert_eq!(v.read(|e| e.echo_pending()), 0);
        assert_eq!(v.read(|e| e.shown_screen_lines()), v.screen());
        v.wait_for("normal mode", |e| e.ui().mode == "normal");
        // normal mode: `x` deletes, nothing is predicted
        v.key("x");
        assert_eq!(v.read(|e| e.echo_pending()), 0);
        v.wait_lua(
            "x deleted a char",
            "return vim.api.nvim_get_current_line() == 'alpha one'",
        );
        assert_eq!(v.read(|e| e.shown_screen_lines()), v.screen());

        drop(v);
        // a local editor: nothing predicted
        let mut v = View::start(dir.path().to_str().unwrap(), &["a.txt"]);
        assert!(!v.read(|e| e.local_echo()));
        v.wait_screen("alpha one");
        v.key("i");
        v.wait_for("insert mode", |e| e.ui().mode == "insert");
        v.key("h");
        assert_eq!(v.read(|e| e.echo_pending()), 0);
        v.wait_lua(
            "typed",
            "return vim.api.nvim_get_current_line() == 'halpha one'",
        );
    }
}
