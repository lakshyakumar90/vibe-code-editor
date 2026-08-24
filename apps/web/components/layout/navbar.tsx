"use client";

import Link from "next/link";
import { AuthClient } from "@/lib/auth-client";

export function Navbar() {
  const { data: session } = AuthClient.useSession();
  return (
    <nav className="flex h-14 items-center justify-between border-b px-4">
      <Link href="/" className="font-bold">
        Vibe
      </Link>
      <div className="flex gap-4">
        <Link href="/projects">Projects</Link>
        {session && (
          <button onClick={() => AuthClient.signOut()}>Logout</button>
        )}
      </div>
    </nav>
  );
}
