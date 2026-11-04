//! A cloud workspace's link: RemoteState in the editor slot while its Neovim is waking,
//! connecting or failed to connect (DS 2.0 RemoteState; App Map V5-09), and what the status bar
//! says of it (`☁ demo-shop-102`: its box's name; its hover: the box, its region, the round
//! trip).
//!
//! The states are what the shell sees of its own spawn: connecting until Neovim first draws,
//! failed when it has not drawn within [`CONNECT_WAIT`], or when it exits before that [`TRIES`]
//! times (a busy box's ssh, `docker exec` or nvim ends first; each end waits its
//! [`BACKOFF`], then the attach starts again, RemoteState naming the step that ended and what it
//! said on stderr). Retry ⏎ starts it again; Download locally (⌘⏎) clicks the attach's
//! `download` in the bridge, which runs `abe session download` and opens the copy on this Mac.
//!
//! While the header's feed says its box runs and its workspace is being built there (the
//! look's `building`: a fresh box's first image build), RemoteState says so with the launch's
//! step and waits on it: a try that ends then (`No such container`) is not counted, the next
//! starts once the feed no longer says it, and the connect's clock starts from there.
//!
//! Once it failed, its red card goes by itself when the cause is gone: the feed saying its
//! box runs when it did not as it failed, or its workspace built when it was being built then,
//! starts a try with no click ([`RemoteLink::came_up`]). A box that ran all along and still does
//! not answer needs you: the card stays with Retry.
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui_kit::{
    App, Bounds, ClickEvent, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _,
    Pixels, SharedString, Styled as _, Window, div, px,
};

use crate::factory::CloudState;
use crate::kit::TextButton;
use crate::look;
use crate::shell::remote::Attach;

/// After this long with no answer, a connect has failed (V5-09: "No answer for 30 s").
pub const CONNECT_WAIT: Duration = Duration::from_secs(30);
/// A box waking first (an EC2 start, then SSH) gets longer before it counts as failed.
pub const WAKE_WAIT: Duration = Duration::from_secs(120);
/// How often the round trip is measured once attached.
pub const ROUND_TRIP_EVERY: Duration = Duration::from_secs(15);
/// A next try starts only with this much of [`RemoteLink::wait`] left for it.
pub const TRY_ROOM: Duration = Duration::from_secs(5);
/// How many times an attach is started before an end counts as failed.
pub const TRIES: u32 = 4;
/// The wait after each try's end before the next one starts.
pub const BACKOFF: [Duration; 3] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
];

/// The attach's step that ended: `abe box attach`'s tunnel and SSH, the box's
/// `docker exec` into the workspace container, or Neovim there.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndStep {
    Tunnel,
    DockerExec,
    Nvim,
}

impl EndStep {
    pub fn name(self) -> &'static str {
        match self {
            EndStep::Tunnel => "the tunnel",
            EndStep::DockerExec => "docker exec",
            EndStep::Nvim => "Neovim",
        }
    }
}

/// An attach that ended before Neovim answered: which step, its exit code, its stderr's tail.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ended {
    pub step: EndStep,
    pub code: Option<i32>,
    pub stderr: String,
}

/// What a step's stderr says (ssh's and abe's tunnel's words, the docker daemon's).
const TUNNEL_WORDS: &[&str] = &[
    "open-tunnel",
    "abe: ",
    "ssh:",
    "kex_exchange_identification",
    "Connection closed by",
    "Connection reset by",
    "Connection timed out",
    "Timeout, server",
    "client_loop",
    "Broken pipe",
    "Permission denied (publickey",
];
const DOCKER_WORDS: &[&str] = &[
    "Error response from daemon",
    "OCI runtime",
    "Cannot connect to the Docker daemon",
    "docker:",
];

impl Ended {
    /// The step by what it said on stderr, else by its exit code: ssh's 255 a drop, `docker
    /// exec`'s own 125 / 126 / 127 (it, or nvim not started), any other nvim's.
    pub fn of(code: Option<i32>, stderr: &str) -> Ended {
        let says = |words: &[&str]| words.iter().any(|w| stderr.contains(w));
        let step = if says(DOCKER_WORDS) {
            EndStep::DockerExec
        } else if says(TUNNEL_WORDS) {
            EndStep::Tunnel
        } else {
            match code {
                Some(255) => EndStep::Tunnel,
                Some(125..=127) => EndStep::DockerExec,
                _ => EndStep::Nvim,
            }
        };
        Ended {
            step,
            code,
            stderr: stderr.to_owned(),
        }
    }

