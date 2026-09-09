"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  CircleDashed,
  FileCode2,
  Loader2,
  Mic,
  Plus,
  Square,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react";
import type { AiProviderId, Attachment, PlanTask } from "@repo/ai";
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  PROVIDER_MODELS,
  SUPPORTED_PROVIDERS,
} from "@repo/ai";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { SseTransport } from "@/lib/ai/sse";
import type {
  AiPanelMode,
  AttachableFile,
  AttachmentChip,
  PanelMessage,
  ToolStep,
} from "@/lib/ai/types";

const MODE_META: Record<AiPanelMode, { label: string; hint: string }> = {
  ask: { label: "Ask", hint: "Read-only chat, no file access" },
  plan: { label: "Plan", hint: "Read-only plan as a checklist, no writes" },
  agent: { label: "Agent", hint: "Reads files, edits via reviewable changesets" },
};

let messageSeq = 0;
function nextId(prefix: string): string {
  messageSeq += 1;
  return `${prefix}-${Date.now()}-${messageSeq}`;
}

/**
 * Strip machine blocks (tool calls, raw changeset/plan JSON) from displayed
 * prose. Plans render as checklists and changesets via the review strip —
 * showing the raw fences would be noise (known v1 roughness, now filtered).
 */
function stripAgentBlocks(content: string): string {
  return content
    .replace(/```(?:tool|changeset|plan)\s*\n[\s\S]*?```/g, "")
    // Models sometimes use ```json for the changeset despite the contract —
    // strip those too when they carry a changes payload, else raw JSON leaks.
    .replace(/```json\s*\n[\s\S]*?"changes"\s*:[\s\S]*?```/g, "")
    .replace(/<think>[\s\S]*?(<\/think>|$)/gi, "")
    .replace(/<\/think>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function AssistantMarkdown({ content }: { content: string }) {
  return (
    <div className="break-words text-[13px] leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
          ul: ({ children }) => (
            <ul className="mb-2 list-disc space-y-0.5 pl-4 last:mb-0">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-2 list-decimal space-y-0.5 pl-4 last:mb-0">{children}</ol>
          ),
          li: ({ children }) => <li className="marker:text-muted-foreground">{children}</li>,
          code: ({ className, children }) => {
            const block = className?.includes("language-") ?? false;
            if (block) return <code className={className}>{children}</code>;
            return (
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="mb-2 overflow-x-auto rounded-md bg-muted/70 p-2 font-mono text-[11px] last:mb-0">
              {children}
            </pre>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline"
            >
              {children}
            </a>
          ),
          h1: ({ children }) => <div className="mb-1 font-semibold text-sm">{children}</div>,
          h2: ({ children }) => <div className="mb-1 font-semibold text-sm">{children}</div>,
          h3: ({ children }) => <div className="mb-1 font-semibold text-[13px]">{children}</div>,
          blockquote: ({ children }) => (
            <blockquote className="mb-2 border-l-2 border-border pl-2 text-muted-foreground last:mb-0">
              {children}
            </blockquote>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Extract <think> blocks (closed or trailing unclosed) for the Thinking
 * accordion. The prose renderer strips them — this surfaces them instead.
 */
function extractThinking(content: string): string[] {
  const out: string[] = [];
  const closed = content.match(/<think>([\s\S]*?)<\/think>/gi);
  if (closed) {
    for (const block of closed) {
      const inner = block.replace(/<\/?think>/gi, "").trim();
      if (inner) out.push(inner);
    }
  }
  // Trailing unclosed <think> (still streaming): show live.
  const tail = content.match(/<think>([\s\S]*)$/i);
  if (tail && !/<\/think>/i.test(tail[1] ?? "")) {
    const inner = (tail[1] ?? "").replace(/<\/?think>/gi, "").trim();
    if (inner && !out.includes(inner)) out.push(inner);
  }
  return out;
}

function ThinkingCard({ blocks }: { blocks: string[] }) {
  const [open, setOpen] = useState(false);
  if (blocks.length === 0) return null;
  const preview = blocks[0]?.split("\n")[0]?.slice(0, 80) ?? "Reasoning";
  return (
    <div className="rounded-lg border bg-muted/30">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
        title="Model reasoning"
      >
        <ChevronDown
          className={`size-3.5 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`}
        />
        <Bot className="size-3.5 shrink-0" />
        <span className="truncate font-medium">Thinking{open ? "" : ` — ${preview}`}</span>
      </button>
      {open && (
        <div className="space-y-1.5 border-t px-2.5 py-2">
          {blocks.map((b, i) => (
            <p key={i} className="whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
              {b}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Persistent tool-activity timeline (Cursor-style). Each toolLoop() step
 * stays visible after the model moves on; rows expand individually to
 * show tool name, args, and timestamp. File paths navigate to the editor.
 */
function ToolTimeline({ steps, onOpenFile }: { steps: ToolStep[]; onOpenFile?: (path: string) => void }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = (i: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  return (
    <ul className="space-y-1">
      {steps.map((step, i) => {
        const expanded = open.has(i);
        return (
          <li key={`${step.timestamp}-${i}`} className="rounded-md border bg-muted/30">
            <button
              onClick={() => toggle(i)}
              aria-expanded={expanded}
              className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground"
              title={`${step.tool} at ${step.timestamp}`}
            >
              <ChevronDown
                className={`size-3 shrink-0 transition-transform ${expanded ? "" : "-rotate-90"}`}
              />
              {/unknown tool|failed|error/i.test(step.resultSummary) ? (
                <X className="size-3 shrink-0 text-red-500" />
              ) : (
                <Check className="size-3 shrink-0 text-green-500" />
              )}
              <span className="truncate">{step.resultSummary}</span>
            </button>
            {expanded && (
              <div className="space-y-1 border-t px-2 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="font-semibold text-foreground">{step.tool}</span>
                  {Object.entries(step.args).map(([k, v]) => {
                    const val = String(v);
                    // Navigation: file-ish args open in the editor.
                    if ((k === "path" || k === "prefix") && val && onOpenFile) {
                      return (
                        <button
                          key={k}
                          onClick={() => onOpenFile(val)}
                          className="rounded bg-background px-1 py-px hover:text-foreground hover:underline"
                          title={`Open ${val} in editor`}
                        >
                          {k}: {val}
                        </button>
                      );
                    }
                    return (
                      <span key={k} className="rounded bg-background px-1 py-px">
                        {k}: {val}
                      </span>
                    );
                  })}
                </div>
                <div>{new Date(step.timestamp).toLocaleTimeString()}</div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function PlanChecklist({ plan }: { plan: PlanTask[] }) {  return (
    <ul className="mt-2 space-y-1.5">
      {plan.map((task, i) => (
        <li key={i} className="flex items-start gap-2 text-xs">
          {task.status === "complete" ? (
            <Check className="mt-0.5 size-3.5 shrink-0 text-green-500" />
          ) : task.status === "in_progress" ? (
            <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-yellow-500" />
          ) : (
            <CircleDashed className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span
            className={
              task.status === "complete"
                ? "text-muted-foreground line-through"
                : "text-foreground"
            }
          >
            {task.title}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Cursor-style changeset card: collapsed file list instead of the raw
 * "Pending changeset <id> ready for review" status line. Clicking a file
 * opens it in the editor (existing file) or its diff preview (new file).
 */
function ChangeSetCard({
  files,
  onOpenFile,
}: {
  files: string[];
  onOpenFile?: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border bg-muted/30">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs hover:text-foreground"
      >
        <ChevronDown
          className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`}
        />
        <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium">
          {files.length} file{files.length === 1 ? "" : "s"} ready for review
        </span>
      </button>
      {open && (
        <ul className="space-y-0.5 border-t px-2 py-1.5">
          {files.map((path) => (
            <li key={path}>
              <button
                onClick={() => onOpenFile?.(path)}
                className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground hover:underline"
                title={`Open ${path} in editor`}
              >
                <FileCode2 className="size-3.5 shrink-0" />
                <span className="truncate font-mono text-[11px]">{path}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AIPanel({
  projectId,
  attachables,
  externalAttachments,
  onExternalConsumed,
  onChangeset,
  onOpenFile,
}: {
  projectId: string;
  attachables: AttachableFile[];
  /** Ask-AI selections arriving from the editor (consumed into chips). */
  externalAttachments: Attachment[];
  onExternalConsumed: () => void;
  /** Agent-mode changeset ready → layout fetches diffs for review. */
  onChangeset: (changeSetId: string) => void;
  /** Open a changeset file in the editor (existing) or diff preview (new). */
  onOpenFile?: (path: string) => void;
}) {
  const [mode, setMode] = useState<AiPanelMode>("ask");
  const [messages, setMessages] = useState<PanelMessage[]>([]);
  const [input, setInput] = useState("");
  const [chips, setChips] = useState<AttachmentChip[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [provider, setProvider] = useState<AiProviderId>(DEFAULT_PROVIDER);
  const [model, setModel] = useState<string>(DEFAULT_MODEL);
  // Keep the selected model valid if the registry changes (HMR / edits).
  useEffect(() => {
    if (!PROVIDER_MODELS[provider]?.includes(model)) {
      setModel(PROVIDER_MODELS[provider]?.[0] ?? DEFAULT_MODEL);
    }
  }, [provider, model]);
  const transportRef = useRef<SseTransport | null>(null);

  // Merge Ask-AI selections from the editor into chips (deduped).
  useEffect(() => {
    if (externalAttachments.length === 0) return;
    setChips((prev) => {
      const known = new Set(
        prev.map((c) => `${c.filePath}:${c.startLine}-${c.endLine}`),
      );
      const fresh = externalAttachments.filter(
        (a) => !known.has(`${a.filePath}:${a.startLine}-${a.endLine}`),
      );
      if (fresh.length === 0) return prev;
      return [
        ...prev,
        ...fresh.map((a) => ({ ...a, id: nextId("chip") })),
      ];
    });
    onExternalConsumed();
  }, [externalAttachments, onExternalConsumed]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const streamingIdRef = useRef<string | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming, status]);

  useEffect(() => {
    return () => {
      transportRef.current?.abort();
      transportRef.current = null;
    };
  }, []);

  const removeChip = useCallback((id: string) => {
    setChips((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const addFileChip = useCallback(
    (file: AttachableFile) => {
      setChips((prev) => {
        if (prev.some((c) => c.filePath === file.path)) return prev;
        const lines = file.content.split("\n").length;
        return [
          ...prev,
          {
            id: nextId("chip"),
            filePath: file.path,
            startLine: 1,
            endLine: Math.max(1, lines),
            code: file.content,
          },
        ];
      });
      setAttachOpen(false);
    },
    [],
  );

  const setFeedback = useCallback((id: string, value: "up" | "down") => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === id
          ? { ...m, feedback: m.feedback === value ? null : value }
          : m,
      ),
    );
  }, []);

  const handleStop = useCallback(() => {
    transportRef.current?.abort();
    setStreaming(false);
    setStatus("Stopped");
    setMessages((prev) =>
      prev.map((m) =>
        m.id === streamingIdRef.current ? { ...m, streaming: false } : m,
      ),
    );
    streamingIdRef.current = null;
  }, []);

  const handleSend = useCallback(() => {
    const prompt = input.trim();
    if (!prompt || streaming) return;
    transportRef.current?.abort();

    const userMsg: PanelMessage = {
      id: nextId("msg"),
      role: "user",
      content: prompt,
    };
    const assistantId = nextId("msg");
    const assistantMsg: PanelMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      mode,
      streaming: true,
    };
    const history = [...messages, userMsg]
      .filter((m) => !m.streaming)
      .map((m) => ({ role: m.role, content: m.content }));
    const transport = new SseTransport();
    transportRef.current = transport;
    streamingIdRef.current = assistantId;

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput("");
    setChips([]);
    setStatus(mode === "plan" ? "Planning…" : "Thinking…");
    setStreaming(true);

    transport.send(
      {
        projectId,
        mode,
        prompt,
        attachments: chips.map(({ filePath, startLine, endLine, code }) => ({
          filePath,
          startLine,
          endLine,
          code,
        })),
        history,
        provider,
        model,
      },
      {
        onToken: (token) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, content: m.content + token } : m,
            ),
          );
        },
        onStatus: (text, tool) => {
          setStatus(text);
          // Tool activity appends a persistent timeline entry on the
          // streaming message — never overwrites previous steps.
          if (tool) {
            const step = {
              tool: tool.name,
              args: tool.args,
              resultSummary: text,
              timestamp: new Date().toISOString(),
            };
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, steps: [...(m.steps ?? []), step] }
                  : m,
              ),
            );
          }
        },
        onPlan: (plan) => {
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, plan } : m)),
          );
        },
        onChangeset: (changeSetId, files) => {
          // Attach the file list to the streaming message for the inline
          // accordion card; the review strip (Accept/Reject) is still driven
          // via onChangeset below. No status line — the card replaces it.
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    changeSetId,
                    changeSetFiles: files && files.length > 0 ? files : undefined,
                  }
                : m,
            ),
          );
          onChangeset(changeSetId);
        },
        onDone: () => {
          setStreaming(false);
          streamingIdRef.current = null;
          // Drop transient "Thinking…/Planning…" on completion, but keep
          // failure signals (e.g. changeset-invalid) — otherwise a failed
          // run looks identical to success with no output.
          setStatus((prev) =>
            prev && /invalid|failed|error|not saved|retry|needs fix/i.test(prev) ? prev : null,
          );
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, streaming: false } : m,
            ),
          );
        },
        onError: (message) => {
          setStreaming(false);
          streamingIdRef.current = null;
          setStatus(message);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, streaming: false } : m,
            ),
          );
        },
      },
    );
  }, [input, streaming, messages, mode, chips, projectId, onChangeset, provider, model]);

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Slim status header — mode lives in the composer below */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b px-3">
        <span className="flex-1 text-xs text-muted-foreground">
          {streaming ? (status ?? "Working…") : "Agent"}
        </span>
        {streaming && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
      </div>

      {/* Messages — full-width rows like Bolt */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <div className="text-lg font-bold italic tracking-tight">vibe</div>
            <p className="text-sm text-muted-foreground">How can Vibe help you today?</p>
            <p className="max-w-[260px] text-[11px] text-muted-foreground">
              {MODE_META[mode].hint}. Attach files with +, then send.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[90%] rounded-lg bg-primary px-3 py-2 text-[13px] leading-relaxed text-primary-foreground">
                    <div className="whitespace-pre-wrap break-words">{m.content}</div>
                  </div>
                </div>
              ) : (
                <div key={m.id} className="space-y-2">
                  {m.mode && (m.streaming || stripAgentBlocks(m.content) !== "" || m.plan || (m.steps && m.steps.length > 0) || (m.changeSetFiles && m.changeSetFiles.length > 0)) && (
                    <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
                      <Bot className="size-3.5" />
                      <span>{m.streaming ? (status ?? "Thinking…") : MODE_META[m.mode].label}</span>
                      {m.streaming && <Loader2 className="size-3 animate-spin" />}
                    </div>
                  )}
                  {m.steps && m.steps.length > 0 && (
                    <ToolTimeline steps={m.steps} onOpenFile={onOpenFile} />
                  )}
                  {extractThinking(m.content).length > 0 && (
                    <ThinkingCard blocks={extractThinking(m.content)} />
                  )}
                  {stripAgentBlocks(m.content) !== "" && (
                    <div className="text-[13px] leading-relaxed">
                      <AssistantMarkdown content={stripAgentBlocks(m.content)} />
                      {m.streaming && <span className="ml-0.5 inline-block h-3.5 w-[7px] animate-pulse rounded-[1px] bg-primary align-middle" />}
                    </div>
                  )}
                  {m.plan && (
                    <div className="rounded-lg border bg-muted/30 px-3 py-2">
                      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium">
                        Plan
                      </div>
                      <PlanChecklist plan={m.plan} />
                    </div>
                  )}
                  {m.changeSetFiles && m.changeSetFiles.length > 0 && (
                    <ChangeSetCard files={m.changeSetFiles} onOpenFile={onOpenFile} />
                  )}
                  {!m.streaming && (
                    <div className="flex items-center gap-0.5 text-muted-foreground">
                      <button
                        onClick={() => setFeedback(m.id, "up")}
                        className={`rounded p-1.5 hover:bg-accent hover:text-foreground ${m.feedback === "up" ? "text-green-500" : ""}`}
                        title="Good response"
                        aria-label="Thumbs up"
                      >
                        <ThumbsUp className="size-3.5" />
                      </button>
                      <button
                        onClick={() => setFeedback(m.id, "down")}
                        className={`rounded p-1.5 hover:bg-accent hover:text-foreground ${m.feedback === "down" ? "text-red-500" : ""}`}
                        title="Bad response"
                        aria-label="Thumbs down"
                      >
                        <ThumbsDown className="size-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              ),
            )}
            {!streaming && status && (
              <div className="text-[11px] text-muted-foreground">{status}</div>
            )}
          </div>
        )}
      </div>

      {/* Attachment chips */}
      {chips.length > 0 && (
        <div className="flex shrink-0 flex-wrap gap-1.5 px-3 pb-1.5">
          {chips.map((chip) => (
            <span
              key={chip.id}
              className="flex max-w-full items-center gap-1.5 rounded-md border bg-muted/60 py-1 pl-2 pr-1 text-[11px]"
              title={`${chip.filePath}:${chip.startLine}-${chip.endLine}`}
            >
              <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">
                {chip.filePath}:{chip.startLine}-{chip.endLine}
              </span>
              <button
                onClick={() => removeChip(chip.id)}
                className="rounded p-0.5 hover:bg-accent"
                aria-label={`Remove ${chip.filePath} attachment`}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Composer — Bolt style box */}
      <div className="shrink-0 p-3 pt-1">
        <div className="relative rounded-xl border bg-muted/40 focus-within:border-primary/60">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="How can Vibe help you today? (or /command)"
            rows={2}
            className="max-h-28 min-h-[52px] w-full resize-none bg-transparent px-3 pb-1 pt-2.5 text-[13px] outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center gap-1 px-2 pb-2">
            <button
              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              title="Attach an open file"
              aria-label="Attach an open file"
              onClick={() => setAttachOpen((v) => !v)}
            >
              <Plus className="size-4" />
            </button>
            <div className="relative">
              <button
                onClick={() => setModeOpen((v) => !v)}
                title={MODE_META[mode].hint}
                aria-label="Agent mode"
                aria-haspopup="menu"
                aria-expanded={modeOpen}
                className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {MODE_META[mode].label}
                <ChevronDown className={`size-3 transition-transform ${modeOpen ? "rotate-180" : ""}`} />
              </button>
              {modeOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setModeOpen(false)} />
                  <div
                    role="menu"
                    className="absolute bottom-9 left-0 z-20 w-44 overflow-hidden rounded-md border bg-popover p-1 shadow-md"
                  >
                    {(Object.keys(MODE_META) as AiPanelMode[]).map((key) => (
                      <button
                        key={key}
                        role="menuitemradio"
                        aria-checked={mode === key}
                        onClick={() => {
                          setMode(key);
                          setModeOpen(false);
                        }}
                        title={MODE_META[key].hint}
                        className={`flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left hover:bg-accent ${
                          mode === key ? "bg-accent/60" : ""
                        }`}
                      >
                        <span className="text-xs font-medium">{MODE_META[key].label}</span>
                        <span className="text-[11px] leading-tight text-muted-foreground">
                          {MODE_META[key].hint}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            {/* Cursor-style model picker: provider ▸ model, same row as mode */}
            <div className="relative">
              <button
                onClick={() => setModelOpen((v) => !v)}
                title={`${SUPPORTED_PROVIDERS[provider].label} · ${model}`}
                aria-label="Model"
                aria-haspopup="menu"
                aria-expanded={modelOpen}
                className="flex max-w-[140px] items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <span className="truncate">{model}</span>
                <ChevronDown className={`size-3 shrink-0 transition-transform ${modelOpen ? "rotate-180" : ""}`} />
              </button>
              {modelOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setModelOpen(false)} />
                  <div
                    role="menu"
                    className="absolute bottom-9 left-0 z-20 max-h-64 w-56 overflow-y-auto rounded-md border bg-popover p-1 shadow-md"
                  >
                    {(Object.keys(PROVIDER_MODELS) as AiProviderId[]).map((pid) => (
                      <div key={pid}>
                        <div className="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          {SUPPORTED_PROVIDERS[pid].label}
                        </div>
                        {PROVIDER_MODELS[pid].map((m) => (
                          <button
                            key={`${pid}:${m}`}
                            role="menuitemradio"
                            aria-checked={provider === pid && model === m}
                            onClick={() => {
                              setProvider(pid);
                              setModel(m);
                              setModelOpen(false);
                            }}
                            className={`flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs hover:bg-accent ${
                              provider === pid && model === m ? "bg-accent/60 font-medium" : ""
                            }`}
                          >
                            {(provider === pid && model === m) && (
                              <Check className="size-3 shrink-0" />
                            )}
                            <span className="truncate">{m}</span>
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
            <span className="flex-1" />
            <button
              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              title="Voice input (coming soon)"
              aria-label="Voice input (coming soon)"
              onClick={() => setStatus("Voice input is not available yet")}
            >
              <Mic className="size-4" />
            </button>
            {streaming ? (
              <button
                onClick={handleStop}
                className="flex size-7 items-center justify-center rounded-full bg-foreground text-background hover:opacity-90"
                title="Stop generating"
                aria-label="Stop generating"
              >
                <Square className="size-3.5 fill-current" />
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!input.trim()}
                className="flex size-7 items-center justify-center rounded-full bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-40"
                title="Send"
                aria-label="Send"
              >
                <ArrowUp className="size-4" />
              </button>
            )}
          </div>
          {attachOpen && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setAttachOpen(false)}
              />
              <div className="absolute bottom-12 left-2 z-20 max-h-48 w-64 overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
                {attachables.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    No open files to attach
                  </div>
                ) : (
                  attachables.map((file) => (
                    <button
                      key={file.id}
                      onClick={() => addFileChip(file)}
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
                      title={file.path}
                    >
                      <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{file.path}</span>
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
