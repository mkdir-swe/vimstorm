//! The writing card of a PR diff (G21, DiffViewer "Review comment card": Writing): `,ic` / `,ip`
//! (and a draft's Edit draft, an outdated draft's Rewrite) open it under the line in the blank rows
//! `config/app/review.lua` keeps there; its multi-line field takes the keyboard. ⏎ keeps a draft
//! (`,ip`: posts now), ⌘⏎ the other one, ⇧⏎ a new line, Esc / Cancel nothing. The answer goes back
//! to Lua (`done(token, text, how)`), which sends it as the review bridge's comment / post_now / edit.
//!
//! Keys typed right after `,ic`, before the field has the keyboard, are held by nvim
//! (`config/app/typeahead.lua`, surface `git_review`): once the card is drawn and focused it calls
//! `focused(token)`, nvim answers `typeahead {token, keys}` and they are typed into the field before
//! anything typed there since (which waits in `queued` meanwhile), as the native input popup does.

use std::time::Duration;

use gpui_kit::{
    AppContext as _, Context, Entity, KeyDownEvent, Keystroke, Subscription, Task, Window,
};
use rmpv::Value;
use serde::Deserialize;

use crate::kit::{TextArea, TextAreaEvent};

/// Longest wait for nvim's typeahead answer before keys typed into the card go to it anyway.
const AWAIT_MAX: Duration = Duration::from_secs(1);

/// `write {…}` from `config/app/review.lua`: the card opened.
#[derive(Clone, Debug, Deserialize)]
pub struct WriteEvent {
    pub token: u64,
    pub path: String,
    pub side: String,
    pub line: u32,
    #[serde(default)]
    pub start_line: Option<u32>,
    #[serde(default)]
    pub body: String,
    /// The diff's right revision (the PR's head on All changes).
    #[serde(default)]
    pub new: String,
    #[serde(default)]
    pub post_now: bool,
    /// Edit draft: the draft's seq.
    #[serde(default)]
    pub edit: Option<u64>,
}

/// What the card's answer does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum How {
    /// Kept as a draft for Submit review.
    Draft,
    /// Posted now, alone.
    Post,
}

impl How {
    pub fn lua(self) -> &'static str {
        match self {
            How::Draft => "draft",
            How::Post => "post",
        }
    }
}

/// What a key in the card does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The field's (typing, ⇧⏎).
    Field,
    /// Held until nvim handed over the keys typed before.
    Queued,
    /// Nothing (⌘⏎ while editing a draft).
    Swallow,
    Finish(Option<How>),
}

pub struct Writing {
    pub token: u64,
    pub area: Entity<TextArea>,
    /// `Comment on line 19`, `Comment on lines 2–4`, `Edit draft on line 3`.
    pub title: String,
    /// `AddressForm.tsx · 9b3e7d10`.
    pub meta: String,
    /// ⏎ posts (`,ip`); else ⏎ keeps a draft.
    pub post_now: bool,
    /// Edit draft: only Save draft.
    pub edit: bool,
    focused: bool,
    awaiting: bool,
    queued: Vec<Keystroke>,
    await_task: Option<Task<()>>,
    _sub: Subscription,
}

/// The card's title for a comment on `line` (and from `start`).
pub fn title_of(line: u32, start: Option<u32>, edit: bool) -> String {
    match (edit, start.filter(|s| *s != line)) {
        (true, _) => format!("Edit draft on line {line}"),
        (false, Some(s)) => format!("Comment on lines {s}–{line}"),
        (false, None) => format!("Comment on line {line}"),
    }
}

