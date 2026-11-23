# TypeScript property dispatch fan-out

Build the package and run the current behavior benchmark:

```sh
npm run build
node bench/typescript-property-dispatch/measure.mjs --check
```

From the same harness, `--root /path/to/built/gitnexus` selects another build.
Leave `GITNEXUS_MAX_PROPERTY_DISPATCH_FANOUT` unset for both. The runner checks
every caller and target identity, the fixture hash, and the exact counts of
registration edges. The unrelated Worker calls also have exact
`Worker.execute` edges. A genuine `controls.onReady()` call checks that the
dispatch can still reach its registered function.

| Calls on Worker | Registrations for `execute` | Exact Worker edges | Speculative edges to plugins |
| ---: | ---: | ---: | ---: |
| 64 | 8 | 64 | 512 |
| 256 | 8 | 256 | 2,048 |
| 64 | 32 | 64 | 2,048 |
| 256 | 32 | 256 | 8,192 |
| 256 | 33 | 256 | 0 |

At or below the registration cap the speculative edge count is call sites
times distinct registrations. Above the cap the entire key is skipped. Both
the pristine and TypeScript ingestion builds produced the same identities
on this corpus. The timings are three cold worker-ingestion samples per
shape after warmup. They include parsing and resolution, with graph publication
and derived phases outside the timer. Peak RSS is for the process across
all shapes. The check gates deterministic workload and edge identities.

This is the current behavior measured for [#3924](https://github.com/abhigyanpatwari/GitNexus/issues/3924).
