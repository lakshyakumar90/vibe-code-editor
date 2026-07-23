import Link from "next/link";
import { Button } from "@repo/ui/components/ui/button";

export default function Page() {
  return (
    <div className="h-screen w-full flex flex-col gap-4 items-center justify-center">
      <h1 className="text-3xl font-bold">Hello, Welcome to Vibe Code Editor!</h1>
      <div className="">
        <Link href="/login">
          <Button size="lg" variant="outline">Login</Button>
        </Link>
        <Link href="/signup">
          <Button>Signup</Button>
        </Link>
      </div>
    </div>
  );
}
