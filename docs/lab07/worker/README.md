# M4.2 — Web Worker decoding experiment

## Setup
Three 30-second runs per mode, 9 players in Performance Arena, binary codec, no simulated network delay/jitter/drop. Each run decoded 900 snapshots and 30 pong messages. All runs valid; no errors, fallbacks or Worker failures.

## Results

| Run | Main-thread work mean (ms/message) | Main-thread total (ms) | Frame work p99 (ms) | FPS |
|---|---:|---:|---:|---:|
| main-1 | 0.260 | 242.0 | 0.900 | 60.013 |
| main-2 | 0.225 | 209.6 | 0.800 | 60.014 |
| main-3 | 0.230 | 214.0 | 0.800 | 60.019 |
| worker-1 | 0.271 | 252.2 | 0.900 | 59.999 |
| worker-2 | 0.317 | 294.6 | 0.900 | 60.032 |
| worker-3 | 0.278 | 258.8 | 0.900 | 60.031 |

## Comparison

| Metric | Main | Worker |
|---|---:|---:|
| Main-thread total, mean per run (ms) | 221.867 | 268.533 |
| Main-thread work, mean (ms/message) | 0.239 | 0.289 |
| Decode + validation, mean (ms) | 0.239 | 0.168 |
| Main-thread work p99 (ms) | 0.567 | 0.567 |
| Frame work p99 (ms) | 0.833 | 0.900 |
| Round-trip mean (ms) | — | 0.798 |
| Round-trip p99 (ms) | — | 2.200 |
| Estimated messaging overhead mean (ms) | — | 0.630 |
| Transferred buffers (all runs) | 0 | 2700 |
| Max pending requests | 0 | 2 |
| Decode errors / fallbacks | 0 / 0 | 0 / 0 |

Percentiles in the comparison table are arithmetic means of per-run percentiles, not pooled percentiles.

## Decision

Keep main-thread decoding as default and retain Worker as an opt-in profiling experiment. Worker offloads decode and validation but measured main-thread work rises by 21.03% (+46.67 ms per 30-second run). No meaningful FPS improvement is observed. The 2700 transferred buffers demonstrate that the binary input uses the transfer path, while decoded objects are returned via structured clone.

## Limitations
- Measured main-thread work covers decode/validation in main mode and postMessage plus response bookkeeping in worker mode. Internal structured clone costs may not be fully captured.
- Estimated overhead includes queue wait, scheduling, delivery and structured clone; not a direct measure of copying or CPU usage.
- Payload sizes and game states differ between runs. Seed and restart/warm-up procedure are not verified by the JSON; cumulative server pool counters continue across the two mode groups, suggesting a continuous server session.
- Three sequential runs per mode on one system do not establish universal performance or causality for other metrics.
