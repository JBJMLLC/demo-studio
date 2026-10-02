# Skills

Each skill has its own short entrypoint and can be used independently. A single assistant or operator can move through the stages sequentially. The skills do not require a paid multi-agent service. Before publication, however, someone other than the narration author must independently review the actual screen, audio, and proof; without that review, the correct status is inconclusive.

| Skill | Use it when | It owns |
| --- | --- | --- |
| [`demo-brief`](../skills/demo-brief/SKILL.md) | The viewer, goal, evidence, or scope needs clarification. | A grounded brief and cached editorial decisions. |
| [`demo-storyboard`](../skills/demo-storyboard/SKILL.md) | A brief needs to become a coherent teaching sequence. | Product-grounded Before / During / After / Say / Do / Learn / Next scenes. |
| [`demo-narration`](../skills/demo-narration/SKILL.md) | The approved story needs natural spoken words. | Connected narration with coverage for each visible active action. |
| [`demo-story-review`](../skills/demo-story-review/SKILL.md) | A person must approve exact scenes or wording before capture. | One-at-a-time review, a hash-bound working decision ledger, and explicit wording approval. |
| [`browser-demo-recording`](../skills/browser-demo-recording/SKILL.md) | An approved plan is ready for real browser capture. | Human-paced browser actions, state evidence, and run-scoped outputs. |
| [`demo-audit`](../skills/demo-audit/SKILL.md) | Captured media needs an independent quality verdict. | Screen/audio sampling, issue severity, and bounded repair. |

## A useful sequence

```text
brief -> storyboard -> narration -> exact-word review -> browser capture -> independent audit
```

The story decision ledger is separate from the runtime's generated `review-packet.json` and reviewer-authored semantic `review.json`. Its receipt labels reviewer identity with `identityAssurance: caller-attested`; the local fingerprint check is not identity authentication. Arrange a genuinely independent human review outside the tool.

You can stop after any stage and resume from its durable artifact. Do not treat an earlier approval as current after its inputs change. The [architecture guide](architecture.md) explains the artifact boundaries.
