"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, Info } from "lucide-react";
import { getSharedMonaco } from "@/lib/language/model-manager";
import {
  collectProblems,
  onProblemsChange,
  type Problem,
} from "@/lib/language/diagnostics";

interface ProblemsPanelProps {
  onSelectProblem: (problem: Problem) => void;
  /** Increment to force a refresh (e.g. after tab switches). */
  refreshToken?: number;
  onCountChange?: (errors: number, warnings: number) => void;
}

function SeverityIcon({ severity }: { severity: Problem["severity"] }) {
  if (severity === "error")
    return <AlertCircle className="size-3.5 shrink-0 text-red-500" />;
  if (severity === "warning")
    return <AlertTriangle className="size-3.5 shrink-0 text-yellow-600" />;
  return <Info className="size-3.5 shrink-0 text-blue-500" />;
}

export function ProblemsPanel({ onSelectProblem, refreshToken, onCountChange }: ProblemsPanelProps) {
  const [problems, setProblems] = useState<Problem[]>([]);
  const onCountChangeRef = useRef(onCountChange);
  onCountChangeRef.current = onCountChange;

  useEffect(() => {
    // Monaco loads asynchronously — retry until the shared instance exists.
    let unsub: (() => void) | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    const trySubscribe = () => {
      const monaco = getSharedMonaco();
      if (!monaco) return false;
      const update = () => {
        const next = collectProblems(monaco);
        setProblems(next);
        onCountChangeRef.current?.(
          next.filter((p) => p.severity === "error").length,
          next.filter((p) => p.severity === "warning").length,
        );
      };
      update();
      unsub = onProblemsChange(monaco, update);
      return true;
    };

    if (!trySubscribe()) {
      timer = setInterval(() => {
        if (trySubscribe() && timer) {
          clearInterval(timer);
          timer = null;
        }
      }, 500);
    }

    return () => {
      unsub?.();
      if (timer) clearInterval(timer);
    };
  }, [refreshToken]);

  const errors = problems.filter((p) => p.severity === "error").length;
  const warnings = problems.filter((p) => p.severity === "warning").length;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex h-8 shrink-0 items-center gap-3 border-b px-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <span>Problems</span>
        <span className="font-normal normal-case tracking-normal">
          {problems.length === 0
            ? "No problems"
            : `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {problems.length === 0 ? (
          <div className="p-3 text-xs text-muted-foreground">
            No diagnostics. Errors and warnings from the TypeScript language
            service appear here.
          </div>
        ) : (
          problems.map((problem) => (
            <button
              key={problem.id}
              onClick={() => onSelectProblem(problem)}
              className="flex w-full items-start gap-2 border-b px-3 py-1.5 text-left text-xs hover:bg-accent/50"
            >
              <span className="mt-0.5">
                <SeverityIcon severity={problem.severity} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-foreground">
                  {problem.message}
                </span>
                <span className="block truncate text-muted-foreground">
                  {problem.dbPath}:{problem.line}:{problem.column}
                  {problem.code ? ` [${problem.code}]` : ""}
                </span>
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
