"use strict";

function createDependencyHealth({ probe, timeoutMs = 2000, cacheMs = 5000, now = Date.now } = {}) {
  if (typeof probe !== "function") throw new TypeError("A read-only dependency probe is required");
  let pending;
  let shared;
  let cached;
  let observedAt = -Infinity;
  return async function dependencyHealth() {
    if (cached && now() - observedAt < cacheMs) return { ...cached };
    if (shared) return { ...await shared };
    if (pending) return { ready: false, issue: "dependency_unavailable" };
    let timer;
    const work = Promise.resolve().then(probe);
    pending = work;
    work.then(() => { if (pending === work) pending = null; }, () => { if (pending === work) pending = null; });
    shared = (async () => {
      try {
        const ready = await Promise.race([work.then(() => true, () => false),
          new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
        cached = { ready, issue: ready ? "" : "dependency_unavailable" };
        observedAt = now();
        return { ...cached };
      } finally {
        clearTimeout(timer);
      }
    })();
    try { return { ...await shared }; }
    finally { shared = null; }
  };
}

module.exports = { createDependencyHealth };
