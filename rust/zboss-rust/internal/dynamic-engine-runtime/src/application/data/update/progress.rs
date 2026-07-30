#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Stage {
    Accepted,
    Validating,
    Writing,
    Committed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Progress {
    pub stage: Stage,
    pub processed: usize,
    pub failed: usize,
    pub total: usize,
}

impl Progress {
    pub fn accepted(total: usize) -> Self {
        Self {
            stage: Stage::Accepted,
            processed: 0,
            failed: 0,
            total,
        }
    }

    pub fn advance(
        &mut self,
        stage: Stage,
        processed: usize,
        failed: usize,
    ) -> Result<(), &'static str> {
        if matches!(self.stage, Stage::Committed | Stage::Failed) {
            return Err("progress already terminal");
        }
        if stage < self.stage
            || processed < self.processed
            || failed < self.failed
            || processed + failed > self.total
        {
            return Err("invalid progress transition");
        }
        if matches!(stage, Stage::Committed | Stage::Failed) && processed + failed != self.total {
            return Err("terminal counters must equal total");
        }
        self.stage = stage;
        self.processed = processed;
        self.failed = failed;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_is_conserved_and_unique() {
        let mut progress = Progress::accepted(2);
        progress.advance(Stage::Validating, 0, 1).unwrap();
        progress.advance(Stage::Writing, 1, 1).unwrap();
        progress.advance(Stage::Committed, 1, 1).unwrap();
        assert!(progress.advance(Stage::Committed, 1, 1).is_err());
    }
}
