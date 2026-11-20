//! Pure ownership state used by the JNI router; no persisted/reconstructed login attempt.
pub struct Route<T> {
    active: Option<(u64, T)>,
}
impl<T> Route<T> {
    pub const fn new() -> Self {
        Self { active: None }
    }
    pub fn start(&mut self, id: u64, value: T) -> Result<(), ()> {
        if self.active.is_some() {
            return Err(());
        }
        self.active = Some((id, value));
        Ok(())
    }
    pub fn current(&self) -> Option<&T> {
        self.active.as_ref().map(|(_, value)| value)
    }
    pub fn cancel(&mut self, id: u64) {
        if self
            .active
            .as_ref()
            .is_some_and(|(current, _)| *current == id)
        {
            self.active = None;
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn process_reconstruction_has_no_pending_attempt() {
        let route: Route<()> = Route::new();
        assert!(route.current().is_none());
    }
    #[test]
    fn cancelled_or_consumed_route_rejects_late_delivery() {
        let mut route = Route::new();
        route.start(1, 7).unwrap();
        route.cancel(1);
        assert!(route.current().is_none());
        route.cancel(1);
        assert!(route.current().is_none());
    }
    #[test]
    fn old_drop_cannot_cancel_new_generation() {
        let mut route = Route::new();
        route.start(1, 7).unwrap();
        route.cancel(1);
        route.start(2, 8).unwrap();
        route.cancel(1);
        assert_eq!(route.current(), Some(&8));
    }
    #[test]
    fn parallel_bind_cannot_replace_current_attempt() {
        let mut route = Route::new();
        route.start(1, 7).unwrap();
        assert!(route.start(2, 8).is_err());
        assert_eq!(route.current(), Some(&7));
    }
}
