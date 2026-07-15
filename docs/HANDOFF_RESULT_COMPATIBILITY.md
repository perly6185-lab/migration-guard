# Handoff And Result Compatibility

| Artifact | Current writer | Accepted reader versions |
| --- | --- | --- |
| AI handoff | `migration-guard.ai-handoff/v1` | v1 |
| AI result | external `migration-guard.ai-result/v1` | v1 |
| Snapshot | core artifact v2 | v1 payload, v2 envelope |
| Compare | core artifact v2 | v1 payload, v2 envelope |
| UI job | core artifact v2 | v1 payload, v2 envelope |

Unknown future versions, hash mismatches, stale policy lineage and missing evidence
are rejected. Replan briefs remain readable legacy context and may be referenced by a
v1 handoff without conversion.
