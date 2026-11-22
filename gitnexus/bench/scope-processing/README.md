# Scope capture and binding work

Run `npm run build`, then:

```sh
node --import tsx bench/scope-processing/measure.mjs --check
```

This gates the four repeated-work paths tracked in #3915: namespace snapshots,
crowded Dart/Ruby binding merges, Ruby surviving free calls, and nested Dart
initializers. Each of four sizes runs in a fresh process. Every measurement
checks its output, reports peak RSS and the minimum of six timings after two
warmups, and counts work separately from timing.

Namespace visits and merge inputs must equal the number of prefixes or bindings.
Capture navigation and map visits may grow at most 1.1 times the input growth.
The largest/smallest timing ratio, divided by the eightfold size increase, must
be at most 2.5. These are focused algorithm gates; the existing language
benchmarks and integration tests check full resolution, targets and declines.

For a timing failure, rerun on a quiet machine. A count or output failure is a
regression and must not be hidden by changing a budget. No stored timing or
fingerprint is automatically updated by this command.
