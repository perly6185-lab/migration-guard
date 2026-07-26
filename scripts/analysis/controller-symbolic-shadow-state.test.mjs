import test from "node:test";
import assert from "node:assert/strict";
import {
  canReuseControllerShadowCheckpoint,
  controllerShadowSource
} from "./controller-symbolic-shadow-state.mjs";

const cleanIdentity = {
  revision: "abc123",
  dirty: false,
  dirtyFingerprint: "clean-fingerprint",
  identity: "abc123"
};

test("controller shadow source records the complete analyzer source identity", () => {
  assert.deepEqual(controllerShadowSource("/repo", 12, cleanIdentity), {
    root: "/repo",
    routeCount: 12,
    ...cleanIdentity
  });
});

test("controller shadow checkpoint is reusable only for the exact source identity", () => {
  const source = controllerShadowSource("/repo", 12, cleanIdentity);
  const checkpoint = { version: 2, source, total: 12, results: [] };
  assert.equal(canReuseControllerShadowCheckpoint(checkpoint, source, 12), true);
  assert.equal(canReuseControllerShadowCheckpoint({
    ...checkpoint,
    source: { ...source, dirty: true, dirtyFingerprint: "changed", identity: "abc123+dirty:changed" }
  }, source, 12), false);
  assert.equal(canReuseControllerShadowCheckpoint({
    ...checkpoint,
    source: { ...source, revision: "def456", identity: "def456" }
  }, source, 12), false);
});

test("legacy checkpoints without source identity are rejected", () => {
  const source = controllerShadowSource("/repo", 12, cleanIdentity);
  assert.equal(canReuseControllerShadowCheckpoint({
    version: 1,
    root: "/repo",
    total: 12,
    results: []
  }, source, 12), false);
});