impl Writing {
    pub fn new<T: 'static>(ev: &WriteEvent, cx: &mut Context<T>) -> Self {
        let area = cx.new(|cx| {
            let mut a = TextArea::new(cx).placeholder("Leave a comment");
            if !ev.body.is_empty() {
                a.set_text(ev.body.clone(), cx);
            }
            a
        });
        // the card grows with its text: the diff measures it again
        let sub = cx.subscribe(&area, |_, _, _: &TextAreaEvent, cx| cx.notify());
        let file = ev.path.rsplit('/').next().unwrap_or(&ev.path);
        let rev = crate::git::window::review::sha8(&ev.new);
        Writing {
            token: ev.token,
            area,
            title: title_of(ev.line, ev.start_line, ev.edit.is_some()),
            meta: if rev.is_empty() {
                file.to_owned()
            } else {
                format!("{file} · {rev}")
            },
            post_now: ev.post_now,
            edit: ev.edit.is_some(),
            focused: false,
            awaiting: false,
            queued: Vec::new(),
            await_task: None,
            _sub: sub,
        }
    }

    /// The card was drawn but its field doesn't have the keyboard yet.
    pub fn wants_focus(&self) -> bool {
        !self.focused
    }

    /// What ⏎ does.
    pub fn primary(&self) -> How {
        if self.post_now && !self.edit {
            How::Post
        } else {
            How::Draft
        }
    }

    /// What ⌘⏎ does (none while editing a draft).
    pub fn secondary(&self) -> Option<How> {
        match (self.edit, self.primary()) {
            (true, _) => None,
            (false, How::Draft) => Some(How::Post),
            (false, How::Post) => Some(How::Draft),
        }
    }

    /// The text as typed.
    pub fn text(&self, cx: &gpui_kit::App) -> String {
        self.area.read(cx).text().to_owned()
    }

    /// The field takes the keyboard; nvim hands over what it held (`focused(token)`). `release`
    /// runs after [`AWAIT_MAX`] when nvim never answers.
    pub fn focus<T: 'static>(
        &mut self,
        scx: &crate::shell::SurfaceCx,
        window: &mut Window,
        cx: &mut Context<T>,
        release: impl FnOnce(&mut T, &mut Window, &mut Context<T>) + 'static,
    ) {
        self.focused = true;
        self.awaiting = true;
        let handle = gpui_kit::Focusable::focus_handle(self.area.read(cx), cx);
        window.focus(&handle, cx);
        scx.call(
            "config.app.review",
            "focused",
            vec![Value::from(self.token)],
        );
        self.await_task = Some(cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(AWAIT_MAX).await;
            let _ = this.update_in(cx, |t, window, cx| release(t, window, cx));
        }));
    }

    /// A key before the field sees it.
    pub fn key(&mut self, ev: &KeyDownEvent) -> Outcome {
        if self.awaiting {
            self.queued.push(ev.keystroke.clone());
            return Outcome::Queued;
        }
        match crate::kit::notation(ev).as_deref() {
            Some("<CR>") => Outcome::Finish(Some(self.primary())),
            Some("<D-CR>") => match self.secondary() {
                Some(h) => Outcome::Finish(Some(h)),
                None => Outcome::Swallow,
            },
            Some("<Esc>") => Outcome::Finish(None),
            _ => Outcome::Field,
        }
    }

    /// Keys nvim held (in its notation), typed before anything typed into the field since; ⏎ /
    /// ⌘⏎ / Esc among them answer the card.
    pub fn typeahead<T: 'static>(
        &mut self,
        keys: &[String],
        window: &mut Window,
        cx: &mut Context<T>,
    ) -> Option<Option<How>> {
        let area = self.area.clone();
        for k in keys.iter().flat_map(|k| crate::search::split_keys(k)) {
            match k.as_str() {
                "<CR>" => return Some(Some(self.primary())),
                "<D-CR>" => {
                    if let Some(h) = self.secondary() {
                        return Some(Some(h));
                    }
                }
                "<Esc>" => return Some(None),
                "<S-CR>" => area.update(cx, |a, cx| a.insert("\n", cx)),
                "<Space>" => area.update(cx, |a, cx| a.insert(" ", cx)),
                "<lt>" => area.update(cx, |a, cx| a.insert("<", cx)),
                "<BS>" => {
                    area.update(cx, |a, cx| a.key("<BS>", window, cx));
                }
                _ if k.chars().count() == 1 => area.update(cx, |a, cx| a.insert(&k, cx)),
                _ => {}
            }
        }
        None
    }

    /// nvim answered (or took too long): the keys typed into the field meanwhile go to it now.
    pub fn release<T: 'static>(&mut self, window: &mut Window, cx: &mut Context<T>) {
        if !self.awaiting {
            return;
        }
        self.awaiting = false;
        self.await_task = None;
        let keys = std::mem::take(&mut self.queued);
        if !keys.is_empty() {
            // dispatched again as typed, after this update
            window.defer(cx, move |window, cx| {
                for k in keys {
                    window.dispatch_keystroke(k, cx);
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_card_names_its_line_or_range() {
        assert_eq!(title_of(19, None, false), "Comment on line 19");
        assert_eq!(title_of(4, Some(2), false), "Comment on lines 2–4");
        assert_eq!(title_of(4, Some(4), false), "Comment on line 4");
        assert_eq!(title_of(3, None, true), "Edit draft on line 3");
    }
}
