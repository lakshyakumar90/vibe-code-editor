/**
 * Phase 2 — pure import-page helpers (unit-tested; components stay thin).
 * Display names come from the canonical TEMPLATE_META map — never
 * hardcoded framework strings in components.
 */
import { TEMPLATE_META, type TemplateDetection, type TemplateId } from "@repo/templates/detect";
import type { GitHubRepo, RepoInspection } from "@/lib/services/github";

export type DiscoveryTab = "all" | "supported" | "ambiguous" | "unsupported";

export type InspectionState =
  | { state: "pending" }
  | { state: "checking" }
  | { state: "ready"; inspection: RepoInspection }
  | { state: "error"; message: string };

export function templateDisplayName(template: TemplateId): string {
  return TEMPLATE_META[template].name;
}

export function detectionKind(
  inspection: InspectionState,
): TemplateDetection["kind"] | "unknown" {
  if (inspection.state !== "ready") return "unknown";
  return inspection.inspection.detection.kind;
}

/** Tab filtering over repos + their inspection states. Pure. */
export function filterByTab(
  repos: GitHubRepo[],
  inspections: Record<string, InspectionState | undefined>,
  tab: DiscoveryTab,
): GitHubRepo[] {
  if (tab === "all") return repos;
  return repos.filter((r) => {
    const kind = detectionKind(inspections[r.fullName] ?? { state: "pending" });
    return kind === tab;
  });
}

/** Counts per tab for the filter UI. Pure. */
export function tabCounts(
  repos: GitHubRepo[],
  inspections: Record<string, InspectionState | undefined>,
): Record<DiscoveryTab, number> {
  const counts: Record<DiscoveryTab, number> = {
    all: repos.length,
    supported: 0,
    ambiguous: 0,
    unsupported: 0,
  };
  for (const r of repos) {
    const kind = detectionKind(inspections[r.fullName] ?? { state: "pending" });
    if (kind === "supported" || kind === "ambiguous" || kind === "unsupported") {
      counts[kind] += 1;
    }
  }
  return counts;
}

/** Human badge label for a detection. Pure. */
export function detectionLabel(inspection: InspectionState): string {
  if (inspection.state === "pending" || inspection.state === "checking") {
    return "Checking compatibility…";
  }
  if (inspection.state === "error") return "Check failed";
  const detection = inspection.inspection.detection;
  if (detection.kind === "supported") {
    return templateDisplayName(detection.template);
  }
  if (detection.kind === "ambiguous") return "Multiple apps detected";
  if (detection.truncated) return "Too large to inspect";
  return "Unsupported project type";
}

/** Whether the repo may proceed toward the future import flow. Pure. */
export function canContinue(inspection: InspectionState): boolean {
  return inspection.state === "ready" && inspection.inspection.detection.kind === "supported";
}

/**
 * Resolve the import root for a detection + optional user choice.
 * Returns the repo-relative root ("" = repo root), or null when import
 * must stay disabled (unsupported, uninspected, or ambiguous without
 * a valid chosen candidate). Pure.
 */
export function resolveImportRoot(
  inspection: InspectionState,
  chosenRoot: string | null,
): string | null {
  if (inspection.state !== "ready") return null;
  const detection = inspection.inspection.detection;
  if (detection.kind === "supported") return detection.root;
  if (detection.kind !== "ambiguous") return null;
  if (!chosenRoot) return null;
  const match = detection.candidates.find((c) => (c.root || "/") === chosenRoot);
  return match ? match.root : null;
}

/**
 * Long explainer distinguishing genuine-unsupported from
 * inspection-incomplete (too large) states. Pure.
 */
export function detectionExplainer(inspection: InspectionState): string | null {
  if (inspection.state !== "ready") return null;
  const detection = inspection.inspection.detection;
  if (detection.kind !== "unsupported") return null;
  if (detection.truncated || inspection.inspection.truncated) {
    return (
      "Unable to safely inspect this repository. " +
      "The repository is too large or inspection data is incomplete. " +
      "This does not necessarily mean the repository is unsupported."
    );
  }
  return "Unsupported repository. No supported project template was detected.";
}

/** Access summary line ("private · Write access"). Pure. */
export function accessLabel(repo: GitHubRepo): string {
  const visibility = repo.private ? "private" : "public";
  const access = repo.access.canWrite ? "Write access" : "Read access";
  return `${visibility} · ${access}`;
}
