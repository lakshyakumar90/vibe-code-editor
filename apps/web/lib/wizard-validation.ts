import type { TemplateId } from "./templates-catalog";

export function wizardValidation(step: number, v: { name: string; template: TemplateId | null }) {
  if (step === 0) {
    if (!v.name.trim()) return "Project name is required";
    if (v.name.trim().length > 60) return "Name must be under 60 characters";
  }
  if (step === 1 && !v.template) return "Select a template";
  return null;
}
