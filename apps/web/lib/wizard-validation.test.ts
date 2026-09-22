import { describe, it, expect } from "vitest";
import { wizardValidation } from "./wizard-validation";
import { TEMPLATE_CATALOG } from "./templates-catalog";

describe("wizardValidation", () => {
  it("requires a trimmed name on step 0", () => {
    expect(wizardValidation(0, { name: "  ", template: null })).toBeTruthy();
    expect(wizardValidation(0, { name: "my-app", template: null })).toBeNull();
  });
  it("requires a template on step 1", () => {
    expect(wizardValidation(1, { name: "x", template: null })).toBeTruthy();
    expect(wizardValidation(1, { name: "x", template: "REACT" })).toBeNull();
  });
});

describe("template catalog", () => {
  it("has exactly the six supported templates", () => {
    expect(TEMPLATE_CATALOG.map((t) => t.id).sort()).toEqual(
      ["ANGULAR", "EXPRESS", "HONO", "NEXTJS", "REACT", "VUE"].sort(),
    );
  });
});
