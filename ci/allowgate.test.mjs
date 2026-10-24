import test from 'node:test';
import assert from 'node:assert/strict';

import { reviewDiff, formatFindings } from './review.mjs';

const file = (filename, patch) => ({ filename, patch });

test('打 allow:gate 放行门禁修改，阻断降为提示', () => {
  const r = reviewDiff({ files: [file('scripts/verify.sh', '-set -euo pipefail\n+set +e')], allowGate: true });
  assert.equal(r.ok, true);
  const f = r.findings.find((x) => x.rule === 'gate-modified');
  assert.equal(f.severity, 'warn');
});

test('不打 allow:gate 放行，门禁修改仍阻断', () => {
  const r = reviewDiff({ files: [file('scripts/verify.sh', '-set -euo pipefail\n+set +e')] });
  assert.equal(r.ok, false);
  const f = r.findings.find((x) => x.rule === 'gate-modified');
  assert.equal(f.severity, 'block');
});