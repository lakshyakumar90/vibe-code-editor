/** Minimal DB file shape the container layer needs (see ProjectFile in @/types/file). */
export interface ContainerDbFile {
  path: string;
  content: string | null;
}

export type RuntimeStatus =
  | "idle"
  | "booting"
  | "mounting"
  | "installing"
  | "starting"
  | "ready"
  | "error";