    /// RemoteState's line: `It ended at docker exec before it answered`.
    pub fn why(&self) -> String {
        format!("It ended at {} before it answered", self.step.name())
    }

    /// What it said: its stderr's last line, else its exit code.
    pub fn detail(&self) -> String {
        const MAX: usize = 160;
        let last = self.stderr.lines().map(str::trim).rfind(|l| !l.is_empty());
        match (last, self.code) {
            (Some(l), _) if l.chars().count() > MAX => {
                format!("{}…", l.chars().take(MAX).collect::<String>())
            }
            (Some(l), _) => l.to_owned(),
            // ssh's own code for a dropped link, and for the box's command killed by a signal
            (None, Some(255)) => {
                "exit 255: the SSH link dropped, or the box's command was killed".into()
            }
            (None, Some(c)) => format!("exit {c}"),
            (None, None) => "no exit code".into(),
        }
    }
}

/// What a try that ended hands the next: the tries so far, when the first began, the end
/// (none for one that ended while the workspace was being built: not said).
#[derive(Clone, Debug)]
pub struct Tried {
    pub tries: u32,
    pub since: Instant,
    pub ended: Option<Ended>,
    /// The feed said its workspace was being built: its box is known to run.
    pub ran: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum LinkState {
    /// Started, Neovim has not drawn yet.
    Connecting,
    /// Neovim drew: the Editor is the box's.
    Attached,
    /// Neovim exited before it drew, or did not answer in time.
    Failed(String),
}

/// What a workspace keeps of its link to the box.
#[derive(Clone, Debug)]
pub struct RemoteLink {
    pub attach: Arc<Attach>,
    pub since: Instant,
    pub state: LinkState,
    /// The last `nvim_get_mode` round trip.
    pub round_trip: Option<Duration>,
    /// The tries started, this one counted.
    pub tries: u32,
    /// How the try before ended (this one's, once it failed).
    pub ended: Option<Ended>,
    /// The header's feed says its workspace is being built on the running box: the
    /// launch's step as Chat says it.
    pub building: Option<String>,
    /// The feed said it was being built: its box runs, never `slept` again.
    pub ran: bool,
    /// What the feed said as it failed: its box's cloud, whether it was being built.
    pub failed_with: Option<(Option<CloudState>, bool)>,
}

impl RemoteLink {
    pub fn new(attach: Arc<Attach>) -> Self {
        RemoteLink {
            attach,
            since: Instant::now(),
            state: LinkState::Connecting,
            round_trip: None,
            tries: 1,
            ended: None,
            building: None,
            ran: false,
            failed_with: None,
        }
    }

    /// It failed now, the feed saying `cloud` of its box and `building` of its workspace.
    pub fn fail(&mut self, why: &str, cloud: Option<CloudState>, building: bool) {
        self.state = LinkState::Failed(why.to_owned());
        self.failed_with = Some((cloud, building));
    }

    /// Its cause is gone: it failed while the feed said its box did not run (asleep,
    /// starting, unknown) and now says it runs, or while its workspace was being built and now it
    /// is not. Then a try starts by itself.
    pub fn came_up(&self, cloud: Option<CloudState>, building: bool) -> bool {
        let Some((was, was_building)) = self.failed_with else {
            return false;
        };
        self.failed()
            && ((was != Some(CloudState::Running) && cloud == Some(CloudState::Running))
                || (was_building && !building))
    }

    /// Goes on from the tries before: their count and clock, how the last one ended.
    pub fn carry(&mut self, tried: Tried) {
        self.tries = tried.tries + 1;
        self.since = tried.since;
        self.ended = tried.ended;
        self.ran |= tried.ran;
    }

    /// Its box not known to run: the attach wakes it first (the spec's `waking`, until the feed
    /// said its workspace was being built there).
    fn waking(&self) -> bool {
        self.attach.waking && !self.ran
    }

    /// What the feed says now of its workspace being built. Once it no longer does, the
    /// connect's clock starts again: the time it waited on the build is not the attach's.
    pub fn set_building(&mut self, building: Option<String>, now: Instant) {
        if self.building.is_some() && building.is_none() {
            self.since = now;
        }
        self.ran |= building.is_some();
        self.building = building;
    }

