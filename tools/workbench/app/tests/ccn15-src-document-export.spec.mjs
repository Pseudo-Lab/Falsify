import {test} from 'node:test';
import assert from 'node:assert/strict';
import {textFile} from '../src/document-export.js';

test('patching preserves BOM, CRLF and untouched multibyte bytes', async()=>{
  const original=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from('앞말\r\nold phrase\r\n끝말','utf8')]);
  const result=await textFile(new File([original],'paper.txt'),[{before:'old phrase',after:'새 문구'}]);
  assert.deepEqual(Buffer.from(result.bytes),Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from('앞말\r\n새 문구\r\n끝말','utf8')]));
  await assert.rejects(()=>textFile(new File([original],'paper.txt'),[{before:'old phrase',after:'two\nlines'}]));
});
