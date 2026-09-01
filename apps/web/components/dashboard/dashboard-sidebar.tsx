"use client";

import Link from "next/link";
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
  return (
    <Sidebar>
      <SidebarContent className="pt-20">
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>

          <SidebarGroupContent>
            <SidebarMenu className="flex flex-col gap-1">
              {items.map((item) => {
                const Icon = item.icon;

                return (
                  <SidebarMenuItem key={item.title} className="flex items-center">
                    <SidebarMenuButton >
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
      </SidebarContent>
    </Sidebar>
  );
}