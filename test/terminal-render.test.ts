import assert from "node:assert/strict";
import { CURSOR_MARKER, renderFakeCursor } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { stripPiCursorMarkers, stripPiTerminalControls } from "./terminal-render.js";

test("render normalization removes native cursor annotations without hiding injected controls", () => {
  const injected = "\u001b]52;c;payload\u0007\u0007\u001b_untrusted\u0007";
  assert.equal(stripPiCursorMarkers(`${CURSOR_MARKER}${renderFakeCursor("界")}${injected}`), `界${injected}`);
  assert.equal(stripPiTerminalControls(`\u001b[31m${renderFakeCursor("a")}b\u001b[0m`), "ab");
});
