"use client";

import { useState } from "react";
import { AuthClient } from "../../../lib/auth-client";

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    const { data, error } = await AuthClient.signIn.email({
      email,
      password,
    })

    if (error) {
      setError(error.message || "An error occurred during signup.");
    } else {
      // Handle successful signup (e.g., redirect to a welcome page)
      console.log("Signup successful:", data);
    }
  }

  return (
     <form onSubmit={handleSubmit}>
       <input
         placeholder="Email"
         value={email}
         onChange={(e) => setEmail(e.target.value)}
       />
 
       <input
         type="password"
         placeholder="Password"
         value={password}
         onChange={(e) => setPassword(e.target.value)}
       />
 
       <button type="submit">Sign Up</button>
     </form>
   );
 }
