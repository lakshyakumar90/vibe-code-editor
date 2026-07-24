import { z } from "zod";

export const signUpSchema = z
  .object({
    name: z
      .string()
      .min(2, "Name must be at least 2 characters long")
      .max(50, "Name must be at most 50 characters long"),
    email: z.email("Please Enter a valid email address"),
    password: z
      .string()
      .min(8, "Password must be at least 8 characters long")
      .max(100, "Password must be at most 100 characters long")
      .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
      .regex(/[a-z]/, "Password must contain at least one lowercase letter")
      .regex(/[0-9]/, "Password must contain at least one number")
      .regex(
        /[^A-Za-z0-9]/,
        "Password must contain at least one special character",
      ),
    confirmPassword: z.string(),
  })
  .refine((d) => d.password === d.confirmPassword,
      {
        path: ["confirmPassword"],
        error: "Passwords don't match",    
  });

export const loginSchema = z.object({
  email: z.email("Please Enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters long"),
});

export type SignUpSchema = z.infer<typeof signUpSchema>;
export type LoginSchema = z.infer<typeof loginSchema>;
