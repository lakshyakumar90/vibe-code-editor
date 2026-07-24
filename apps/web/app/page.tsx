"use client";

import Link from "next/link";
import { Button } from "@repo/ui/components/ui/button";
import { AuthClient } from "@/lib/auth-client";
import { useRouter } from "next/navigation";

export default function Page() {
  const router = useRouter();
  const { data: session } = AuthClient.useSession();

  if (session?.user.emailVerified === false) {
    router.push(
      `/verify-email?email=${encodeURIComponent(session.user.email)}`,
    );
    return null; // Prevent rendering the login form while redirecting
  }

  return (
    <div className="h-screen w-full flex flex-col gap-4 items-center justify-center">
      <h1 className="text-3xl font-bold">
        Hello, Welcome to Vibe Code Editor!
      </h1>
      {!session && (
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
