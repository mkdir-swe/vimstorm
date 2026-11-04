//! Typed `redraw` events (`:h ui-events`), parsed off the UI thread.
//!
//! Only the events the app attaches for: ext_linegrid + ext_multigrid + ext_hlstate (no
//! ext_cmdline / ext_messages / ext_popupmenu: nvim draws those on its grids). Anything else is
//! kept as [`RedrawEvent::Unknown`] so a newer nvim never breaks parsing.

use rmpv::Value;

/// Grid id (1 = the default grid).
pub type GridId = u64;

#[derive(Clone, Debug, PartialEq)]
pub enum RedrawEvent {
    SetTitle(String),
    ModeInfoSet {
        cursor_style_enabled: bool,
        modes: Vec<ModeInfo>,
    },
    OptionSet(String, Value),
    ModeChange {
        mode: String,
        mode_idx: usize,
    },
    MouseOn,
    MouseOff,
    BusyStart,
    BusyStop,
    Flush,
    Bell,
    VisualBell,
    Chdir(String),
    DefaultColorsSet {
        fg: Option<u32>,
        bg: Option<u32>,
        sp: Option<u32>,
    },
    HlAttrDefine {
        id: u32,
        attrs: HlAttr,
    },
    HlGroupSet {
        name: String,
        id: u32,
    },
    GridResize {
        grid: GridId,
        width: usize,
        height: usize,
    },
    GridClear {
        grid: GridId,
    },
    GridCursorGoto {
        grid: GridId,
        row: usize,
        col: usize,
    },
    GridLine {
        grid: GridId,
        row: usize,
        col_start: usize,
        cells: Vec<LineCell>,
    },
    GridScroll {
        grid: GridId,
        top: usize,
        bot: usize,
        left: usize,
        right: usize,
        rows: i64,
    },
    GridDestroy {
        grid: GridId,
    },
    WinPos {
        grid: GridId,
        win: i64,
        start_row: usize,
        start_col: usize,
        width: usize,
        height: usize,
    },
    WinFloatPos {
        grid: GridId,
        win: i64,
        anchor: Anchor,
        anchor_grid: GridId,
        anchor_row: f64,
        anchor_col: f64,
        mouse_enabled: bool,
        zindex: i64,
        compindex: i64,
        /// Absolute position nvim computed (0.12+); `None` from older nvims.
        screen_pos: Option<(f64, f64)>,
    },
    WinExternalPos {
        grid: GridId,
    },
    WinHide {
        grid: GridId,
    },
    WinClose {
        grid: GridId,
    },
    MsgSetPos {
        grid: GridId,
        row: usize,
        scrolled: bool,
        sep_char: String,
        zindex: i64,
        compindex: i64,
    },
    WinViewport {
        grid: GridId,
        win: i64,
        topline: i64,
        botline: i64,
        curline: i64,
        curcol: i64,
        line_count: i64,
        scroll_delta: i64,
    },
    WinViewportMargins {
        grid: GridId,
        win: i64,
        top: usize,
        bottom: usize,
        left: usize,
        right: usize,
    },
    Unknown(String),
}

/// One `[text, hl_id, repeat]` item of `grid_line`, with `hl_id` already carried over from the
/// previous item when nvim left it out.
#[derive(Clone, Debug, PartialEq)]
pub struct LineCell {
    pub text: String,
    pub hl: u32,
    pub repeat: usize,
}

