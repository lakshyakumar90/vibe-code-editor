"use client"

import { useRouter } from "next/navigation"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import Link from "next/link"
import * as z from "zod"

import { loginSchema } from "@repo/validation/src/auth"
import { AuthClient } from "@/lib/auth-client"

import { Button } from "@repo/ui/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/ui/card"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@repo/ui/components/ui/field"
import { Input } from "@repo/ui/components/ui/input"
import { Separator } from "@repo/ui/components/ui/separator"
import { SocialLogin } from "@/components/auth/social-login"
import { EMAIL_NOT_VERIFIED_STATUS } from "@/lib/constants"

export function LoginForm() {
  const router = useRouter()

  const form = useForm<z.infer<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: "",
      password: "",
    },
  })

  async function onSubmit(data: z.infer<typeof loginSchema>) {
    const { error } = await AuthClient.signIn.email({
      email: data.email,
      password: data.password,
    })

    if (error) {
      if (error.status === EMAIL_NOT_VERIFIED_STATUS) {
        router.push(`/verify-email?email=${encodeURIComponent(data.email)}`)
        return
      }
      toast.error(error.message || "Invalid email or password")
      return
    }

    toast.success("Logged in successfully")
    router.push("/")
  }

  return (
    <Card className="w-full sm:max-w-md">
      <CardHeader>
        <CardTitle>Login</CardTitle>
        <CardDescription>Welcome back! Please sign in to continue.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <SocialLogin />
        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <Separator className="w-full" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-card px-2 text-muted-foreground">or continue with email</span>
          </div>
        </div>
        <form id="login-form" onSubmit={form.handleSubmit(onSubmit)}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="login-email">Email</FieldLabel>
              <Input
                {...form.register("email")}
                id="login-email"
                type="email"
                placeholder="you@example.com"
                autoComplete="email"
              />
              {form.formState.errors.email && (
                <FieldError errors={[form.formState.errors.email]} />
              )}
            </Field>
            <Field>
              <FieldLabel htmlFor="login-password">Password</FieldLabel>
              <Input
                {...form.register("password")}
                id="login-password"
                type="password"
                placeholder="Enter your password"
                autoComplete="current-password"
              />
              {form.formState.errors.password && (
                <FieldError errors={[form.formState.errors.password]} />
              )}
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
      <CardFooter className="flex-col gap-4">
        <Button type="submit" form="login-form" className="w-full">
          Sign In
        </Button>
        <p className="text-sm text-muted-foreground">
          Don&apos;t have an account?{" "}
          <Link href="/signup" className="text-primary underline-offset-4 hover:underline">
            Sign up
          </Link>
        </p>
      </CardFooter>
    </Card>
  )
}
