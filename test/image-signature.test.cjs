const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ImageSignatureValidator } = require('../dist/plate-recognition/image-signature.validator');
test('OCR accepts supported signatures and rejects disguised documents without parsing them', () => {
  const validator = new ImageSignatureValidator();
  for (const [mimetype, bytes] of [
    ['image/jpeg', [255, 216, 255]],
    ['image/png', [137, 80, 78, 71, 13, 10, 26, 10]],
    ['image/webp', [...Buffer.from('RIFF0000WEBP')]],
  ]) {
    const buffer = Buffer.alloc(16); Buffer.from(bytes).copy(buffer);
    assert.equal(validator.isValid({ mimetype, buffer }), true);
    assert.equal(validator.isValid({ mimetype: 'application/zip', buffer }), false);
  }
  assert.equal(validator.isValid(), false);
  assert.equal(validator.isValid({ mimetype: 'image/png', buffer: Buffer.from('PK00000000000000') }), false);
  assert.equal(validator.isValid({ mimetype: 'image/jpeg', buffer: Buffer.alloc(0) }), false);
});
