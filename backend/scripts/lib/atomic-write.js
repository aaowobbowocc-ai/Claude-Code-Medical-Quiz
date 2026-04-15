// Atomic JSON write + cross-process file lock for shared bank files.
//
// Why both:
//   - Atomic write (tmp + rename) prevents server.js from reading a half-written
//     JSON if it happens to load while the scraper is mid-write. POSIX rename
//     is atomic; Windows fs.renameSync is atomic on the same volume.
//   - The .lock file (writeFileSync with `flag: 'wx'`) prevents two scrapers
//     from clobbering each other when run in parallel by mistake.
//
// Used by scrape-moex.js shared-bank mode and (eventually) the existing
// per-exam scrape path.

const fs = require('fs');
const path = require('path');

function lockPath(filePath) {
  return filePath + '.lock';
}

// Acquire an exclusive lock by creating <file>.lock with O_EXCL.
// Returns a release() function. Throws a friendly error if already locked.
function acquireLock(filePath) {
  const lp = lockPath(filePath);
  try {
    fs.writeFileSync(lp, String(process.pid), { flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') {
      let holder = '';
      try { holder = fs.readFileSync(lp, 'utf-8'); } catch { /* ignore */ }
      throw new Error(
        `another writer is holding ${path.basename(lp)} (pid=${holder || '?'}). ` +
        `If no scraper is running, delete the .lock file and retry.`
      );
    }
    throw e;
  }
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    try { fs.unlinkSync(lp); } catch { /* already gone */ }
  };
}

// Write JSON atomically: serialize → tmp → rename. Caller is responsible for
// holding the lock (use withLock() wrapper for one-shot writes).
function atomicWriteJson(filePath, data) {
  const tmp = filePath + '.tmp';
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, filePath);
}

// Convenience: acquire lock, write, release — even on throw.
function withLock(filePath, fn) {
  const release = acquireLock(filePath);
  try {
    return fn();
  } finally {
    release();
  }
}

module.exports = { acquireLock, atomicWriteJson, withLock, lockPath };
