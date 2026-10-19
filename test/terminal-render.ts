import { stripVTControlCharacters } from "node:util";

/** Remove only Pi-owned cursor annotations; retain other controls for security assertions. */
export function stripPiCursorMarkers(text: string): string {
  return text
    .replaceAll("\u001b_pi:c\u0007", "")
    .replaceAll("\u001b_pi:fc\u0007", "")
    .replaceAll("\u001b_pi:/fc\u0007", "");
}

export function stripPiTerminalControls(text: string): string {
  return stripVTControlCharacters(stripPiCursorMarkers(text));
}
