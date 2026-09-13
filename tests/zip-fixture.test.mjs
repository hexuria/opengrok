import assert from "node:assert/strict";
import test from "node:test";

import { buildZip } from "./zip-fixture.mjs";

test("a stored mimetype member starts at offset 38", () => {
  const bytes = buildZip([{ name: "mimetype", data: "application/vnd.oasis.opendocument.text", method: 0 }]);
  assert.equal(new TextDecoder().decode(bytes.subarray(38, 38 + 39)), "application/vnd.oasis.opendocument.text");
});
