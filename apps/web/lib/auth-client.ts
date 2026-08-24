import { createAuthClient } from "better-auth/react";

export const AuthClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_AUTH_BASE_URL || "http://localhost:5000",
  fetchOptions: { credentials: "include" },
});

export const { useSession, signIn, signUp, signOut } = AuthClient;
export type Session = typeof AuthClient.$Infer.Session;