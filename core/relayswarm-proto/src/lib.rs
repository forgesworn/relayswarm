//! RelaySwarm wire types and verification, shared by every RelaySwarm shell.
//!
//! This crate performs no I/O and reads no clock: callers pass the current
//! time. Outcomes match the JavaScript implementation; the vectors in
//! `core/vectors/` are generated from it and checked by both test suites.

pub mod commitment;
pub mod event;
pub mod js;
pub mod link;
