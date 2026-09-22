import { describe, it, expect } from "vitest";
import { detectTemplate, sanitizeImportPath } from "./github.service.js";

describe("detectTemplate", () => {
  it("detects all six templates", () => {
    expect(detectTemplate({ dependencies: { next: "1" } }, [])).toBe("NEXTJS");
    expect(detectTemplate({ dependencies: { express: "1" } }, [])).toBe("EXPRESS");
    expect(detectTemplate({ dependencies: { hono: "1" } }, [])).toBe("HONO");
    expect(detectTemplate({ dependencies: { react: "1" } }, [])).toBe("REACT");
    expect(detectTemplate({ dependencies: { vue: "1" } }, [])).toBe("VUE");
    expect(detectTemplate({ dependencies: { "@angular/core": "1" } }, [])).toBe("ANGULAR");
    expect(detectTemplate({ dependencies: {} }, [])).toBeNull();
  });
});

describe("sanitizeImportPath", () => {
  it("blocks traversal, .env, .git, node_modules", () => {
    expect(sanitizeImportPath("../x")).toBeNull();
    expect(sanitizeImportPath(".env")).toBeNull();
    expect(sanitizeImportPath(".env.local")).toBeNull();
    expect(sanitizeImportPath(".git/config")).toBeNull();
    expect(sanitizeImportPath("node_modules/a")).toBeNull();
    expect(sanitizeImportPath("src/App.tsx")).toBe("src/App.tsx");
  });
});
