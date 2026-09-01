"use client";

import Link from "next/link";
import { User, LogOut, Settings } from "lucide-react";

import { AuthClient } from "@/lib/auth-client";
import { ModeToggle } from "./theme-mode-toggle";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/ui";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/ui";

import { Button } from "@repo/ui";

export function Navbar() {
  const { data: session } = AuthClient.useSession();

  return (
    <header className="fixed top-4 left-0 z-50 w-full px-4">
      <nav className="mx-auto flex h-14 max-w-5xl items-center justify-between rounded-2xl border bg-background/80 px-4 shadow-sm backdrop-blur-xl">
        {/* Left */}
        <Link
          href="/"
          className="text-lg font-bold tracking-tight"
        >
          Vibe
        </Link>

        {/* Right */}
        <div className="flex items-center gap-2">
          <ModeToggle />

          {!session ? (
            <Button>
              <Link href="/login">
                Get Started
              </Link>
            </Button>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger>
                <Button
                  variant="ghost"
                  size="icon"
                  className="rounded-full"
                >
                  <Avatar className="h-8 w-8">
                    <AvatarImage
                      src={session.user?.image || ""}
                      alt={session.user?.name || "Profile"}
                    />

                    <AvatarFallback>
                      {session.user?.name?.charAt(0).toUpperCase() || (
                        <User className="h-4 w-4" />
                      )}
                    </AvatarFallback>
                  </Avatar>

                  <span className="sr-only">
                    Open profile menu
                  </span>
                </Button>
              </DropdownMenuTrigger>

              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem>
                  <Link href="/dashboard/projects">
                    Projects
                  </Link>
                </DropdownMenuItem>

                <DropdownMenuItem>
                  <Link href="/profile">
                    <Settings className="mr-2 h-4 w-4" />
                    Profile
                  </Link>
                </DropdownMenuItem>

                <DropdownMenuSeparator />

                <DropdownMenuItem
                  onClick={() => AuthClient.signOut()}
                  className="text-destructive focus:text-destructive"
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  Logout
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </nav>
    </header>
  );
}

