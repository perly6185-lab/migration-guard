pub trait ClockPort: Send + Sync {
    fn now_millis(&self) -> u64;
}
