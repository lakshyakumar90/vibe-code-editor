"use client"

import { useRouter } from "next/navigation"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import Link from "next/link"
import * as z from "zod"

import { signUpSchema } from "@repo/validation/src/auth"
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

export function SignupForm() {
  const router = useRouter()

  const form = useForm<z.infer<typeof signUpSchema>>({
    resolver: zodResolver(signUpSchema),
    defaultValues: {
      name: "",
      email: "",
      password: "",
      confirmPassword: "",
    },
  })

  async function onSubmit(data: z.infer<typeof signUpSchema>) {
    const { error } = await AuthClient.signUp.email({
      name: data.name,
      email: data.email,
      password: data.password,
      callbackURL: `${window.location.origin}/verify-email?verified=true`,
    })

    if (error) {
      toast.error(error.message || "An error occurred during signup")
      return
    }

    if (!error) {
      router.push(`/verify-email?email=${encodeURIComponent(data.email)}`);
    }
  }

  return (
    <Card className="w-full sm:max-w-md">
      <CardHeader>
        <CardTitle>Create an account</CardTitle>
        <CardDescription>Enter your details to get started.</CardDescription>
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
        <form id="signup-form" onSubmit={form.handleSubmit(onSubmit)}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="signup-name">Name</FieldLabel>
              <Input
                {...form.register("name")}
                id="signup-name"
                placeholder="John Doe"
                autoComplete="name"
              />
              {form.formState.errors.name && (
                <FieldError errors={[form.formState.errors.name]} />
              )}
            </Field>
            <Field>
              <FieldLabel htmlFor="signup-email">Email</FieldLabel>
              <Input
                {...form.register("email")}
                id="signup-email"
                type="email"
                placeholder="you@example.com"
                autoComplete="email"
              />
              {form.formState.errors.email && (
                <FieldError errors={[form.formState.errors.email]} />
              )}
            </Field>
            <Field>
              <FieldLabel htmlFor="signup-password">Password</FieldLabel>
              <Input
                {...form.register("password")}
                id="signup-password"
                type="password"
                placeholder="Create a password"
                autoComplete="new-password"
              />
              {form.formState.errors.password && (
                <FieldError errors={[form.formState.errors.password]} />
              )}
            </Field>
            <Field>
              <FieldLabel htmlFor="signup-confirm-password">Confirm Password</FieldLabel>
              <Input
                {...form.register("confirmPassword")}
                id="signup-confirm-password"
                type="password"
                placeholder="Confirm your password"
                autoComplete="new-password"
              />
              {form.formState.errors.confirmPassword && (
                <FieldError errors={[form.formState.errors.confirmPassword]} />
              )}
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
      <CardFooter className="flex-col gap-4">
        <Button type="submit" form="signup-form" className="w-full">
          Create Account
        </Button>
        <p className="text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link href="/login" className="text-primary underline-offset-4 hover:underline">
            Sign in
          </Link>
        </p>
      </CardFooter>
    </Card>
  )
}
