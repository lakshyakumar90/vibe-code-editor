"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ChevronDown,
  Clock3,
  FolderKanban,
  LayoutTemplate,
  Star,
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@repo/ui";

import { useProjects } from "@/hooks/use-projects";
import type { Project } from "@/lib/services/projects";
import { cn } from "@/lib/utils";

const items = [
  {
    title: "Home",
    url: "/dashboard",
    icon: FolderKanban,
  },
  {
    title: "Starred",
    url: "/dashboard/projects?filter=starred",
    icon: Star,
  },
  {
    title: "Recent",
    url: "/dashboard/projects?filter=recent",
    icon: Clock3,
  },
  {
    title: "Templates",
    url: "/dashboard/templates",
    icon: LayoutTemplate,
  },
];

interface ProjectDropdownProps {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  viewAllUrl: string;
  projects: Project[];
  defaultOpen?: boolean;
}

/** Collapsible project list (max 5) with a count badge + view-all link. */
function ProjectDropdown({
  title,
  icon: Icon,
  viewAllUrl,
  projects,
  defaultOpen = true,
}: ProjectDropdownProps) {
  const pathname = usePathname();
  const [open, setOpen] = useState(defaultOpen);
  const visible = projects.slice(0, 5);

  if (visible.length === 0) return null;

  return (
    <>
      <SidebarMenuItem className="flex items-center">
        <SidebarMenuButton>
          <Link href={viewAllUrl} className="w-full flex items-center gap-2">
            <Icon />
            <span>{title}</span>
            <span className="ml-auto rounded-md px-1.5 text-xs tabular-nums text-muted-foreground">
              {visible.length}
            </span>
          </Link>
        </SidebarMenuButton>
        <SidebarMenuAction
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${title}`}
          showOnHover
        >
          <ChevronDown
            className={cn("transition-transform", open && "rotate-180")}
          />
        </SidebarMenuAction>
      </SidebarMenuItem>
      {open && (
        <SidebarMenuSub>
          {visible.map((project) => {
            const url = `/dashboard/projects/${project.id}`;
            const active = pathname === url;
            return (
              <SidebarMenuSubItem key={project.id}>
                <SidebarMenuSubButton
                  className={cn(active && "bg-accent font-medium")}
                >
                  <Link
                    href={url}
                    className="w-full flex items-center gap-2"
                    title={project.name}
                  >
                    <FolderKanban className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{project.name}</span>
                  </Link>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            );
          })}
        </SidebarMenuSub>
      )}
    </>
  );
}

export function DashboardSidebar() {
  const pathname = usePathname();
  const { projects } = useProjects();
  const starred = projects.filter((p) => p.isFavorite);
  const recent = [...projects]
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    )
    .slice(0, 5);

  return (
    <Sidebar>
      <SidebarContent className="pt-20">
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>

          <SidebarGroupContent>
            <SidebarMenu className="flex flex-col gap-1">
              {items.map((item) => {
                const Icon = item.icon;
                const active =
                  pathname === item.url ||
                  (item.url !== "/dashboard" && pathname.startsWith(item.url.split("?")[0]!));

                return (
                  <SidebarMenuItem key={item.title} className="flex items-center">
                    <SidebarMenuButton
                      className={cn(active && "bg-accent font-medium")}
                    >
                      <Link href={item.url} className="w-full flex items-center gap-2">
                        <Icon />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Projects</SidebarGroupLabel>

          <SidebarGroupContent>
            <SidebarMenu className="flex flex-col gap-1">
              <ProjectDropdown
                title="Starred"
                icon={Star}
                viewAllUrl="/dashboard/projects?filter=starred"
                projects={starred}
              />
              <ProjectDropdown
                title="Recent"
                icon={Clock3}
                viewAllUrl="/dashboard/projects?filter=recent"
                projects={recent}
                defaultOpen={false}
              />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
