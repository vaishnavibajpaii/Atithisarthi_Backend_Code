"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..", "..");
const read = (relativePath) => fs.readFileSync(path.join(projectRoot, relativePath), "utf8");

const kitchenHtml = read("frontend/kitchen-display.html");
const staffHtml = read("frontend/staff-orders.html");
const staffJs = read("frontend/js/staff-orders.js");
const qrHtml = read("frontend/qr-order-status.html");
const qrCss = read("frontend/css/qr-order-status.css");
const qrJs = read("frontend/js/qr-order-status.js");
const publicQrRoute = read("backend/routes/public-qr.js");

function activeMarkup(html) {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

function getIds(html) {
  return [...activeMarkup(html).matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)].map(
    (match) => match[1]
  );
}

function assertUniqueIds(html, label) {
  const ids = getIds(html);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepStrictEqual([...new Set(duplicates)], [], `${label} contains duplicate IDs`);
}

function getScripts(html) {
  return [...activeMarkup(html).matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*><\/script>/gi)]
    .map((match) => ({ src: match[1], tag: match[0] }));
}

assertUniqueIds(kitchenHtml, "kitchen-display.html");
assertUniqueIds(qrHtml, "qr-order-status.html");
assert.match(kitchenHtml, /params\.set\("mode", "kds-display"\)/);
assert.match(kitchenHtml, /window\.location\.replace\(target\)/);
assert.match(kitchenHtml, /id="kdsFallbackLink"/);
assert.match(kitchenHtml, /role="status" aria-live="polite"/);
assert.match(kitchenHtml, /min-height:\s*100dvh/);
assert.match(kitchenHtml, /overflow-wrap:\s*anywhere/);

const staffScripts = getScripts(staffHtml);
assert(staffScripts.length >= 10, "Expected Staff Orders dependency chain");
staffScripts.forEach(({ src, tag }) => {
  assert(/\bdefer\b/i.test(tag), `${src} must be deferred`);
});
assert.match(staffHtml, /\/\* ===== KDS DISPLAY RELEASE SAFETY ===== \*\//);
assert.match(
  staffHtml,
  /body\.is-kds-display-mode #staffKitchenDisplayAlert\[hidden\]\s*\{\s*display:\s*none;/
);
assert.match(staffHtml, /body\.is-kds-display-mode \.staff-kds-grid\s*\{[\s\S]*?max-width:\s*100%/);
assert.match(staffHtml, /overflow-wrap:\s*anywhere/);
assert.match(
  staffHtml,
  /@media \(max-width: 600px\)[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/
);
assert.match(staffHtml, /overscroll-behavior-inline:\s*contain/);
assert.match(staffJs, /if \(!document\.hidden\) updateStaffKitchenDisplayClock\(\)/);
assert.match(
  staffJs,
  /staffAutoRefreshTimer = window\.setInterval\(\(\) => \{\s*void refreshStaffOperationalData\(\{ silent: true \}\);\s*\}, intervalMs\);/
);
assert.match(staffJs, /const requestController = new AbortController\(\)/);
assert.match(staffJs, /STAFF_KDS_AUTO_REFRESH_INTERVAL_MS = 5 \* 1000/);
assert.match(
  staffJs,
  /staffAutoRefreshInFlight \|\|[\s\S]*?!getStaffToken\(\)[\s\S]*?isStaffActionInProgress\(\)/
);
assert.match(
  staffJs,
  /document\.addEventListener\("visibilitychange"[\s\S]*?if \(document\.hidden\)[\s\S]*?refreshStaffOperationalData\(\{ silent: true \}\)/
);

const qrScripts = getScripts(qrHtml);
assert.deepStrictEqual(qrScripts.map(({ src }) => src), [
  "js/app-config.js",
  "js/qr-order-status.js"
]);
qrScripts.forEach(({ src, tag }) => {
  assert(/\bdefer\b/i.test(tag), `${src} must be deferred`);
});
assert.match(qrHtml, /class="qr-skip-link" href="#qrStatusMain"/);
assert.match(qrHtml, /id="qrStatusMain"[^>]*aria-busy="true"[^>]*tabindex="-1"/);
assert.match(qrHtml, /id="qrStatusBadge"[^>]*role="status"[^>]*aria-live="polite"/);
assert.match(qrHtml, /id="qrItemsList"[^>]*aria-busy="true"/);

assert.match(qrCss, /min-height:\s*100dvh/);
assert.match(qrCss, /overflow-x:\s*clip/);
assert.match(qrCss, /overflow-wrap:\s*anywhere/);
assert.match(qrCss, /@media \(max-width: 560px\)/);
assert.match(qrCss, /@media \(max-width: 390px\)/);
assert.match(qrCss, /@media \(prefers-reduced-motion: reduce\)/);
assert.strictEqual((qrCss.match(/!important/g) || []).length, 0);

assert.match(qrJs, /draftNote:\s*""/);
assert.match(qrJs, /let loadInFlight = false/);
assert.match(qrJs, /if \(loadInFlight\) return/);
assert.match(qrJs, /document\.visibilityState === "visible"/);
assert.match(qrJs, /document\.addEventListener\("visibilitychange"/);
assert.match(qrJs, /state\.draftNote = event\.target\.value/);
assert.match(qrJs, /note:\s*state\.draftNote/);
assert.match(
  qrJs,
  /error\.payload\?\.code === "QR_SUBMISSION_CHANGED"[\s\S]*?state\.editing = false;[\s\S]*?await load/
);
assert.match(qrJs, /function getPublicMessage\(/);
assert.match(qrJs, /aria-busy", "false"/);
assert.match(
  qrJs,
  /\/public\/qr\/submissions\/\$\{encodeURIComponent\(publicReference\)\}/
);
assert.match(
  publicQrRoute,
  /router\.use\(\(req, res, next\) => \{[\s\S]*?res\.set\("Cache-Control", "no-store"\);[\s\S]*?next\(\);/
);
assert.match(publicQrRoute, /QR_SUBMISSION_CHANGED/);
assert.match(publicQrRoute, /expectedRoundVersion/);

console.log("KDS and QR order-status production verification passed.");
console.log(
  JSON.stringify(
    {
      kitchenHtmlBytes: Buffer.byteLength(kitchenHtml),
      staffHtmlBytes: Buffer.byteLength(staffHtml),
      staffJsBytes: Buffer.byteLength(staffJs),
      qrHtmlBytes: Buffer.byteLength(qrHtml),
      qrCssBytes: Buffer.byteLength(qrCss),
      qrJsBytes: Buffer.byteLength(qrJs),
      staffScriptsDeferred: staffScripts.length,
      qrScriptsDeferred: qrScripts.length,
      qrImportantCount: (qrCss.match(/!important/g) || []).length,
      kitchenIds: getIds(kitchenHtml).length,
      qrIds: getIds(qrHtml).length
    },
    null,
    2
  )
);
