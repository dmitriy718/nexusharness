# NexusHarness agent bootstrap

These rules apply to every agent and every file in this repository.

1. Read control/AGENTS.md completely before doing project work.
2. Run npm run control:status and inspect control/issues/BOARD.md.
3. Before changing files, acquire an exclusive claim for every affected path and logical resource with npm run control:claim.
4. Do not edit, format, generate, move, or delete anything that overlaps another active claim.
5. Keep long work alive with npm run control:heartbeat.
6. Before releasing a claim, run the relevant verification and record files changed, what worked, what did not, unfinished work, and version impact.
7. Release through npm run control:release. Never delete an active claim by hand.

The only exception is the one-time control-plane bootstrap described in UXUI/plans.md. That exception ends as soon as the first control-plane-bootstrap claim is acquired.
