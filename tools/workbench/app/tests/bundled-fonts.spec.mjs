import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {webcrypto} from "node:crypto";
import {getBundledFonts} from "../src/bundled-fonts.mjs";
if (!globalThis.crypto) globalThis.crypto = webcrypto;
function fixture() {
  const calls = [];
  const fetch = async path => {
    calls.push(path);
    const data = await readFile(new URL(`../dist/${path.replace(/^\.\//, "")}`, import.meta.url));
    return {ok: true, arrayBuffer: async () => data};
  };
  return {fetch, calls};
}
test("Latin styles load only requested face and return independent bytes", async () => {
  const {fetch, calls} = fixture();
  const req = [{family: "Liberation Serif", bold: true, italic: true, text: "Hello"}];
  const a = await getBundledFonts(req, {fetch});
  assert.equal(a.length, 1); assert.equal(a[0].family, "Liberation Serif");
  assert.equal(a[0].weight, 700); assert.equal(a[0].italic, true);
  a[0].bytes[0] ^= 255;
  const b = await getBundledFonts(req, {fetch});
  assert.notEqual(a[0].bytes[0], b[0].bytes[0]); assert.equal(calls.length, 1);
  assert.ok(calls.every(x => !/CJK|Math/.test(x)));
});
test("math and Korean request the relevant static alternatives", async () => {
  const {fetch, calls} = fixture();
  const result = await getBundledFonts([{family: "serif", text: "수식 ∑"}], {fetch});
  assert.deepEqual(result.map(f => f.family), ["Liberation Serif", "STIX Two Math", "Noto Serif CJK KR"]);
  assert.ok(!calls.some(p => p.includes("NotoSans")));
  assert.equal(result[2].weight, 400); assert.equal(result[2].italic, false);
});
test("unrecognized family does not match by substring", async () => {
  const {fetch} = fixture();
  const result = await getBundledFonts([{family: "Not Liberation Serif", text: "x"}], {fetch});
  assert.deepEqual(result.map(f => f.family), ["Liberation Sans", "Liberation Serif"]);
});
test("hash mismatch rejects and failed cache entry is retried", async () => {
  let calls = 0;
  const fetch = async () => { calls++; return {ok: true, arrayBuffer: async () => new Uint8Array([1,2,3])}; };
  const req = [{family: "sans", text: "x"}];
  await assert.rejects(getBundledFonts(req, {fetch}), /hash mismatch/);
  await assert.rejects(getBundledFonts(req, {fetch}), /hash mismatch/);
  assert.equal(calls, 2);
});

test("all Latin faces have correct weight and italic metadata and validate their hashes", async () => {
  const {fetch, calls} = fixture();
  for (const family of ["Liberation Sans", "Liberation Serif"]) {
    for (const bold of [false, true]) for (const italic of [false, true]) {
      const [face] = await getBundledFonts([{family, bold, italic, text: "a"}], {fetch});
      assert.equal(face.weight, bold ? 700 : 400); assert.equal(face.italic, italic);
    }
  }
  assert.equal(calls.length, 8);
  const korean = await getBundledFonts([{family: "sans", text: "한"}], {fetch});
  assert.equal(korean[1].family, "Noto Sans CJK KR");
});
