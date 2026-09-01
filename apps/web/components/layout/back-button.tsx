import { ArrowLeft } from "lucide-react"

export function BackButton() {
  return (
    <button
      type="button"
      onClick={() => window.history.back()}
      className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
    >
      <ArrowLeft className="h-4 w-4" />
      Go back
    </button>
  )
}