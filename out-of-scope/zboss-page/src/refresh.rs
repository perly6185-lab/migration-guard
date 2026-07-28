#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeaseClaim {
    pub key: String,
    pub owner_token: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshEffect {
    Sync,
    Timestamp,
    UndoClear,
    Reconcile,
    Query,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefreshEvent {
    LockAcquired(LeaseClaim),
    EffectCompleted(RefreshEffect),
    LockReleased(LeaseClaim),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshFailure {
    pub effect: Option<RefreshEffect>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RefreshExecution {
    pub events: Vec<RefreshEvent>,
    pub primary_failure: Option<RefreshFailure>,
    pub release_failure: Option<String>,
}

impl RefreshExecution {
    pub fn passed(&self) -> bool {
        self.primary_failure.is_none() && self.release_failure.is_none()
    }
}

pub trait LeasePort {
    fn acquire(&mut self, claim: &LeaseClaim) -> Result<bool, String>;
    fn release(&mut self, claim: &LeaseClaim) -> Result<bool, String>;
}

pub trait RefreshPort {
    fn sync(&mut self) -> Result<(), String>;
    fn update_timestamp(&mut self) -> Result<(), String>;
    fn clear_undo(&mut self) -> Result<(), String>;
    fn reconcile(&mut self) -> Result<(), String>;
    fn query(&mut self) -> Result<(), String>;
}

pub fn execute_refresh<L: LeasePort, R: RefreshPort>(
    lease: &mut L,
    operations: &mut R,
    claim: LeaseClaim,
) -> RefreshExecution {
    let mut execution = RefreshExecution::default();
    if claim.key.is_empty() || claim.owner_token.is_empty() {
        execution.primary_failure = Some(RefreshFailure {
            effect: None,
            message: "lease key and owner token are required".into(),
        });
        return execution;
    }

    match lease.acquire(&claim) {
        Ok(true) => execution
            .events
            .push(RefreshEvent::LockAcquired(claim.clone())),
        Ok(false) => {
            execution.primary_failure = Some(RefreshFailure {
                effect: None,
                message: "lease already owned".into(),
            });
            return execution;
        }
        Err(message) => {
            execution.primary_failure = Some(RefreshFailure {
                effect: None,
                message,
            });
            return execution;
        }
    }

    run_effect(&mut execution, RefreshEffect::Sync, operations.sync());
    if execution.primary_failure.is_none() {
        run_effect(
            &mut execution,
            RefreshEffect::Timestamp,
            operations.update_timestamp(),
        );
    }
    if execution.primary_failure.is_none() {
        run_effect(
            &mut execution,
            RefreshEffect::UndoClear,
            operations.clear_undo(),
        );
    }
    if execution.primary_failure.is_none() {
        run_effect(
            &mut execution,
            RefreshEffect::Reconcile,
            operations.reconcile(),
        );
    }
    if execution.primary_failure.is_none() {
        run_effect(&mut execution, RefreshEffect::Query, operations.query());
    }

    match lease.release(&claim) {
        Ok(true) => execution.events.push(RefreshEvent::LockReleased(claim)),
        Ok(false) => {
            execution.release_failure = Some("lease owner token did not match".into());
        }
        Err(message) => execution.release_failure = Some(message),
    }
    execution
}

fn run_effect(execution: &mut RefreshExecution, effect: RefreshEffect, result: Result<(), String>) {
    match result {
        Ok(()) => execution.events.push(RefreshEvent::EffectCompleted(effect)),
        Err(message) => {
            execution.primary_failure = Some(RefreshFailure {
                effect: Some(effect),
                message,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct MemoryLease {
        owner: Option<String>,
        fail_release: bool,
    }

    impl LeasePort for MemoryLease {
        fn acquire(&mut self, claim: &LeaseClaim) -> Result<bool, String> {
            if self.owner.is_some() {
                return Ok(false);
            }
            self.owner = Some(claim.owner_token.clone());
            Ok(true)
        }

        fn release(&mut self, claim: &LeaseClaim) -> Result<bool, String> {
            if self.fail_release {
                return Err("redis unavailable during release".into());
            }
            if self.owner.as_deref() != Some(&claim.owner_token) {
                return Ok(false);
            }
            self.owner = None;
            Ok(true)
        }
    }

    #[derive(Default)]
    struct MemoryRefresh {
        fail_at: Option<RefreshEffect>,
        calls: Vec<RefreshEffect>,
    }

    impl MemoryRefresh {
        fn call(&mut self, effect: RefreshEffect) -> Result<(), String> {
            self.calls.push(effect);
            if self.fail_at == Some(effect) {
                Err(format!("{effect:?} failed"))
            } else {
                Ok(())
            }
        }
    }

    impl RefreshPort for MemoryRefresh {
        fn sync(&mut self) -> Result<(), String> {
            self.call(RefreshEffect::Sync)
        }
        fn update_timestamp(&mut self) -> Result<(), String> {
            self.call(RefreshEffect::Timestamp)
        }
        fn clear_undo(&mut self) -> Result<(), String> {
            self.call(RefreshEffect::UndoClear)
        }
        fn reconcile(&mut self) -> Result<(), String> {
            self.call(RefreshEffect::Reconcile)
        }
        fn query(&mut self) -> Result<(), String> {
            self.call(RefreshEffect::Query)
        }
    }

    fn claim() -> LeaseClaim {
        LeaseClaim {
            key: "tenant:1:page:7".into(),
            owner_token: "owner-123".into(),
        }
    }

    #[test]
    fn successful_refresh_has_auditable_order_and_owner_release() {
        let mut lease = MemoryLease::default();
        let mut refresh = MemoryRefresh::default();
        let execution = execute_refresh(&mut lease, &mut refresh, claim());
        assert!(execution.passed());
        assert_eq!(
            refresh.calls,
            vec![
                RefreshEffect::Sync,
                RefreshEffect::Timestamp,
                RefreshEffect::UndoClear,
                RefreshEffect::Reconcile,
                RefreshEffect::Query,
            ]
        );
        assert!(matches!(
            execution.events.last(),
            Some(RefreshEvent::LockReleased(_))
        ));
        assert!(lease.owner.is_none());
    }

    #[test]
    fn sync_failure_skips_post_effects_and_query_but_releases() {
        let mut lease = MemoryLease::default();
        let mut refresh = MemoryRefresh {
            fail_at: Some(RefreshEffect::Sync),
            calls: vec![],
        };
        let execution = execute_refresh(&mut lease, &mut refresh, claim());
        assert_eq!(refresh.calls, vec![RefreshEffect::Sync]);
        assert_eq!(
            execution
                .primary_failure
                .as_ref()
                .and_then(|failure| failure.effect),
            Some(RefreshEffect::Sync)
        );
        assert!(matches!(
            execution.events.last(),
            Some(RefreshEvent::LockReleased(_))
        ));
        assert!(lease.owner.is_none());
    }

    #[test]
    fn query_and_release_failures_are_both_preserved() {
        let mut lease = MemoryLease {
            owner: None,
            fail_release: true,
        };
        let mut refresh = MemoryRefresh {
            fail_at: Some(RefreshEffect::Query),
            calls: vec![],
        };
        let execution = execute_refresh(&mut lease, &mut refresh, claim());
        assert_eq!(
            execution
                .primary_failure
                .as_ref()
                .and_then(|failure| failure.effect),
            Some(RefreshEffect::Query)
        );
        assert_eq!(
            execution.release_failure.as_deref(),
            Some("redis unavailable during release")
        );
    }
}
