# Browser-to-video clock contract

`src/browser-clock.ts` maps stamped browser action times to finalized video PTS
milliseconds with one fixed offset. It does not estimate a speed factor or
change the existing worker-clock API.

Import `calibrateBrowserClockToVideo`, `mapBrowserActionToVideoPtsMs`, and
`decodeMarkerEdges` from `@jbjmllc/demo-studio/media-clock`; the first two are
also available through `@jbjmllc/demo-studio/browser-clock`.

The decoder takes an explicit marker rectangle and either two uniform RGB
colors (`kind: 'uniform-rgb'`) or declared channel ranges and an off-state
predicate (`kind: 'rgb-range'`). It uses the original rectangle, including
odd-sized geometry, and actual finalized frame PTS without frame-rate
resampling. A range marker declares an on-pixel fraction and a separate
not-on threshold; frames between those thresholds remain ambiguous and cause
rejection. Missing edges, single-frame flashes, and unclassified frames must
not be replaced with a convenient later pulse. Keep the full decode report
when rejecting a recording.

## Required evidence

Each calibration is for one recording, context, document, document origin,
browser clock domain/reset, and Node clock domain/reset. Both anchors carry
their own complete identity stamp and must exactly match the expected identity.
The browser source and basis are explicit:

- `performance-relative` means values returned by `window.performance.now()`;
- `performance-origin` means values already expressed as
  `window.performance.timeOrigin + window.performance.now()`.

Both forms remain in the caller's original milliseconds. The mapper never
infers a basis from a value's size, adds `timeOriginMs`, or accepts a bare
number. A different document origin or reset needs a new pair of measured
brackets.

Each edge contains same-evaluation browser `before / applied / after` samples
and Node-monotonic `before / after` values. The browser and Node records must
carry the same evaluation ID. The browser triplet and Node bracket must be
ordered, and this offset-only bridge interval must also be ordered:

```text
[nodeBeforeMs - browserBeforeMs, nodeAfterMs - browserAfterMs]
```

Optional `rafSamplesMs` preserves two raw observations if the emitter has
them. They are not assumed to bracket the mutation: both may occur after it.
When supplied, they must be ordered and no earlier than `appliedMs`. This
contract does not add RAF callbacks or waits.

The final RAF sample must also be inside `afterMs`. Anchor and action stamps
both reject impossible cross-clock durations: the enclosing Node bracket
cannot be shorter than the observed browser bracket. Accepted identities and
evidence references are copied into the result; subsequently editing diagnostic
input does not change the identity under which its mapping was accepted.

The caller declares `expectedStates` for two selected marker transitions; the
states can be equal or different (for example, a leading off-transition and a
trailing on-transition). Each requires the decoder's actual preceding frame
and first changed frame, with adjacent frame indices and the closed PTS bracket
`[precedingTimeMs, firstChangedTimeMs]`. A missing predecessor (including at
frame zero) is missing evidence, never a fabricated timestamp. Both browser
and Node evaluation brackets, and both video PTS brackets, must be disjoint and
chronologically ordered.

Every input must also declare `precision` with finite, non-negative
`browserTimestampErrorMs`, `nodeTimestampErrorMs`, and `videoPtsErrorMs` bounds.
There are no guessed defaults: unknown or missing precision fails closed.
Ground these values in the actual timestamp measurement/quantization
resolution. Zero is suitable for the exact synthetic fixtures here, not a
substitute for measuring real timestamp precision.
The declared bounds must cover every mapped action as well as the marker
samples, including any rounding performed by the emitter.

The expected binding and both anchors must agree exactly on hashed event,
context, source-file, and finalized-video evidence references. Hashes are
integrity inputs supplied by the caller. The module checks their shape and
equality; it does not authenticate who produced them, prove that a caller
selected the right recording, or claim that visual pixels encode an ID. The
caller must bind these references to the actual emitter artifacts and the
exact finalized video bytes.

## Fixed mapping and uncertainty

For each edge `i`, let `V_i` be the midpoint of its closed video PTS bracket,
`B_i` its browser applied timestamp, and `H_i` half the width of its observed
video bracket. Let `Rraw_i` be half the width of the unexpanded browser-to-Node
bridge interval; `Berr`, `Nerr`, and `Verr` are the three declared precision
bounds. The bridge endpoints are expanded by `Berr + Nerr`, so:

```text
R_i = Rraw_i + Berr + Nerr
```

The only mapping is `videoPtsMs = browserMs + offsetMs`, where:

```text
centerOffset_i = V_i - B_i
offset = mean(centerOffset_leading, centerOffset_trailing)
signedDrift = centerOffset_trailing - centerOffset_leading
uncertaintyRadius = max_i(abs(centerOffset_i - offset) + H_i + R_i + Berr + Verr)
```

Thus the added precision allowance beyond the raw bridge half-width is exactly
`2 * Berr + Nerr + Verr`. Video-edge, bridge, browser-applied, and PTS precision
terms are composed conservatively; no correlation or cancellation is assumed.
The result reports the precision bounds, fixed numeric-only raw snapshot, both
PTS brackets, offset mapping, drift, and uncertainty as separate fields,
including on failure. The raw snapshot copies only declared numeric fields
(with invalid/non-finite values represented as `null`), strips all extra
properties and strings, and is frozen; accepted identity and evidence copies
are returned separately. A failed report may retain a diagnostic offset
candidate, but its mapping is marked unusable and the action mapper throws.

The only quality gate is `ceil(1000 / fps)` milliseconds: exactly `34 ms` at
`30 fps`. Drift magnitude and composed uncertainty must each be no greater
than that value. There is no edge preference, timing padding, or tolerance
widening. `mapBrowserActionToVideoPtsMs` additionally requires a stamped action
whose full clock identity and event/context/file/video evidence binding match
the successful calibration, and rejects action timestamps outside the browser
interval between its leading and trailing applied samples.

## Coverage limits

A calibration supports only the browser interval bracketed by its two declared
transitions. A short pulse proves timing only around that pulse; it does not
establish synchronization across an entire recording. For full-capture claims,
the caller must select real start/end sentinels that bracket the content (or
provide additional independent mapped calibrations and explicit coverage
evidence). Never extrapolate this result and describe it as whole-video sync.

The evaluation IDs, identity strings, and hashes are caller-provided evidence
links. Structural validation detects mismatches and malformed brackets, but
cannot prove their external provenance by itself.
