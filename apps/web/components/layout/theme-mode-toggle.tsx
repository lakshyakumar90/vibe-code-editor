"use client"

import { useTheme } from "next-themes"
import { AnimatedThemeToggler } from "@repo/ui"

export function ModeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme()

  const currentTheme =
    theme === "system"
      ? resolvedTheme
      : theme

  return (
    <AnimatedThemeToggler
      theme={currentTheme === "dark" ? "dark" : "light"}
      onThemeChange={(newTheme) => {
        setTheme(newTheme)
      }}
      variant="circle"
      duration={400}
      aria-label="Toggle theme"
    />
  )
}