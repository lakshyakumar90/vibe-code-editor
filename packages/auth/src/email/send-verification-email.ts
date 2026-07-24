import { transporter } from "./transporter";

export async function sendVerificationEmail({
  email,
  name,
  verificationUrl,
}: {
    email: string,
    name: string,
    verificationUrl: string,
  }) {
   transporter.sendMail({
    from: process.env.SMTP_FROM,
    to: email,
    subject: "Verify your email address",
    html: `
      <p>Hi ${name},</p>
      <p>Thank you for signing up! Please verify your email address by clicking the link below:</p>
      <a href="${verificationUrl}">Verify Email</a>
      <p>If you did not sign up for this account, please ignore this email.</p>
    `,
  })
}