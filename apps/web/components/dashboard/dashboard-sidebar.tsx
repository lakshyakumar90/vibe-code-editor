"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
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
  SidebarMenuButton,
  SidebarMenuItem,
} from "@repo/ui";

import { useProjects } from "@/hooks/use-projects";
import { cn } from "@/lib/utils";

const items = [
  {
    title: "Home",
    url: "/dashboard",
    icon: FolderKanban,
  },
  {
    title: "Starred",
    url: "/dashboard/starred",
    icon: Star,
  },
  {
    title: "Recent",
    url: "/dashboard/recent",
    icon: Clock3,
  },
  {
    title: "Templates",
    url: "/dashboard/templates",
    icon: LayoutTemplate,
  },
];

export function DashboardSidebar() {
  const pathname = usePathname();
  const { projects } = useProjects();
  const starred = projects.filter((p) => p.isFavorite).slice(0, 7);

  return (
    <Sidebar>
      <SidebarContent className="pt-20">
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>

          <SidebarGroupContent>
            <SidebarMenu className="flex flex-col gap-1">
              {items.map((item) => {
                const Icon = item.icon;
                const active = pathname === item.url;

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

        {starred.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel className="flex items-center gap-1.5">
              <Star className="size-3.5 fill-yellow-500 text-yellow-500" />
              Favorites
            </SidebarGroupLabel>

            <SidebarGroupContent>
              <SidebarMenu className="flex flex-col gap-1">
                {starred.map((project) => {
                  const url = `/dashboard/projects/${project.id}`;
                  const active = pathname === url;
                  return (
                    <SidebarMenuItem key={project.id} className="flex items-center">
                      <SidebarMenuButton
                        className={cn(active && "bg-accent font-medium")}
                      >
                        <Link href={url} className="w-full flex items-center gap-2" title={project.name}>
                          <FolderKanban className="size-4 shrink-0 text-muted-foreground" />
                          <span className="truncate">{project.name}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>
    </Sidebar>
  );
}