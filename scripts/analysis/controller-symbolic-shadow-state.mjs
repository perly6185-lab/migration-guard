export function controllerShadowSource(root, routeCount, sourceIdentity) {
  return {
    root,
    routeCount,
    revision: sourceIdentity.revision,
    dirty: sourceIdentity.dirty,
    dirtyFingerprint: sourceIdentity.dirtyFingerprint,
    identity: sourceIdentity.identity
  };
}

export function canReuseControllerShadowCheckpoint(checkpoint, source, total) {
  return checkpoint?.version === 2
    && checkpoint.total === total
    && sameControllerShadowSource(checkpoint.source, source)
    && Array.isArray(checkpoint.results);
}

function sameControllerShadowSource(left, right) {
  return left?.root === right.root
    && left?.routeCount === right.routeCount
    && left?.revision === right.revision
    && left?.dirty === right.dirty
    && left?.dirtyFingerprint === right.dirtyFingerprint
    && left?.identity === right.identity;
}
