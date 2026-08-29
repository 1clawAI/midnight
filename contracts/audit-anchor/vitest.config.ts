import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // The compiled contract ships a sourcemap referencing compiler-internal
    // paths that are not distributed; silencing it keeps real failures visible.
    sourcemapInterceptor: false,
  },
});
