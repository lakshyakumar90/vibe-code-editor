"use client";

import { LoginForm } from "@/components/auth/login-form";
import { AuthClient } from "@/lib/auth-client";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const { data: session } = AuthClient.useSession();

  if (session?.user.emailVerified === false) {
    router.push(`/verify-email?email=${encodeURIComponent(session.user.email)}`);
    return null; // Prevent rendering the login form while redirecting
  }

  if (session) {
    router.push("/");
    return null; // Prevent rendering the signup form while redirecting
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <LoginForm />
    </div>
  );
}
