# Architecture

Demo Studio separates editorial intent from browser mechanics and media proof. Each stage consumes explicit inputs and writes run-local outputs so a changed story cannot silently inherit stale capture or approval.

```text
request and product evidence
  -> brief
  -> storyboard
  -> connected narration + semantic actions
  -> hash-bound review decisions
  -> browser capture + assertions
  -> media audit + independent semantic review
  -> approved deliverable
```

## Stage ownership

- **Brief:** viewer, task, outcome, proof, constraints, and non-goals.
- **Storyboard:** scene order and Before / During / After / Say / Do / Learn / Next intent. It describes what the viewer should understand, not selectors.
- **Narration and actions:** canonical spoken text and real browser actions are mapped together. Every active click, typed value, and drag has a spoken anchor and visible postcondition.
- **Review:** the interactive story review preserves exact words and decision hashes in its working record. The runtime's wording digest is an integrity check, not proof of human consent; the separate `review.json` binds semantic findings to exact mission, packet, plan, and video hashes. Its receipt labels identity assurance as `caller-attested`; reviewer identity and type are local declarations, not authenticated identities. A draft preview is never approval.
- **Capture:** Playwright drives the actual app with the declared viewport and stable accessible locators. The recording is checked against the plan and assertions.
- **Audit:** an independent reviewer samples real video and audio, including active actions, transitions, and the final third. Findings return to their earliest owning stage.

The default workspace is `.demo-studio/<run-name>/`; the plan remains in source control, while generated media and run receipts stay in the declared workspace. Do not reuse a prior capture merely because it exists. Reuse is valid only if it still proves the exact approved scene and state.

## Validation boundaries

Static plan validation checks required fields and action mappings. Browser assertions establish that the app reached the expected state. The media audit verifies what the viewer actually sees and hears. None of these replaces the independent semantic review needed before publication.

One person can run all production stages sequentially. Independent review is a quality gate, not a requirement to buy a multi-agent service. The production reviewer must be separate from the narration author as an external workflow rule. The runtime only compares the declared reviewer ID with the producer fingerprint; it cannot verify a person's real-world identity. If the host cannot provide a genuinely separate reviewer, keep the result inconclusive and do not publish it.
