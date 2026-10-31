import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.mts", "create-nanodev/lib/**/*.test.mjs"],
    environment: "node",
    // The integration test drives real git clones; give slow Windows disks room.
    testTimeout: 60_000,
  },
});
