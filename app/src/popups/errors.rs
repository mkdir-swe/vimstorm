//! The error history (nothing is lost): every error balloon shown, newest first, with when
//! and where, so one that faded can be read again. The status bar's `⚠ N` (dim, never red: it is
//! no error that stays) opens it as a list; a row shows its balloon again, the last row clears it.

use gpui_kit::{
    AnyElement, App, CursorStyle, Global, InteractiveElement as _, IntoElement, MouseButton,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _, Window, div,
    px,
};

use super::{Balloon, Level, Menu, MenuEntry, MenuItem};
use crate::kit::Anchor;
use crate::look;

/// Errors kept at most (the oldest go first).
pub const KEPT: usize = 100;
/// A balloon shown again from the history: not recorded again.
const AGAIN: &str = "history:";

/// One error as it was said.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    /// `HH:MM` local time, of the last time it was said.
    pub at: String,
    /// Where: the balloon's source, else its title (`Abe · factory`, `Git`).
    pub source: String,
    pub text: String,
    /// Said this many times in a row.
    pub times: u32,
}

/// The errors said so far, oldest first.
#[derive(Default)]
pub struct ErrorLog(pub Vec<Entry>);

impl Global for ErrorLog {}

/// The history, newest first.
pub fn entries(cx: &App) -> Vec<Entry> {
    cx.try_global::<ErrorLog>()
        .map(|l| l.0.iter().rev().cloned().collect())
        .unwrap_or_default()
}

/// Keeps an error balloon in the history (any other level: nothing); the same words again from the
/// same place just count again.
pub fn record(b: &Balloon, cx: &mut App) {
    if b.level != Level::Error || b.id.as_deref().is_some_and(|id| id.starts_with(AGAIN)) {
        return;
    }
    let source = b
        .source
        .clone()
        .or_else(|| b.title.clone())
        .map_or_else(|| "VimStorm".to_owned(), |s| s.to_string());
    record_error(&source, &b.body, cx);
}

/// Keeps an error said elsewhere than in a balloon (a cloud workspace's red card) in the history.
pub fn record_error(source: &str, text: &str, cx: &mut App) {
    let (source, text) = (source.to_owned(), text.to_owned());
    let stamp = crate::app::now_stamp();
    let at = stamp.get(11..16).unwrap_or(&stamp).to_owned();
    let log = cx.default_global::<ErrorLog>();
    match log.0.last_mut() {
        Some(last) if last.source == source && last.text == text => {
            last.times += 1;
            last.at = at;
        }
        _ => {
            log.0.push(Entry {
                at,
                source,
                text,
                times: 1,
            });
            if log.0.len() > KEPT {
                log.0.remove(0);
            }
        }
    }
    cx.refresh_windows();
}

/// The status bar's `⚠ N` while there is a history: a click lists it.
pub fn widget(cx: &App) -> Option<AnyElement> {
    let n = cx.try_global::<ErrorLog>().map_or(0, |l| l.0.len());
    if n == 0 {
        return None;
    }
    Some(
        div()
            .id("status-errors")
            .debug_selector(|| "status-errors".into())
            .flex_none()
            .h_full()
            .px(px(look::STATUS_BAR_WIDGET_PAD_X))
            .flex()
            .items_center()
            .cursor(CursorStyle::PointingHand)
            .hover(|s| s.bg(look::STATUS_BAR_HOVER_BG))
            .text_color(look::TEXT_DIM)
            .tooltip(crate::kit::tooltip(
                format!("{n} error{} said · click to read them again", plural(n)),
                None,
            ))
            .on_mouse_down(MouseButton::Left, |ev, window, cx| {
                cx.stop_propagation();
                open_list(Anchor::Point(ev.position), window, cx);
            })
            .child(SharedString::from(format!("⚠ {n}")))
            .into_any_element(),
    )
}

fn plural(n: usize) -> &'static str {
    if n == 1 { "" } else { "s" }
}

/// One line of an error's text, as a row says it.
fn first_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or_default()
        .to_owned()
}

/// The history as a list at `anchor`, newest first: a row's balloon shown again, or Clear.
pub fn open_list(anchor: Anchor, window: &mut Window, cx: &mut App) {
    let list = entries(cx);
    if list.is_empty() {
        return;
    }
    let mut rows: Vec<MenuEntry> = list
        .iter()
        .map(|e| {
            let times = if e.times > 1 {
                format!(" ×{}", e.times)
            } else {
                String::new()
            };
            let mut item = MenuItem::new(format!("{}{times}", first_line(&e.text)))
                .shortcut(format!("{} · {}", e.at, e.source));
            item.tooltip = Some(e.text.clone().into());
            MenuEntry::Item(item)
        })
        .collect();
    let clear = rows.len() + 1;
    rows.push(MenuEntry::Separator);
    rows.push(MenuEntry::Item(MenuItem::new("Clear the history")));
    let mut menu = Menu::new(rows, anchor).title("Errors · newest first");
    menu.max_rows = Some(14);
    menu.max_width = Some(px(640.));
    super::open_menu(menu, window, cx, move |chosen, window, cx| match chosen {
        Some(ix) if ix == clear => {
            cx.set_global(ErrorLog::default());
            cx.refresh_windows();
        }
        Some(ix) => {
            if let Some(e) = list.get(ix) {
                let again = Balloon {
                    id: Some(format!("{AGAIN}{ix}")),
                    ..Balloon::new(Level::Error, e.source.clone(), e.text.clone())
                };
                super::notify(again, window, cx);
            }
        }
        None => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_row_says_the_first_line() {
        assert_eq!(first_line("\n  Boom\n more"), "Boom");
        assert_eq!(plural(1), "");
        assert_eq!(plural(2), "s");
    }
}
