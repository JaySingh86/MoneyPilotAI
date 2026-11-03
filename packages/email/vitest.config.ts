// PDF and HTML hostile-input tests are CPU heavy; give them room on slow CI runners.
export default {
  test: { testTimeout: 30_000, hookTimeout: 30_000 },
};
