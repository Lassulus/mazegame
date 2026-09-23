//! Locks without the poisoning ceremony.
//!
//! The crate has no dependencies, so these stand in for `parking_lot`: they
//! hand back the guard directly instead of a `LockResult` nobody can act on.
//! Recovering from poisoning is the right call here anyway — a panic in one
//! connection thread must not take the world's state with it — and with
//! `panic = "abort"` in release it cannot happen at all.

use std::sync::{Condvar, Mutex, MutexGuard};

pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

pub fn wait<'a, T>(cond: &Condvar, guard: MutexGuard<'a, T>) -> MutexGuard<'a, T> {
    match cond.wait(guard) {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}