/// `rgb_attrs` of `hl_attr_define`. Colors are 0xRRGGBB; `None` = use the default color.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct HlAttr {
    pub fg: Option<u32>,
    pub bg: Option<u32>,
    pub sp: Option<u32>,
    pub reverse: bool,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub undercurl: bool,
    pub underdouble: bool,
    pub underdotted: bool,
    pub underdashed: bool,
    pub strikethrough: bool,
    /// 0..=100, 0 = opaque.
    pub blend: u8,
    /// ext_hlstate: the final highlight group name (last `info` item), for tests / debugging.
    pub name: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CursorShape {
    #[default]
    Block,
    Horizontal,
    Vertical,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ModeInfo {
    pub cursor_shape: Option<CursorShape>,
    pub cell_percentage: Option<u32>,
    pub blinkwait: Option<u64>,
    pub blinkon: Option<u64>,
    pub blinkoff: Option<u64>,
    pub attr_id: Option<u32>,
    pub short_name: String,
    pub name: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Anchor {
    #[default]
    NW,
    NE,
    SW,
    SE,
}

/// Parses the params of one `redraw` notification (a list of `[name, args...]` batches).
/// Malformed events are logged and skipped.
pub fn parse_redraw(params: &[Value]) -> Vec<RedrawEvent> {
    let mut out = Vec::new();
    for batch in params {
        let Some(items) = batch.as_array() else {
            continue;
        };
        let Some(name) = items.first().and_then(Value::as_str) else {
            continue;
        };
        for args in &items[1..] {
            let args = args.as_array().map(Vec::as_slice).unwrap_or(&[]);
            match parse_event(name, args) {
                Some(ev) => out.push(ev),
                None => eprintln!("[vimstorm] bad redraw event {name}: {args:?}"),
            }
        }
    }
    out
}

fn parse_event(name: &str, a: &[Value]) -> Option<RedrawEvent> {
    use RedrawEvent as E;
    Some(match name {
        "set_title" => E::SetTitle(string(a, 0)?),
        "mode_info_set" => E::ModeInfoSet {
            cursor_style_enabled: a.first()?.as_bool()?,
            modes: a.get(1)?.as_array()?.iter().map(mode_info).collect(),
        },
        "option_set" => E::OptionSet(string(a, 0)?, a.get(1)?.clone()),
        "mode_change" => E::ModeChange {
            mode: string(a, 0)?,
            mode_idx: uint(a, 1)? as usize,
        },
        "mouse_on" => E::MouseOn,
        "mouse_off" => E::MouseOff,
        "busy_start" => E::BusyStart,
        "busy_stop" => E::BusyStop,
        "flush" => E::Flush,
        "bell" => E::Bell,
        "visual_bell" => E::VisualBell,
        "chdir" => E::Chdir(string(a, 0)?),
        "default_colors_set" => E::DefaultColorsSet {
            fg: color(a.first()?),
            bg: color(a.get(1)?),
            sp: color(a.get(2)?),
        },
        "hl_attr_define" => E::HlAttrDefine {
            id: uint(a, 0)? as u32,
            attrs: hl_attr(a.get(1)?, a.get(3)),
        },
        "hl_group_set" => E::HlGroupSet {
            name: string(a, 0)?,
            id: uint(a, 1)? as u32,
        },
        "grid_resize" => E::GridResize {
            grid: uint(a, 0)?,
            width: uint(a, 1)? as usize,
            height: uint(a, 2)? as usize,
        },
        "grid_clear" => E::GridClear { grid: uint(a, 0)? },
        "grid_cursor_goto" => E::GridCursorGoto {
            grid: uint(a, 0)?,
            row: uint(a, 1)? as usize,
            col: uint(a, 2)? as usize,
        },
        "grid_line" => {
            let mut hl = 0;
            let mut cells = Vec::new();
            for c in a.get(3)?.as_array()? {
                let c = c.as_array()?;
                let text = c.first()?.as_str()?.to_owned();
                if let Some(h) = c.get(1).and_then(Value::as_u64) {
                    hl = h as u32;
                }
                let repeat = c.get(2).and_then(Value::as_u64).unwrap_or(1) as usize;
                cells.push(LineCell { text, hl, repeat });
            }
            E::GridLine {
                grid: uint(a, 0)?,
                row: uint(a, 1)? as usize,
                col_start: uint(a, 2)? as usize,
                cells,
            }
        }
        "grid_scroll" => E::GridScroll {
            grid: uint(a, 0)?,
            top: uint(a, 1)? as usize,
            bot: uint(a, 2)? as usize,
            left: uint(a, 3)? as usize,
            right: uint(a, 4)? as usize,
            rows: int(a, 5)?,
        },
        "grid_destroy" => E::GridDestroy { grid: uint(a, 0)? },
        "win_pos" => E::WinPos {
            grid: uint(a, 0)?,
            win: handle(a.get(1)?)?,
            start_row: uint(a, 2)? as usize,
            start_col: uint(a, 3)? as usize,
            width: uint(a, 4)? as usize,
            height: uint(a, 5)? as usize,
        },
        "win_float_pos" => E::WinFloatPos {
            grid: uint(a, 0)?,
            win: handle(a.get(1)?)?,
            anchor: match a.get(2)?.as_str()? {
                "NE" => Anchor::NE,
                "SW" => Anchor::SW,
                "SE" => Anchor::SE,
                _ => Anchor::NW,
            },
            anchor_grid: uint(a, 3)?,
            anchor_row: float(a.get(4)?)?,
            anchor_col: float(a.get(5)?)?,
            mouse_enabled: a.get(6).and_then(Value::as_bool).unwrap_or(true),
            zindex: a.get(7).and_then(Value::as_i64).unwrap_or(50),
            compindex: a.get(8).and_then(Value::as_i64).unwrap_or(0),
            screen_pos: match (a.get(9).and_then(float), a.get(10).and_then(float)) {
                (Some(r), Some(c)) => Some((r, c)),
                _ => None,
            },
        },
        "win_external_pos" => E::WinExternalPos { grid: uint(a, 0)? },
        "win_hide" => E::WinHide { grid: uint(a, 0)? },
        "win_close" => E::WinClose { grid: uint(a, 0)? },
        "msg_set_pos" => E::MsgSetPos {
            grid: uint(a, 0)?,
            row: uint(a, 1)? as usize,
            scrolled: a.get(2)?.as_bool()?,
            sep_char: string(a, 3).unwrap_or_default(),
            zindex: a.get(4).and_then(Value::as_i64).unwrap_or(200),
            compindex: a.get(5).and_then(Value::as_i64).unwrap_or(i64::MAX),
        },
        "win_viewport" => E::WinViewport {
            grid: uint(a, 0)?,
            win: handle(a.get(1)?)?,
            topline: int(a, 2)?,
            botline: int(a, 3)?,
            curline: int(a, 4)?,
            curcol: int(a, 5)?,
            line_count: int(a, 6)?,
            scroll_delta: a.get(7).and_then(Value::as_i64).unwrap_or(0),
        },
        "win_viewport_margins" => E::WinViewportMargins {
            grid: uint(a, 0)?,
            win: handle(a.get(1)?)?,
            top: uint(a, 2)? as usize,
            bottom: uint(a, 3)? as usize,
            left: uint(a, 4)? as usize,
            right: uint(a, 5)? as usize,
        },
        other => E::Unknown(other.to_owned()),
    })
}

fn string(a: &[Value], i: usize) -> Option<String> {
    a.get(i)?.as_str().map(str::to_owned)
}

fn uint(a: &[Value], i: usize) -> Option<u64> {
    a.get(i)?.as_u64()
}

fn int(a: &[Value], i: usize) -> Option<i64> {
    a.get(i)?.as_i64()
}

fn float(v: &Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_i64().map(|i| i as f64))
}

/// -1 (or anything negative) = not set.
fn color(v: &Value) -> Option<u32> {
    v.as_i64().filter(|c| *c >= 0).map(|c| c as u32)
}

/// Window / buffer handles arrive as msgpack ext values holding an int.
pub(crate) fn handle(v: &Value) -> Option<i64> {
    match v {
        Value::Ext(_, data) => rmpv::decode::read_value(&mut data.as_slice())
            .ok()?
            .as_i64(),
        other => other.as_i64(),
    }
}

fn hl_attr(rgb: &Value, info: Option<&Value>) -> HlAttr {
    let mut h = HlAttr::default();
    if let Some(map) = rgb.as_map() {
        for (k, v) in map {
            let flag = v.as_bool().unwrap_or(false);
            match k.as_str().unwrap_or("") {
                "foreground" => h.fg = color(v),
                "background" => h.bg = color(v),
                "special" => h.sp = color(v),
                "reverse" => h.reverse = flag,
                "bold" => h.bold = flag,
                "italic" => h.italic = flag,
                "underline" => h.underline = flag,
                "undercurl" => h.undercurl = flag,
                "underdouble" => h.underdouble = flag,
                "underdotted" => h.underdotted = flag,
                "underdashed" => h.underdashed = flag,
                "strikethrough" => h.strikethrough = flag,
                "blend" => h.blend = v.as_u64().unwrap_or(0).min(100) as u8,
                _ => {}
            }
        }
    }
    h.name = info
        .and_then(Value::as_array)
        .and_then(|items| items.last())
        .and_then(|item| super::get(item, "hi_name"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    h
}

fn mode_info(v: &Value) -> ModeInfo {
    let mut m = ModeInfo::default();
    for (k, v) in v.as_map().map(Vec::as_slice).unwrap_or(&[]) {
        match k.as_str().unwrap_or("") {
            "cursor_shape" => {
                m.cursor_shape = match v.as_str() {
                    Some("horizontal") => Some(CursorShape::Horizontal),
                    Some("vertical") => Some(CursorShape::Vertical),
                    Some("block") => Some(CursorShape::Block),
                    _ => None,
                }
            }
            "cell_percentage" => m.cell_percentage = v.as_u64().map(|p| p as u32),
            "blinkwait" => m.blinkwait = v.as_u64(),
            "blinkon" => m.blinkon = v.as_u64(),
            "blinkoff" => m.blinkoff = v.as_u64(),
            "attr_id" => m.attr_id = v.as_u64().map(|p| p as u32),
            "short_name" => m.short_name = v.as_str().unwrap_or("").to_owned(),
            "name" => m.name = v.as_str().unwrap_or("").to_owned(),
            _ => {}
        }
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmpv::Value as V;

    fn s(x: &str) -> V {
        V::from(x)
    }
    fn arr(v: Vec<V>) -> V {
        V::Array(v)
    }
    fn win(n: i64) -> V {
        let mut data = Vec::new();
        rmpv::encode::write_value(&mut data, &V::from(n)).unwrap();
        V::Ext(1, data)
    }
    fn cell(text: &str, hl: u32, repeat: usize) -> LineCell {
        LineCell {
            text: text.into(),
            hl,
            repeat,
        }
    }

    /// Round-trips through msgpack bytes, like the reader thread sees them.
    fn parse(params: V) -> Vec<RedrawEvent> {
        let mut buf = Vec::new();
        rmpv::encode::write_value(&mut buf, &params).unwrap();
        let v = rmpv::decode::read_value(&mut buf.as_slice()).unwrap();
        parse_redraw(v.as_array().unwrap())
    }

    struct Decode {
        name: &'static str,
        batch: fn() -> V,
        want: fn() -> Vec<RedrawEvent>,
    }

    const DECODES: &[Decode] = &[
        Decode {
            name: "grid_line carries the last hl over and keeps repeat",
            batch: || {
                arr(vec![arr(vec![
                    s("grid_line"),
                    arr(vec![
                        V::from(2),
                        V::from(3),
                        V::from(4),
                        arr(vec![
                            arr(vec![s("a"), V::from(7)]),
                            arr(vec![s("b")]),
                            arr(vec![s(" "), V::from(0), V::from(5)]),
                            arr(vec![s("界"), V::from(9)]),
                            arr(vec![s("")]),
                        ]),
                        V::from(false),
                    ]),
                ])])
            },
            want: || {
                vec![RedrawEvent::GridLine {
                    grid: 2,
                    row: 3,
                    col_start: 4,
                    cells: vec![
                        cell("a", 7, 1),
                        cell("b", 7, 1),
                        cell(" ", 0, 5),
                        cell("界", 9, 1),
                        cell("", 9, 1),
                    ],
                }]
            },
        },
        Decode {
            name: "an event with several instances, then flush",
            batch: || {
                arr(vec![
                    arr(vec![
                        s("grid_cursor_goto"),
                        arr(vec![V::from(1), V::from(0), V::from(1)]),
                        arr(vec![V::from(2), V::from(5), V::from(6)]),
                    ]),
                    arr(vec![s("flush"), arr(vec![])]),
                ])
            },
            want: || {
                vec![
                    RedrawEvent::GridCursorGoto {
                        grid: 1,
                        row: 0,
                        col: 1,
                    },
                    RedrawEvent::GridCursorGoto {
                        grid: 2,
                        row: 5,
                        col: 6,
                    },
                    RedrawEvent::Flush,
                ]
            },
        },
        Decode {
            name: "hl_attr_define takes its name from the ui hlstate",
            batch: || {
                let rgb = V::Map(vec![
                    (s("foreground"), V::from(0xff0000)),
                    (s("special"), V::from(0x00ff00)),
                    (s("undercurl"), V::from(true)),
                    (s("bold"), V::from(true)),
                    (s("blend"), V::from(30)),
                ]);
                let info = arr(vec![V::Map(vec![
                    (s("kind"), s("ui")),
                    (s("ui_name"), s("NormalFloat")),
                    (s("hi_name"), s("NormalFloat")),
                ])]);
                arr(vec![arr(vec![
                    s("hl_attr_define"),
                    arr(vec![V::from(12), rgb, V::Map(vec![]), info]),
                ])])
            },
            want: || {
                vec![RedrawEvent::HlAttrDefine {
                    id: 12,
                    attrs: HlAttr {
                        fg: Some(0xff0000),
                        sp: Some(0x00ff00),
                        undercurl: true,
                        bold: true,
                        blend: 30,
                        name: Some("NormalFloat".into()),
                        ..Default::default()
                    },
                }]
            },
        },
        Decode {
            name: "default_colors_set with -1 is unset",
            batch: || {
                arr(vec![arr(vec![
                    s("default_colors_set"),
                    arr(vec![
                        V::from(0xbbbbbb),
                        V::from(-1),
                        V::from(-1),
                        V::from(0),
                        V::from(0),
                    ]),
                ])])
            },
            want: || {
                vec![RedrawEvent::DefaultColorsSet {
                    fg: Some(0xbbbbbb),
                    bg: None,
                    sp: None,
                }]
            },
        },
        Decode {
            name: "win_float_pos reads the window handle, anchor and screen pos",
            batch: || {
                arr(vec![arr(vec![
                    s("win_float_pos"),
                    arr(vec![
                        V::from(4),
                        win(1001),
                        s("SE"),
                        V::from(2),
                        V::from(10.0),
                        V::from(20.0),
                        V::from(true),
                        V::from(50),
                        V::from(3),
                        V::from(7.0),
                        V::from(12.0),
                    ]),
                ])])
            },
            want: || {
                vec![RedrawEvent::WinFloatPos {
                    grid: 4,
                    win: 1001,
                    anchor: Anchor::SE,
                    anchor_grid: 2,
                    anchor_row: 10.0,
                    anchor_col: 20.0,
                    mouse_enabled: true,
                    zindex: 50,
                    compindex: 3,
                    screen_pos: Some((7.0, 12.0)),
                }]
            },
        },
        Decode {
            name: "mode_info_set and mode_change",
            batch: || {
                let modes = arr(vec![
                    V::Map(vec![
                        (s("cursor_shape"), s("block")),
                        (s("cell_percentage"), V::from(0)),
                        (s("attr_id"), V::from(0)),
                        (s("short_name"), s("n")),
                        (s("name"), s("normal")),
                    ]),
                    V::Map(vec![
                        (s("cursor_shape"), s("vertical")),
                        (s("cell_percentage"), V::from(25)),
                        (s("attr_id"), V::from(5)),
                        (s("short_name"), s("i")),
                        (s("name"), s("insert")),
                    ]),
                ]);
                arr(vec![
                    arr(vec![s("mode_info_set"), arr(vec![V::from(true), modes])]),
                    arr(vec![s("mode_change"), arr(vec![s("insert"), V::from(1)])]),
                ])
            },
            want: || {
                vec![
                    RedrawEvent::ModeInfoSet {
                        cursor_style_enabled: true,
                        modes: vec![
                            ModeInfo {
                                cursor_shape: Some(CursorShape::Block),
                                cell_percentage: Some(0),
                                attr_id: Some(0),
                                short_name: "n".into(),
                                name: "normal".into(),
                                ..Default::default()
                            },
                            ModeInfo {
                                cursor_shape: Some(CursorShape::Vertical),
                                cell_percentage: Some(25),
                                attr_id: Some(5),
                                short_name: "i".into(),
                                name: "insert".into(),
                                ..Default::default()
                            },
                        ],
                    },
                    RedrawEvent::ModeChange {
                        mode: "insert".into(),
                        mode_idx: 1,
                    },
                ]
            },
        },
        Decode {
            name: "an unknown event is kept by name, a malformed one is skipped",
            batch: || {
                arr(vec![
                    arr(vec![s("some_future_event"), arr(vec![V::from(1)])]),
                    arr(vec![s("grid_clear"), arr(vec![s("not a grid")])]),
                    arr(vec![s("win_hide"), arr(vec![V::from(3)])]),
                ])
            },
            want: || {
                vec![
                    RedrawEvent::Unknown("some_future_event".into()),
                    RedrawEvent::WinHide { grid: 3 },
                ]
            },
        },
    ];

    #[test]
    fn redraw_batches_decode_to_events() {
        for row in DECODES {
            assert_eq!(parse((row.batch)()), (row.want)(), "{}", row.name);
        }
    }
}
