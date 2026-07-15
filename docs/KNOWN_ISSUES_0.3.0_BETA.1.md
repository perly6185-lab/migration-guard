# Known Issues 0.3.0-beta.1

- Handoff and result workflows are CLI-first; the operator UI does not yet expose
  result manifest upload or policy editing.
- Result import accepts unified Git patches only; rename patches are rejected.
- Real-project release pilots require locally configured project roots and are never
  replaced by fixture-only evidence.
- GitHub and release mutations remain separate reviewed flows and are denied by the
  shipped organization policy presets.
- Force rollback remains CLI-only.
