import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {decodeJpeg} from '../dist/paper-visual-codec.mjs';
function image(mode, progressive = false) {
  const script = `from PIL import Image\nimport io,base64\nim=Image.new('${mode}',(8,8),${mode === 'L' ? '80' : '(12,80,200)'})\nb=io.BytesIO();im.save(b,'JPEG',quality=100,subsampling=0,progressive=${progressive ? 'True' : 'False'});print(base64.b64encode(b.getvalue()).decode())`;
  return Buffer.from(execFileSync('python', ['-c', script], {encoding:'utf8'}).trim(), 'base64');
}
test('pure baseline JPEG decodes color and grayscale pixels', async () => {
  for (const [mode, expected] of [['RGB',[11,80,199,255]], ['L',[80,80,80,255]]]) {
    const result = await decodeJpeg(image(mode));
    assert.deepEqual([result.width,result.height,result.rgba.length], [8,8,256]);
    for (let i=0;i<result.rgba.length;i+=4) assert.deepEqual([...result.rgba.slice(i,i+4)], expected);
  }
});
test('pure JPEG rejects progressive, invalid and excessive dimensions', async () => {
  await assert.rejects(decodeJpeg(image('RGB',true)), {code:'jpeg'});
  await assert.rejects(decodeJpeg(Uint8Array.of(0,1,2)), {code:'jpeg'});
  const oversized=image('RGB');
  const sof=oversized.indexOf(Buffer.from([0xff,0xc0]));
  assert.ok(sof>=0); oversized.writeUInt16BE(4000,sof+5); oversized.writeUInt16BE(4000,sof+7);
  await assert.rejects(decodeJpeg(oversized), {code:'jpeg'});
});
