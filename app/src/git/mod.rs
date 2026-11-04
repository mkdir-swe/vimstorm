//! Git: the `git` CLI off the UI thread (this folder's files), the Git tool window, the diff /
//! merge viewer and annotate.

/// Annotate (blame) and the editor's git change gutter, WS look.
pub mod annotate;
/// Diff / merge viewer chrome around nvim's panes.
pub mod diff;
/// The Git tool window: GitView over its host nvim window, tabs Local Changes / Log.
pub mod window;

/// Annotate: `git blame --porcelain`, WS annotation colors / texts.
mod blame;
/// Branches: HEAD, local / remote / recent, checkout, new branch (toolbar).
mod branches;
/// Local Changes: `git status` porcelain v2, sections, merge state.
mod changes;
/// The shared runner (`git -C <dir> ...`), cancellable / streaming variants.
mod cli;
/// Commit / amend / rollback / Add to VCS.
mod commit;
/// Relative dates + author display like WebStorm's log / annotate.
mod dates;
/// The Log graph layout (IntelliJ vcs-log port) + branch colors.
mod graph;
/// Changed line ranges vs HEAD / index (change gutter).
mod hunks;
/// Stale-result dropping (generations) + background spawning.
mod job;
/// The Log: filters, streamed `git log`, refs, authors, path choices.
mod log;
/// Push / pull / fetch, checkout, branch / tag, cherry-pick, revert, reset, reword / drop.
mod ops;
/// Repo state: root, HEAD, operation in progress, upstream ahead / behind.
mod repo;
/// Commit details, combined changes of a selection, file text at a revision.
mod show;
/// `git status` for the Project tree's name colors.
mod status;
/// A worktree's working files deleted (Delete Working Files…) and a folder's main checkout.
mod worktree;

pub use blame::{ANNOTATION_COLORS, annotation_text, blame_blocking};
pub use branches::{Branches, Head, Target, filter_refs_blocking};
pub(crate) use branches::{
    checkout_blocking, compare_range, create_blocking, create_from_blocking, delete_blocking,
    head_blocking, load_blocking as load_branches_blocking, rename_blocking, target_name,
    unmerged_blocking, validate_new,
};
pub use changes::{ChangeKind, Section, read_blocking as read_changes_blocking};
pub use cli::{Cancel, run, run_blocking};
pub use commit::{
    RollbackOptions, add_blocking, commit_blocking, last_message_blocking, rollback_blocking,
    rollback_prompt,
};
pub use dates::{Zone, now};
pub use graph::{Graph, GraphOptions, layout};
pub use hunks::{Base, HunkKind, hunks_blocking};
pub use log::{
    BranchFilter, DateFilter, HeadRef, LineRange, LogFilters, LogKind, LogOptions, LogParser,
    LogSnapshot, RefKind, authors_blocking, load_blocking as load_log_blocking, log_args,
    me_blocking, messages_blocking, path_choices_blocking, stream,
};
pub use ops::{
    ResetMode, checkout_revision_blocking, checkout_tag_blocking, cherry_pick_blocking,
    drop_blocking, fetch_blocking, is_unpushed_blocking, new_branch_blocking, new_tag_blocking,
    pull_blocking, push_blocking, push_info_blocking, reset_blocking, revert_blocking,
    reword_blocking, reword_subject_blocking, uncommit_blocking, uncommit_count_blocking,
};
pub use repo::{HeadState, Operation, read_blocking as read_repo_blocking};
pub use show::{
    DetailsCache, EMPTY_TREE, branches_text, combined_blocking, containing_branches_blocking,
    details_blocking, file_at_blocking, short_hash_blocking,
};
pub(crate) use status::read as read_status;
pub use status::{FileStatus, GitStatus};
pub use worktree::delete as delete_worktree;
pub(crate) use worktree::{Loss, checkout_of, loss as worktree_loss};
