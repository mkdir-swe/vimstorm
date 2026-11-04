//! Tools for driving and measuring a live app: the key latency bench, and in the `shots` build the
//! drive socket and offscreen shots.

mod bench;
#[cfg(feature = "shots")]
mod drive;
#[cfg(feature = "shots")]
mod shot;

pub(crate) use bench::schedule as schedule_bench;
#[cfg(feature = "shots")]
pub use drive::prepare;
#[cfg(feature = "shots")]
pub(crate) use drive::schedule as schedule_drive;
#[cfg(feature = "shots")]
pub(crate) use drive::tap;
#[cfg(feature = "shots")]
pub use shot::isolate_state;
#[cfg(feature = "shots")]
pub(crate) use shot::schedule as schedule_shot;
