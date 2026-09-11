"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  RadioGroup,
  RadioGroupItem,
} from "@repo/ui";
import {
  accessLabel,
  canContinue,
  detectionExplainer,
  detectionLabel,
  resolveImportRoot,
  templateDisplayName,
  type InspectionState,
} from "@/lib/github/discovery";
import { githubService, type GitHubRepo } from "@/lib/services/github";
import { cn } from "@/lib/utils";

interface RepoCardProps {
  repo: GitHubRepo;
  inspection: InspectionState;
}

function DetectionBadge({ inspection }: { inspection: InspectionState }) {
  if (inspection.state === "pending" || inspection.state === "checking") {
    return <Badge variant="secondary">{detectionLabel(inspection)}</Badge>;
  }
  if (inspection.state === "error") {
    return <Badge variant="destructive">{detectionLabel(inspection)}</Badge>;
  }
  const detection = inspection.inspection.detection;
  if (detection.kind === "supported") {
    return <Badge>{detectionLabel(inspection)}</Badge>;
  }
  if (detection.kind === "ambiguous") {
    return <Badge variant="secondary">{detectionLabel(inspection)}</Badge>;
  }
  return <Badge variant="outline">{detectionLabel(inspection)}</Badge>;
}

export function RepoCard({ repo, inspection }: RepoCardProps) {
  const router = useRouter();
  const [chosenRoot, setChosenRoot] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const detection = inspection.state === "ready" ? inspection.inspection.detection : null;
  const explainer = detectionExplainer(inspection);

  const handleImport = async () => {
    const root = resolveImportRoot(inspection, chosenRoot);
    // resolveImportRoot mirrors the button enablement below; this guard
    // closes the gap between render and click.
    if (root === null || importing) return;
    setImporting(true);
    setImportError(null);
    try {
      const result = await githubService.importRepo({
        owner: repo.owner.login,
        repo: repo.name,
        ...(root === "" ? {} : { root }),
      });
      const skipped =
        result.stats.skippedBinaries +
        result.stats.skippedExcluded +
        result.stats.skippedSymlinks +
        result.stats.skippedSubmodules;
      toast.success(
        skipped > 0
          ? `Imported ${result.stats.files} files (${skipped} binaries/generated files skipped).`
          : `Imported ${result.stats.files} files successfully.`,
      );
      router.push(`/dashboard/projects/${result.project.id}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Repository import failed";
      setImportError(message);
      toast.error(message);
      setImporting(false);
    }
  };

  const importDisabled =
    importing || resolveImportRoot(inspection, chosenRoot) === null;
  const actionLabel = importing ? "Importing repository…" : "Import repository";

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start gap-2">
          <div className="min-w-0">
            <CardTitle className="truncate">{repo.name}</CardTitle>
            <CardDescription className="truncate">
              {repo.fullName} · {accessLabel(repo)}
            </CardDescription>
          </div>
          <div className="ml-auto">
            <DetectionBadge inspection={inspection} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {repo.description ? (
          <p className="line-clamp-2 text-sm text-muted-foreground">{repo.description}</p>
        ) : null}

        {detection?.kind === "ambiguous" ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">Choose which application to import:</p>
            <RadioGroup
              value={chosenRoot ?? ""}
              onValueChange={setChosenRoot}
              className="flex flex-col gap-2"
            >
              {detection.candidates.map((c) => {
                const value = c.root || "/";
                return (
                  <label
                    key={value}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm",
                      chosenRoot === value && "border-primary",
                    )}
                  >
                    <RadioGroupItem value={value} />
                    <span className="font-mono">{value}</span>
                    <span className="text-muted-foreground">
                      {templateDisplayName(c.template)}
                    </span>
                  </label>
                );
              })}
            </RadioGroup>
          </div>
        ) : null}

        {explainer ? (
          <p className="text-sm text-muted-foreground">{explainer}</p>
        ) : null}

        {inspection.state === "error" ? (
          <p className="text-sm text-muted-foreground">{inspection.message}</p>
        ) : null}

        {importing ? (
          <p className="text-sm text-muted-foreground" role="status">
            Importing repository… Fetching files, creating project, finalizing.
          </p>
        ) : null}

        {importError && !importing ? (
          <p className="text-sm text-destructive">{importError}</p>
        ) : null}

        <div className="flex justify-end">
          {detection?.kind === "ambiguous" || canContinue(inspection) ? (
            <Button disabled={importDisabled} onClick={handleImport}>
              {actionLabel}
            </Button>
          ) : (
            <Button variant="outline" disabled title="Only supported repositories can be imported">
              {inspection.state === "ready" ? "Not supported" : "Checking…"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
