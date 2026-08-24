"use client";

import { LoginForm } from "@/components/auth/login-form";
import { AuthClient } from "@/lib/auth-client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function LoginPage() {
  const router = useRouter();
  const { data: session, isPending } = AuthClient.useSession();

  useEffect(() => {
    if (isPending) return;
    if (session?.user.emailVerified === false)
      router.replace(
        `/verify-email?email=${encodeURIComponent(session.user.email)}`,
      );
    else if (session) router.replace("/");
  }, [session, isPending, router]);

  if (isPending || session) {
    return <div>Loading...</div>;
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <LoginForm />
    </div>
  );
}
