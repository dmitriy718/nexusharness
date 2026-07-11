# NexusHarness control plane

The control plane coordinates all repository work. It prevents overlapping edits, records completion notes, maintains the issue board, and supports release readiness.

## Normal workflow

1. Read AGENTS.md and control/AGENTS.md.
2. Run npm run control:status.
3. Read control/issues/BOARD.md.
4. Acquire the smallest practical claim:

       npm run control:claim -- --agent NAME --task "TASK" --area "src/feature/**" --resource routing --impact minor --issue NH-0001

5. Renew long work:

       npm run control:heartbeat -- --claim CLAIM_ID

6. Verify the work.
7. Release it with complete notes:

       npm run control:release -- --claim CLAIM_ID --summary "SUMMARY" --files "FILES" --verification "COMMANDS AND RESULTS" --worked "WHAT WORKED" --didnt "WHAT DID NOT" --unfinished "REMAINING WORK OR none"

## Stale claims

A stale claim remains a conflict. Do not delete it. After verifying that its agent is no longer active:

    npm run control:takeover -- --claim STALE_ID --agent NAME --reason "WHY TAKEOVER IS SAFE"

The old record is archived as superseded and the replacement receives a new ID.

## Board and verification

Issue files under control/issues/items are authoritative. Regenerate the board after changing them:

    npm run control:board
    npm run control:verify

Active claim files and mutex data are local operational state. Released and superseded claims, issue files, board snapshots, release records, and worklogs are committed.
