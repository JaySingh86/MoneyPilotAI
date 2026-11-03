// Sandbox test entry: allocates until V8 hits the worker's heap limit. The parent must survive.
const hoard: object[][] = [];
for (;;) {
  hoard.push(Array.from({ length: 50_000 }, (_, i) => ({ i, s: "x".repeat(32) + i })));
}