    /// Waiting on its workspace being built: not connected, not failed, the feed saying so.
    pub fn waits_on_build(&self) -> bool {
        self.state == LinkState::Connecting && self.building.is_some()
    }

    /// A try that ended at `docker exec` while its workspace is being built (no container
    /// yet) waits on the build, uncounted; any other end (the tunnel, ssh's login) is a try.
    pub fn holds(&self, ended: &Ended) -> bool {
        self.waits_on_build() && ended.step == EndStep::DockerExec
    }

    /// A try that ended while its workspace was being built: handed on uncounted, its end
    /// not said (the container is not there yet), the clock kept.
    pub fn uncounted(&self) -> Tried {
        Tried {
            tries: self.tries.saturating_sub(1),
            since: self.since,
            ended: None,
            ran: self.ran,
        }
    }

    /// This try ended before Neovim answered: the wait before the next and what it is handed, or
    /// None when it was the last (its tries spent, or no time left within [`Self::wait`]).
    pub fn next_try(&self, ended: Ended, now: Instant) -> Option<(Duration, Tried)> {
        let after = *BACKOFF.get(self.tries.checked_sub(1)? as usize)?;
        if self.tries >= TRIES || now.duration_since(self.since) + after + TRY_ROOM > self.wait() {
            return None;
        }
        Some((
            after,
            Tried {
                tries: self.tries,
                since: self.since,
                ended: Some(ended),
                ran: self.ran,
            },
        ))
    }

    /// How the last try ended, when one did.
    pub fn ended(&self) -> Option<&Ended> {
        self.ended.as_ref()
    }

    /// RemoteState's line under its title.
    pub fn line(&self, now: Instant) -> String {
        self.words(now).1
    }

    pub fn attached(&self) -> bool {
        self.state == LinkState::Attached
    }

    pub fn failed(&self) -> bool {
        matches!(self.state, LinkState::Failed(_))
    }

    /// The status bar's words (V5-09's marker states).
    pub fn status_text(&self, now: Instant) -> String {
        match &self.state {
            LinkState::Attached => format!("☁ {}", self.attach.box_.name),
            LinkState::Failed(_) => "✗ couldn't connect".into(),
            LinkState::Connecting if self.building.is_some() => {
                format!(
                    "☁ building the workspace… {} s",
                    now.duration_since(self.since).as_secs()
                )
            }
            LinkState::Connecting if self.waking() => {
                format!("☁ waking… {} s", now.duration_since(self.since).as_secs())
            }
            LinkState::Connecting => "☁ connecting…".into(),
        }
    }

    /// How long it may take to answer before it has failed.
    pub fn wait(&self) -> Duration {
        if self.waking() {
            WAKE_WAIT
        } else {
            CONNECT_WAIT
        }
    }

    /// The status bar's hover.
    pub fn hover(&self) -> String {
        crate::shell::remote::hover(&self.attach, self.round_trip)
    }

    /// RemoteState's title: `Waking shop-4`, `Couldn't connect to shop-4`.
    pub fn title(&self, now: Instant) -> String {
        self.words(now).0
    }

