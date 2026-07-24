"use client"

import { Suspense, useState, useCallback } from "react"
import { useSearchParams } from "next/navigation"
import { AuthClient } from "@/lib/auth-client"
import { toast } from "sonner"

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
  MailCheckIcon,
  MailWarningIcon,
  Loader2Icon,
} from "lucide-react"

function VerifyEmailContent() {
  const searchParams = useSearchParams()
  const email = searchParams.get("email") || ""
  const verified = searchParams.get("verified")
  const [sending, setSending] = useState(false)

  const resend = useCallback(async () => {
    if (!email) {
      toast.error("No email address provided")
      return
    }
    setSending(true)
    const { error } = await AuthClient.sendVerificationEmail({
      email,
      callbackURL: `${window.location.origin}/verify-email?verified=true`,
    })
    setSending(false)

    if (error) {
      toast.error(error.message || "Failed to send verification email")
      return
    }
    toast.success("Verification email sent! Check your inbox.")
  }, [email])

  if (verified === "true") {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full sm:max-w-md">
          <CardHeader className="text-center">
            <MailCheckIcon className="mx-auto mb-2 size-12 text-primary" />
            <CardTitle>Email Verified!</CardTitle>
            <CardDescription>
              Your email has been successfully verified. You can now sign in to your account.
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Button className="w-full">
              <a href="/login">Sign In</a>
            </Button>
          </CardFooter>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full sm:max-w-md">
        <CardHeader className="text-center">
          <MailWarningIcon className="mx-auto mb-2 size-12 text-primary" />
          <CardTitle>Verify Your Email</CardTitle>
          <CardDescription>
            {email ? (
              <>
                A verification email has been sent to{" "}
                <span className="font-medium text-foreground">{email}</span>.
                Please check your inbox and click the link to verify your account.
              </>
            ) : (
              "A verification email has been sent to your email address. Please check your inbox and click the link to verify your account."
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-center text-sm text-muted-foreground">
          <p>Didn&apos;t receive the email? Check your spam folder or resend.</p>
        </CardContent>
        <CardFooter className="flex-col gap-4">
          <Button
            className="w-full"
            variant="outline"
            onClick={resend}
            disabled={sending}
          >
            {sending && <Loader2Icon className="mr-2 size-4 animate-spin" />}
            Resend Verification Email
          </Button>
          <p className="text-sm text-muted-foreground">
            Already verified?{" "}
            <a href="/login" className="text-primary underline-offset-4 hover:underline">
              Sign in
            </a>
          </p>
        </CardFooter>
      </Card>
    </div>
  )
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center p-4">
        <Loader2Icon className="size-8 animate-spin text-muted-foreground" />
      </div>
    }>
      <VerifyEmailContent />
    </Suspense>
  )
}
