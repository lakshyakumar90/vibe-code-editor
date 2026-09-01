"use client";

import Link from "next/link";
import { Button } from "@repo/ui";
import { AuthClient } from "@/lib/auth-client";

export default function Page() {
  const { data: session } = AuthClient.useSession();

  return (
    <div className="h-screen w-full flex flex-col gap-4 items-center justify-center">
      <h1 className="text-3xl font-bold">
        Hello, Welcome to Vibe Code Editor!
      </h1>
      {session ? (
        <div className="">
          <Link href="/dashboard">
            <Button size="lg" variant="outline">
              Dashboard
            </Button>
          </Link>
        </div>
      ) : (
        <div className="">
          <Link href="/login">
            <Button size="lg" variant="outline">
              Login
            </Button>
          </Link>
          <Link href="/signup">
            <Button>Signup</Button>
          </Link>
        </div>
      )}
      {
        session && (
          <h1>Hello {session?.user.name}</h1>
        )
      }
    </div>
  );
}