    /// RemoteState's title, line and steps (each its mark); the box by its name.
    fn words(&self, now: Instant) -> (String, String, Vec<(Step, String)>) {
        let name = &self.attach.box_.name;
        let secs = now.duration_since(self.since).as_secs();
        let attach = "Attach Neovim, the terminal and the LSP";
        // Where the try before ended, and what it said
        let ended = self.ended.as_ref().map(|e| {
            let tries = match self.tries {
                n if n > 1 && self.failed() => format!(" · {n} tries"),
                _ => String::new(),
            };
            (
                Step::Said,
                format!("{}: {}{tries}", e.step.name(), e.detail()),
            )
        });
        let tried = match self.tries {
            1 => String::new(),
            n => format!(" · try {n} of {TRIES}"),
        };
        match &self.state {
            LinkState::Failed(why) => (
                format!("Couldn't connect to {name}"),
                format!("{why} · the session keeps running there"),
                [(Step::Failed, format!("{attach} on {name}"))]
                    .into_iter()
                    .chain(ended)
                    .collect(),
            ),
            // The box runs; its workspace container is not there yet
            LinkState::Connecting if self.building.is_some() => (
                format!("Building the workspace on {name}"),
                format!("{name} runs · its workspace is being built; it attaches once it is up"),
                [
                    (
                        Step::Running,
                        format!(
                            "{} · {secs} s",
                            self.building.as_deref().unwrap_or_default()
                        ),
                    ),
                    (Step::Waiting, attach.into()),
                ]
                .into_iter()
                .collect(),
            ),
            _ if self.waking() => (
                format!("Waking {name}"),
                format!("{name} slept · it wakes on open"),
                ended
                    .into_iter()
                    .chain([
                        (Step::Running, format!("Waking {name} · {secs} s{tried}")),
                        (Step::Waiting, attach.into()),
                    ])
                    .collect(),
            ),
            _ => (
                format!("Connecting to {name}"),
                format!("{name} · the files fill in as they arrive"),
                ended
                    .into_iter()
                    .chain([(Step::Running, format!("{attach} · {secs} s{tried}"))])
                    .collect(),
            ),
        }
    }
}

#[derive(Clone, Copy)]
enum Step {
    Running,
    Waiting,
    Failed,
    /// What a try that ended said.
    Said,
}

/// A RemoteState button's press.
pub type Press = Box<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// RemoteState, centred in `area` (the editor slot); `retry` and `download` its buttons' presses.
pub fn remote_state(
    link: &RemoteLink,
    area: Bounds<Pixels>,
    now: Instant,
    retry: Press,
    download: Press,
) -> impl IntoElement {
    let (title, line, steps) = link.words(now);
    let failed = link.failed();
    let mut card = div()
        .debug_selector(|| "remote-state".into())
        .flex()
        .flex_col()
        .gap(px(8.))
        .max_w(px(460.))
        .p(px(20.))
        .rounded(px(look::BUTTON_ARC * 2.))
        .bg(look::EDITOR_BG)
        .border(px(1.))
        .border_color(if failed {
            look::ABE_BAD
        } else {
            look::BUTTON_BORDER
        })
        .child(
            div()
                .debug_selector(|| "remote-state-title".into())
                .text_size(px(look::UI_FONT_SIZE + 2.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(look::TEXT)
                .child(SharedString::from(title)),
        )
        .child(
            div()
                .text_color(look::TEXT_DIM)
                .child(SharedString::from(line)),
        );
    {
        let mut list = div().flex().flex_col().gap(px(4.)).pt(px(4.));
        for (i, (step, text)) in steps.into_iter().enumerate() {
            let (mark, color) = match step {
                Step::Running => ("●", look::ABE_WARN),
                Step::Waiting => ("○", look::TEXT_DIM),
                Step::Failed => ("✗", look::ABE_BAD),
                Step::Said => ("·", look::TEXT_DIM),
            };
            // a long why wraps inside the card, its mark on the first line
            list = list.child(
                div()
                    .flex()
                    .min_w_0()
                    .gap(px(6.))
                    .text_color(color)
                    .child(div().flex_none().child(mark))
                    .child(
                        div()
                            .debug_selector(move || format!("remote-step-{i}"))
                            .flex_1()
                            .min_w_0()
                            .child(SharedString::from(text)),
                    ),
            );
        }
        card = card.child(list);
    }
    if failed {
        card = card.child(
            div()
                .flex()
                .gap(px(8.))
                .pt(px(8.))
                .child(
                    div().debug_selector(|| "remote-retry".into()).child(
                        TextButton::new("remote-retry", "Retry")
                            .primary(true)
                            .key("⏎")
                            .on_click(retry),
                    ),
                )
                // The session copied to this Mac, where it goes on
                .child(
                    div().debug_selector(|| "remote-download".into()).child(
                        TextButton::new("remote-download", "Download locally")
                            .key("⌘⏎")
                            .disabled(link.attach.download.is_none())
                            .on_click(download),
                    ),
                ),
        );
    } else {
        card = card.child(
            div()
                .pt(px(4.))
                .text_color(look::TEXT_DIM)
                .child("⌘⌥A goes back to Abe; the workspace opens when it is up"),
        );
    }
    div()
        .absolute()
        .left(area.origin.x)
        .top(area.origin.y)
        .w(area.size.width)
        .h(area.size.height)
        .bg(look::EDITOR_BG)
        .flex()
        .items_center()
        .justify_center()
        .font(gpui_kit::font(crate::render::UI_FONT))
        .text_size(px(look::UI_FONT_SIZE))
        .child(card)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::remote::BoxInfo;

    fn link(waking: bool) -> RemoteLink {
        RemoteLink::new(Arc::new(Attach {
            nvim: vec!["x".into()],
            shell: vec!["x".into()],
            exec: vec![],
            box_: BoxInfo {
                name: "demo-shop-2".into(),
                region: None,
            },
            waking,
            download: None,
        }))
    }

    struct End {
        code: Option<i32>,
        stderr: &'static str,
        step: EndStep,
        detail: &'static str,
    }

    const ENDS: &[End] = &[
        End {
            code: Some(255),
            stderr: "Timeout, server 10.0.1.5 not responding.",
            step: EndStep::Tunnel,
            detail: "Timeout, server 10.0.1.5 not responding.",
        },
        End {
            code: Some(255),
            stderr: "Warning: x\n\nTimeout, server 10.0.1.5 not responding.\n\n",
            step: EndStep::Tunnel,
            detail: "Timeout, server 10.0.1.5 not responding.",
        },
        End {
            code: Some(1),
            stderr: "abe: open-tunnel: handshake failed (no answer)",
            step: EndStep::Tunnel,
            detail: "abe: open-tunnel: handshake failed (no answer)",
        },
        End {
            code: Some(255),
            stderr: "Connection closed by UNKNOWN port 65535",
            step: EndStep::Tunnel,
            detail: "Connection closed by UNKNOWN port 65535",
        },
        End {
            code: Some(255),
            stderr: "",
            step: EndStep::Tunnel,
            detail: "exit 255: the SSH link dropped, or the box's command was killed",
        },
        End {
            code: Some(125),
            stderr: "Error response from daemon: container x is not running",
            step: EndStep::DockerExec,
            detail: "Error response from daemon: container x is not running",
        },
        End {
            code: Some(126),
            stderr: "OCI runtime exec failed: exec failed: unable to start container process",
            step: EndStep::DockerExec,
            detail: "OCI runtime exec failed: exec failed: unable to start container process",
        },
        End {
            code: Some(127),
            stderr: "",
            step: EndStep::DockerExec,
            detail: "exit 127",
        },
        End {
            code: Some(1),
            stderr: "E5113: Error while calling lua chunk",
            step: EndStep::Nvim,
            detail: "E5113: Error while calling lua chunk",
        },
        End {
            code: Some(3),
            stderr: "",
            step: EndStep::Nvim,
            detail: "exit 3",
        },
        End {
            code: Some(0),
            stderr: "",
            step: EndStep::Nvim,
            detail: "exit 0",
        },
        End {
            code: None,
            stderr: "",
            step: EndStep::Nvim,
            detail: "no exit code",
        },
    ];

    /// The step by what it said on stderr, else by its exit code; the detail its last line said,
    /// else its exit code.
    #[test]
    fn an_end_names_its_step_and_its_detail_by_its_stderr_else_its_exit_code() {
        for e in ENDS {
            let got = Ended::of(e.code, e.stderr);
            let row = format!("{:?} {:?}", e.code, e.stderr);
            assert_eq!(got.step, e.step, "{row}");
            assert_eq!(got.detail(), e.detail, "{row}");
        }
        let long = "y".repeat(400);
        assert_eq!(Ended::of(Some(1), &long).detail().chars().count(), 161);
        assert_eq!(
            Ended::of(Some(125), "").why(),
            "It ended at docker exec before it answered"
        );
    }

    #[test]
    fn a_try_that_ends_waits_its_backoff_then_the_next_until_the_tries_are_spent() {
        let mut l = link(false);
        let now = l.since;
        let end = || Ended::of(Some(255), "");
        let mut waits = Vec::new();
        while let Some((after, tried)) = l.next_try(end(), now) {
            waits.push(after);
            let mut next = link(false);
            next.carry(tried);
            assert_eq!(next.since, l.since, "the clock goes on");
            l = next;
        }
        assert_eq!(waits, BACKOFF.to_vec());
        assert_eq!(l.tries, TRIES);
        // no time left within the connect wait: no next try
        let l = link(false);
        assert!(
            l.next_try(end(), l.since + CONNECT_WAIT - TRY_ROOM)
                .is_none()
        );
        assert!(
            l.next_try(end(), l.since + CONNECT_WAIT - TRY_ROOM - BACKOFF[0])
                .is_some()
        );
        // a waking box has longer
        let l = link(true);
        assert!(l.next_try(end(), l.since + CONNECT_WAIT).is_some());
    }

    #[test]
    fn remote_state_says_the_try_and_where_the_last_one_ended() {
        let mut l = link(false);
        let now = l.since;
        let (_, tried) = l
            .next_try(
                Ended::of(Some(255), "Timeout, server x not responding."),
                now,
            )
            .unwrap();
        l.carry(tried);
        let (title, _, steps) = l.words(now);
        assert_eq!(title, "Connecting to demo-shop-2");
        let steps: Vec<_> = steps.into_iter().map(|(_, t)| t).collect();
        assert_eq!(
            steps,
            [
                "the tunnel: Timeout, server x not responding.",
                "Attach Neovim, the terminal and the LSP · 0 s · try 2 of 4",
            ]
        );
        l.state = LinkState::Failed(l.ended().unwrap().why());
        assert_eq!(
            l.line(now),
            "It ended at the tunnel before it answered · the session keeps running there"
        );
    }

    #[test]
    fn a_workspace_being_built_is_said_and_waited_on_never_slept_nor_counted() {
        // The spec said waking (its session was starting), the feed says it builds
        let mut l = link(true);
        let t0 = l.since;
        let line = "Building the workspace image (first time on this box, ~3 min) · step 14/27";
        l.set_building(Some(line.into()), t0);
        assert!(l.waits_on_build());
        let (title, said, steps) = l.words(t0 + Duration::from_secs(20));
        assert_eq!(title, "Building the workspace on demo-shop-2");
        assert!(!said.contains("slept"), "{said}");
        let steps: Vec<_> = steps.into_iter().map(|(_, t)| t).collect();
        assert_eq!(
            steps,
            [
                format!("{line} · 20 s"),
                "Attach Neovim, the terminal and the LSP".into()
            ]
        );
        assert_eq!(
            l.status_text(t0 + Duration::from_secs(20)),
            "☁ building the workspace… 20 s"
        );
        // the try that ended meanwhile goes on uncounted, its `No such container` not said
        l.ended = Some(Ended::of(
            Some(1),
            "Error response from daemon: No such container: abe-workspace",
        ));
        let mut next = link(true);
        next.carry(l.uncounted());
        assert_eq!((next.tries, next.ended.is_none()), (1, true));
        // built: the connect's clock starts from then
        let t1 = t0 + Duration::from_secs(200);
        next.set_building(Some(line.into()), t0);
        next.set_building(None, t1);
        assert_eq!(next.since, t1);
        // its box ran all along: never `Waking` again, the connect's own wait
        assert_eq!(next.title(t1), "Connecting to demo-shop-2");
        assert_eq!(next.wait(), CONNECT_WAIT);
        assert!(next.next_try(Ended::of(Some(1), ""), t1).is_some());
    }

    #[test]
    fn only_a_docker_exec_end_waits_on_the_build_any_other_is_a_try() {
        let mut l = link(false);
        let no_container = Ended::of(
            Some(1),
            "Error response from daemon: No such container: abe-workspace",
        );
        let ssh = Ended::of(Some(255), "Permission denied (publickey).");
        assert!(!l.holds(&no_container), "not building: a try");
        l.set_building(Some("Building the repo's image".into()), l.since);
        assert!(l.holds(&no_container));
        assert!(!l.holds(&ssh), "the tunnel's end is said and counted");
    }

    #[test]
    fn a_failed_card_goes_by_itself_once_its_box_came_up() {
        // It failed while the box was asleep or starting: the feed saying it runs retries
        for was in [None, Some(CloudState::Asleep), Some(CloudState::Starting)] {
            let mut l = link(true);
            assert!(
                !l.came_up(Some(CloudState::Running), false),
                "not failed yet"
            );
            l.fail("No answer for 120 s", was, false);
            assert!(!l.came_up(was, false), "{was:?}: nothing moved");
            assert!(
                l.came_up(Some(CloudState::Running), false),
                "{was:?}: up now"
            );
        }
        // it failed while its workspace was being built: built now, it retries
        let mut l = link(false);
        l.fail(
            "It ended at docker exec before it answered",
            Some(CloudState::Running),
            true,
        );
        assert!(!l.came_up(Some(CloudState::Running), true));
        assert!(l.came_up(Some(CloudState::Running), false));
        // the box ran all along and does not answer: that needs you (Retry)
        let mut l = link(false);
        l.fail("No answer for 30 s", Some(CloudState::Running), false);
        assert!(!l.came_up(Some(CloudState::Running), false));
    }
}
