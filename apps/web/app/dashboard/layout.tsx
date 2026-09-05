"use client";

import { usePathname } from "next/navigation";
import { DashboardSidebar } from "@/components/dashboard/dashboard-sidebar";
import { isEditorPage } from "@/lib/is-editor-page";
import { SidebarProvider } from "@repo/ui";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  if (isEditorPage(pathname)) {
    return <>{children}</>;
  }

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full pt-20">
        <DashboardSidebar />
        <main className="flex-1 items-center justify-center w-full">
          {children}
        </main>
      </div>
    </SidebarProvider>
  );
}