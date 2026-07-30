import assert from "node:assert/strict";
import test from "node:test";
import { LeaseLockStore, RefreshCoordinator, executeRefresh, validateRefreshTrace } from "./vmpRefresh.js";

test("successful manual refresh orders sync, post-effects, query and unlock", () => {
  const report = validateRefreshTrace({
    mode: "manual",
    syncSucceeded: true,
    effects: ["sync", "timestamp", "undo-clear", "reconcile", "query", "unlock"]
  });
  assert.equal(report.passed, true);
});

test("failed sync does not query, timestamp, or clear undo, but still unlocks", () => {
  const report = validateRefreshTrace({ mode: "manual", syncSucceeded: false, effects: ["sync", "unlock"] });
  assert.equal(report.passed, true);
  const invalid = validateRefreshTrace({ mode: "manual", syncSucceeded: false, effects: ["sync", "query", "unlock"] });
  assert.deepEqual(invalid.issues.map((issue) => issue.code), ["query-after-sync-failure"]);
  assert.equal(validateRefreshTrace({ mode: "manual", syncSucceeded: false, effects: ["sync", "reconcile", "unlock"] }).passed, false);
});

test("refresh rejects reordered and duplicate effects", () => {
  assert.equal(validateRefreshTrace({
    mode: "manual",
    syncSucceeded: true,
    effects: ["sync", "query", "timestamp", "unlock"]
  }).passed, false);
  assert.equal(validateRefreshTrace({
    mode: "manual",
    syncSucceeded: true,
    effects: ["sync", "query", "query", "unlock"]
  }).passed, false);
});

test("query failure still requires unlock and does not invalidate sync ordering", () => {
  const report = validateRefreshTrace({ mode: "manual", syncSucceeded: true, querySucceeded: false, effects: ["sync", "timestamp", "undo-clear", "query", "unlock"] });
  assert.equal(report.passed, true);
  assert.equal(validateRefreshTrace({ mode: "manual", syncSucceeded: true, effects: ["sync", "query"] }).passed, false);
});

test("manual refresh deduplicates and has priority over automatic refresh", () => {
  const coordinator = new RefreshCoordinator();
  assert.equal(coordinator.tryAcquire({ panelId: "p1", mode: "manual" }), true);
  assert.equal(coordinator.tryAcquire({ panelId: "p1", mode: "manual" }), false);
  assert.equal(coordinator.tryAcquire({ panelId: "p1", mode: "auto" }), false);
  coordinator.release({ panelId: "p1", mode: "manual" });
  assert.equal(coordinator.tryAcquire({ panelId: "p1", mode: "auto" }), true);
  assert.equal(coordinator.tryAcquire({ panelId: "p1", mode: "manual" }), false);
});

test("different columns can refresh concurrently but the same column is deduplicated", () => {
  const coordinator = new RefreshCoordinator();
  assert.equal(coordinator.tryAcquire({ panelId: "p1", mode: "column", fieldId: "f1" }), true);
  assert.equal(coordinator.tryAcquire({ panelId: "p1", mode: "column", fieldId: "f1" }), false);
  assert.equal(coordinator.tryAcquire({ panelId: "p1", mode: "column", fieldId: "f2" }), true);
  coordinator.release({ panelId: "p1", mode: "column", fieldId: "f1" });
  assert.equal(coordinator.isHeld("p1", "column", "f2"), true);
});

test("lease lock rejects other owners, expires, and checks owner token on release", () => {
  let now = 100;
  const store = new LeaseLockStore(() => now);
  assert.equal(store.tryAcquire("panel:p1", "node-a", 50)?.expiresAt, 150);
  assert.equal(store.tryAcquire("panel:p1", "node-b", 50), undefined);
  assert.equal(store.release("panel:p1", "node-b"), false);
  now = 151;
  assert.equal(store.tryAcquire("panel:p1", "node-b", 50)?.ownerToken, "node-b");
  assert.equal(store.release("panel:p1", "node-b"), true);
  assert.deepEqual(store.records.map((record) => record.event), [
    "lock-acquired",
    "lock-rejected",
    "lock-release-rejected",
    "lock-acquired",
    "lock-released"
  ]);
});

test("REFRESH executor releases after sync and query failures", async () => {
  const syncEvents: string[] = [];
  await assert.rejects(() => executeRefresh({
    mode: "manual",
    sync: () => { syncEvents.push("sync"); throw new Error("sync failed"); },
    query: () => { syncEvents.push("query"); },
    unlock: () => { syncEvents.push("unlock"); }
  }), /sync failed/);
  assert.deepEqual(syncEvents, ["sync", "unlock"]);

  const queryEvents: string[] = [];
  await assert.rejects(() => executeRefresh({
    mode: "manual",
    sync: () => { queryEvents.push("sync"); },
    query: () => { queryEvents.push("query"); throw new Error("query failed"); },
    unlock: () => { queryEvents.push("unlock"); }
  }), /query failed/);
  assert.deepEqual(queryEvents, ["sync", "query", "unlock"]);
});
