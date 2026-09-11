import { Suspense } from "react";
import { ImportPage } from "@/components/import/import-page";

export default function ImportRoutePage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
      <ImportPage />
    </Suspense>
  );
}
