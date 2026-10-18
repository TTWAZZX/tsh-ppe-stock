import assert from 'node:assert/strict';
import { getNextPpeCode, getPpeCodeSequence } from '../lib/ppe-code.js';

assert.equal(getPpeCodeSequence('PPE001'), 1);
assert.equal(getPpeCodeSequence('ppe038'), 38);
assert.equal(getPpeCodeSequence(' PPE1000 '), 1000);
assert.equal(getPpeCodeSequence('ITEM001'), null);
assert.equal(getPpeCodeSequence('PPE-001'), null);

assert.equal(getNextPpeCode([]), 'PPE001');
assert.equal(getNextPpeCode([{ code: 'PPE001' }, { code: 'PPE038' }]), 'PPE039');
assert.equal(getNextPpeCode(['ppe099', 'custom', 'PPE100']), 'PPE101');
assert.equal(getNextPpeCode([{ code: 'PPE999' }]), 'PPE1000');

console.log('PPE code generation tests passed');
