# Agent workflow

Demo Studio's skills work as independent entry points, but a public walkthrough normally follows this order:

1. **Clarify:** use `demo-brief` to identify the viewer, task, supported outcome, scope, and evidence.
2. **Teach:** use `demo-storyboard` to arrange product-grounded Before / During / After / Say / Do / Learn / Next beats.
3. **Narrate:** use `demo-narration` to connect the story and cover every visible click, typed value, and drag without reading control labels aloud.
4. **Approve exact words:** use `demo-story-review` for one decision at a time. Preserve a separate hash-bound working decision record; a preview is marked as a draft, never treated as consent.
5. **Capture:** use `browser-demo-recording` to drive the actual product in one continuous browser recording and preserve readable transitions.
6. **Audit:** ask someone who did not write the narration to independently compare the final video and audio with the approved story. Escalate P0/P1 findings for operator review. The review receipt labels identity assurance `caller-attested`; the tool cannot authenticate the person or verify the claimed role, so verify independence through the surrounding review process. Without independent semantic review, the status is inconclusive.

One person may run the stages sequentially; paid multi-agent services are not required. When a genuinely independent reviewer is unavailable, do not represent the result as approved or ready to publish.

## Change and retry rules

Track answers as they are given so you do not ask the same material question twice. A change to approved wording or the product state invalidates affected decisions and their downstream capture or review. Regenerate from the earliest changed input. Stop after the first complete pass and cap any revision loop at six rounds; six is a ceiling, not a goal.

Every finding should name evidence and an owning stage. Missing frames, audio, hash inputs, or reviewer independence are inconclusive, not passes. Fix P0/P1 issues before sharing and record any accepted lower-severity finding explicitly.
