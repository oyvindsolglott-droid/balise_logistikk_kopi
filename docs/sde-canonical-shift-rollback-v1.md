# SDE canonical shift rollback runbook v1

Contract: `SDE-CANONICAL-SHIFT-ROLLBACK-20260822-V1`

This runbook restores the product tree that existed at
`acf02a455cff4ba6275ac0ab388a138d05b47f5a` by creating ordinary revert
commits. It never rewrites Git history and never edits production data.

## Preconditions

1. Before the technical checkpoint, materialize the exact candidate worktree
   as a temporary commit in a disposable source clone. After the ordinary
   Phase A commit, repeat the drill against the immutable branch `HEAD`.
2. Resolve and record the exact temporary or branch candidate SHA and tree in
   the generated evidence report.
3. Confirm that the previous product SHA is an ancestor of the candidate.
4. Confirm that the three protected live-data files exist and record their
   SHA-256 values.
5. Use an already installed compatible Node dependency tree through
   `SDE_ROLLBACK_NODE_PATH`; do not install or upgrade dependencies during the
   drill.

Until the exact worktree snapshot has passed the disposable drill, legacy
operative generators must remain enabled and the migration status is
`HOLD — TESTED ROLLBACK TO PREVIOUS ENGINE IS NOT AVAILABLE`. The snapshot
drill permits local deactivation; the later commit-bound repeat is mandatory
before branch push.

## Disposable drill

Before checkpoint, run:

```text
SDE_ROLLBACK_NODE_PATH=/absolute/read-only/server/node_modules \
node scripts/test-sde-canonical-shift-rollback.cjs --worktree-candidate
```

After the ordinary Phase A commit, run again without the snapshot flag:

```text
SDE_ROLLBACK_NODE_PATH=/absolute/read-only/server/node_modules \
node scripts/test-sde-canonical-shift-rollback.cjs
```

The script performs these operations in newly created temporary local clones:

1. checks out the previous product SHA on a disposable branch;
2. applies either the exact disposable snapshot commit or every committed
   Phase A commit in chronological order with `git cherry-pick`;
3. verifies that the resulting tree equals the exact candidate tree;
4. runs the candidate focused smoke tests;
5. creates actual `git revert --no-edit` commits in reverse commit order;
6. verifies that the reverted tree equals the previous product tree;
7. starts the reverted server only on disposable loopback state by invoking
   the established static-delivery smoke;
8. verifies schema/runtime readback and deployability through that smoke;
9. proves that protected live-data bytes are unchanged;
10. emits a JSON evidence record binding baseline, candidate, applied commits,
    revert commits, tree hashes, data hashes and test results.

The drill never restarts the production server and never loads, unloads or
changes the production syncworker.

## Controlled production rollback after a future approved deployment

If a rollback is later authorized, create normal revert commits for the
merged Phase A commit range in reverse order, qualify the resulting candidate,
merge through the ordinary protected-branch path, fast-forward the production
repository, and follow the SDE release-gate procedure for worker isolation,
server restart when required, health/readback, data continuity and worker
recovery. Do not use reset, rebase, force, force-with-lease, manual database
editing, schema downgrade, history deletion, or direct push to `main`.

## Preservation guarantees

- The engine migration is code- and projection-only; it contains no destructive
  database migration.
- Completed card history and actual placement remain server-authoritative.
- Reservations and future claims never become actual placement.
- Tursatt and Balise live-data files are read-only inputs to the drill.
- Any data hash change, missing dependency, failed candidate smoke, failed
  reverted smoke, non-empty baseline diff, or unavailable exact candidate SHA
  makes the drill RED and keeps legacy operative generators enabled.
