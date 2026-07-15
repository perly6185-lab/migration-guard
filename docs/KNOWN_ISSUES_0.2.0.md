# Known Issues in 0.2.0

- The operator UI is local-only and does not provide authentication or TLS termination. Bind it to a trusted interface or place it behind an authenticated proxy.
- Job recovery never automatically replays mutation-capable commands. Review the recovery plan and start an explicit retry.
- Artifact Schema v1 remains readable, but metadata is only complete after an explicit v2 migration or a fresh run.
- npm publication, Git tags and GitHub Releases remain reviewed manual operations.
- Real-project pilots depend on locally configured project roots and are intentionally NO-GO when any root is missing.
