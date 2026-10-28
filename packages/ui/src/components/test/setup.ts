import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom has no canvas; axe probes it for icon-ligature checks. Report "unsupported" quietly
// instead of printing jsdom's not-implemented error for every run.
if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
}

afterEach(() => {
  cleanup();
});
