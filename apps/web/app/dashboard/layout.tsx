import { DashboardSidebar } from "@/components/dashboard/dashboard-sidebar";
import { SidebarProvider } from "@repo/ui";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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