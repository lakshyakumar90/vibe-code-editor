"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { GitBranch, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@repo/ui";
import { Button } from "@repo/ui/components/ui/button";
import { AuthClient } from "@/lib/auth-client";
import { githubService, type GitHubStatus } from "@/lib/services/github";

/** Minimal scope elevation for the roadmap (discovery, private read, push, PRs). */
const GITHUB_CONNECT_SCOPES = ["repo"];

function settingsCallbackURL(): string {
  const base = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  return `${base}/dashboard/settings?github=connected`;
}

type LinkSocialResult = {
  data?: { url?: string; redirect?: boolean } | null;
  error?: { message?: string } | null;
};

export function GitHubConnectionCard() {
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"connect" | "disconnect" | "finalize" | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await githubService.getStatus());
    } catch {
      toast.error("Could not load GitHub connection status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Returning from the GitHub authorization flow: finalize server-side.
  useEffect(() => {
    if (searchParams.get("github") !== "connected" || busy !== null) return;
    setBusy("finalize");
    githubService
      .finalizeConnect()
      .then((next) => {
        setStatus(next);
        if (next.authorization.usable) {
          toast.success(
            next.githubUser ? `Connected as @${next.githubUser.login}` : "GitHub connected",
          );
        } else if (next.authorization.reason === "insufficient_scope") {
          toast.error("GitHub authorization lacks repository access");
        } else {
          toast.error("GitHub connection needs attention");
        }
      })
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : "Could not complete GitHub connection");
      })
      .finally(() => {
        setBusy(null);
        window.history.replaceState(null, "", "/dashboard/settings");
        void refresh();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConnect = useCallback(async () => {
    setBusy("connect");
    try {
      const client = AuthClient as unknown as {
        linkSocial: (args: {
          provider: string;
          callbackURL: string;
          scopes: string[];
        }) => Promise<LinkSocialResult>;
      };
      const res = await client.linkSocial({
        provider: "github",
        callbackURL: settingsCallbackURL(),
        scopes: GITHUB_CONNECT_SCOPES,
      });
      if (res.error) throw new Error(res.error.message || "GitHub authorization failed");
      if (res.data?.url) {
        window.location.href = res.data.url;
        return;
      }
      throw new Error("GitHub did not return an authorization URL");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Could not start GitHub connection");
      setBusy(null);
    }
  }, []);

  const handleDisconnect = useCallback(async () => {
    setBusy("disconnect");
    try {
      await githubService.disconnect();
      toast.success("GitHub disconnected");
      await refresh();
    } catch {
      toast.error("Could not disconnect GitHub");
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const usable = status?.authorization.usable ?? false;
  const needsAttention = (status?.connected ?? false) && !usable;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border">
            <GitBranch className="h-5 w-5" />
          </div>
          <div>
            <CardTitle>GitHub</CardTitle>
            <CardDescription>
              Connect GitHub to use Git and GitHub features such as repository import,
              push/pull, branches and pull requests.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking GitHub connection…
          </div>
        ) : usable && status?.githubUser ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm">
              Connected as{" "}
              <span className="font-medium">@{status.githubUser.login}</span>
            </p>
            <div className="ml-auto flex gap-2">
              <Button variant="outline" disabled={busy !== null} onClick={handleConnect}>
                {busy === "connect" ? "Working…" : "Reconnect"}
              </Button>
              <Button variant="outline" disabled={busy !== null} onClick={handleDisconnect}>
                {busy === "disconnect" ? "Working…" : "Disconnect"}
              </Button>
            </div>
          </div>
        ) : needsAttention ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm">
              GitHub connection needs attention
              {status?.authorization.reason === "insufficient_scope"
                ? " — repository access was not approved."
                : " — authorization is no longer valid."}{" "}
              Reconnect to restore Git and GitHub features.
            </p>
            <div className="ml-auto flex gap-2">
              <Button disabled={busy !== null} onClick={handleConnect}>
                {busy === "connect" ? "Working…" : "Reconnect GitHub"}
              </Button>
              <Button variant="outline" disabled={busy !== null} onClick={handleDisconnect}>
                Disconnect
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-muted-foreground">
              Not connected. The IDE works normally without this.
            </p>
            <div className="ml-auto">
              <Button disabled={busy !== null} onClick={handleConnect}>
                {busy === "connect" ? "Working…" : "Connect GitHub"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
