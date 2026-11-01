import { test } from "node:test";
import assert from "node:assert/strict";
import { platformOf } from "./platform.mjs";

test("Ren'Py 8 market build layout", () => {
  assert.equal(platformOf("MidnightManor.exe"), "windows");
  assert.equal(platformOf("MidnightManor.sh"), "linux");
  assert.equal(platformOf("MidnightManor.app/Contents/MacOS/MidnightManor"), "mac");
  assert.equal(platformOf("lib/py3-windows-x86_64/python.dll"), "windows");
  assert.equal(platformOf("lib/py3-windows-i686/python.dll"), "windows");
  assert.equal(platformOf("lib/py3-linux-x86_64/librenpython.so"), "linux");
  assert.equal(platformOf("lib/py3-mac-universal/librenpython.dylib"), "mac");
  assert.equal(platformOf("lib/python3.9/encodings/utf_8.py"), "all");
  assert.equal(platformOf("game/script.rpyc"), "all");
  assert.equal(platformOf("renpy/common/00start.rpy"), "all");
  assert.equal(platformOf("game/images/some.exe.png"), "all");
});

test("Ren'Py 7 layout", () => {
  assert.equal(platformOf("lib/windows-i686/python27.dll"), "windows");
  assert.equal(platformOf("lib/linux-x86_64/libpython2.7.so"), "linux");
  assert.equal(platformOf("lib/darwin-x86_64/librenpython.dylib"), "mac");
});
