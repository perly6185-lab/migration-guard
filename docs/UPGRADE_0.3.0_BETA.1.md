# Upgrade to 0.3.0-beta.1

1. Run `migration-guard doctor --upgrade` and `migration-guard artifacts migrate`.
2. Keep config schema version 1; existing v1 artifacts remain readable.
3. Add `policy.preset` explicitly only after reviewing its resolved `policy explain`
   output and hash. Unconfigured projects retain legacy limits.
4. Create fresh handoffs after changing policy; old result imports fail closed.
5. Capture a fresh baseline before importing external agent results.

The beta does not automate npm publish, Git tags, GitHub Releases or third-party AI
credentials.
