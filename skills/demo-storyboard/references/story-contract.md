# Story contract

## Product proof before polish

Make claims from current source, tests, documentation, or a real product state. Link each important claim to the evidence that supports it. If the behavior cannot be demonstrated, narrow the claim or mark the gap; narration is not proof.

Keep the feature's essential behavior distinct from incidental navigation. Shorten setup only when it does not remove the requested interaction or its visible result. If the feature changes product state, show a meaningful before and after.

## Scene card

Use one primary purpose per scene and fill these fields:

- **Before:** what the viewer can see before the interaction.
- **During:** what the real product visibly changes.
- **After:** the resulting state that remains readable long enough to understand.
- **Say:** the intended spoken thought; later revisions must be hash-bound and exact.
- **Do:** semantic actions and their user purpose, not CSS selectors or coordinates.
- **Learn:** one useful idea the viewer should retain.
- **Next:** how this result sets up the next scene.

Scenes should form one connected explanation: orient the viewer, show a meaningful decision or change, interpret the result, and resolve the opening promise. A collection of correct but disconnected click descriptions is not a storyboard.

## Review the composition

Check that the full frame contains the promised evidence before and after state changes. A resize must keep nearby evidence visible and legible. A share action must reach a real read-only destination when sharing is part of the claim. Identify needed viewport, responsive, empty-state, or accessibility checks before recording.

Keep selectors, coordinates, recorder-specific IDs, and exact low-level action sequences in the capture plan, not in the story. Do not shape the story around an existing recording. Consider reuse only after the story is locked and compare it against the approved scene and proof requirements.
