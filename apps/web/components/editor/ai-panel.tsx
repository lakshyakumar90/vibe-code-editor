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
import type { PlanTask } from "@repo/ai";
import { MockTransport } from "@/lib/ai/mock";
import type {
  AiPanelMode,
  AttachableFile,
  AttachmentChip,
  PanelMessage,
} from "@/lib/ai/types";

const MODE_META: Record<AiPanelMode, { label: string; hint: string }> = {
  ask: { label: "Ask", hint: "Read-only chat, no file access" },
  plan: { label: "Plan", hint: "Read-only plan as a checklist, no writes" },
  agent: { label: "Agent", hint: "Full tool loop (Phase 3)" },
};

let messageSeq = 0;
function nextId(prefix: string): string {
  messageSeq += 1;
  return `${prefix}-${Date.now()}-${messageSeq}`;
}

function PlanChecklist({ plan }: { plan: PlanTask[] }) {
  return (
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

export function AIPanel({ attachables }: { attachables: AttachableFile[] }) {
  const [mode, setMode] = useState<AiPanelMode>("ask");
  const [messages, setMessages] = useState<PanelMessage[]>([]);
  const [input, setInput] = useState("");
  const [chips, setChips] = useState<AttachmentChip[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const transportRef = useRef<MockTransport | null>(null);
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
    const transport = new MockTransport();
    transportRef.current = transport;
    streamingIdRef.current = assistantId;

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput("");
    setChips([]);
    setStatus(mode === "plan" ? "Planning…" : "Thinking…");
    setStreaming(true);

    transport.send(
      {
        mode,
        prompt,
        attachments: chips.map(({ filePath, startLine, endLine, code }) => ({
          filePath,
          startLine,
          endLine,
          code,
        })),
        history,
      },
      {
        onToken: (token) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, content: m.content + token } : m,
            ),
          );
        },
        onStatus: (text) => setStatus(text),
        onPlan: (plan) => {
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, plan } : m)),
          );
        },
        onDone: () => {
          setStreaming(false);
          streamingIdRef.current = null;
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
  }, [input, streaming, messages, mode, chips]);

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Messages */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <Bot className="size-6 text-muted-foreground" />
            <p className="text-xs font-medium text-foreground">
              Ask AI about your code
            </p>
            <p className="max-w-[280px] text-[11px] text-muted-foreground">
              {MODE_META[mode].hint}. Attach files with +, then send.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-lg px-3 py-2 text-xs ${
                    m.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted/60 text-foreground"
                  }`}
                >
                  {m.role === "assistant" && m.mode && (
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {MODE_META[m.mode].label}
                      {m.streaming ? " • streaming…" : ""}
                    </div>
                  )}
                  {m.content && (
                    <div className="whitespace-pre-wrap break-words">
                      {m.content}
                    </div>
                  )}
                  {m.role === "assistant" && m.plan && (
                    <PlanChecklist plan={m.plan} />
                  )}
                  {m.role === "assistant" && !m.streaming && (
                    <div className="mt-1.5 flex items-center gap-1 border-t border-border/50 pt-1.5">
                      <button
                        onClick={() => setFeedback(m.id, "up")}
                        className={`rounded p-1 hover:bg-accent ${m.feedback === "up" ? "text-green-500" : "text-muted-foreground"}`}
                        title="Good response"
                        aria-label="Thumbs up"
                      >
                        <ThumbsUp className="size-3.5" />
                      </button>
                      <button
                        onClick={() => setFeedback(m.id, "down")}
                        className={`rounded p-1 hover:bg-accent ${m.feedback === "down" ? "text-red-500" : "text-muted-foreground"}`}
                        title="Bad response"
                        aria-label="Thumbs down"
                      >
                        <ThumbsDown className="size-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Status line */}
      {status && (
        <div className="shrink-0 border-t px-3 py-1 text-[11px] text-muted-foreground">
          {status}
        </div>
      )}

      {/* Attachment chips */}
      {chips.length > 0 && (
        <div className="flex shrink-0 flex-wrap gap-1.5 border-t px-3 py-1.5">
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

      {/* Input row */}
      <div className="relative flex shrink-0 items-end gap-1.5 border-t p-2">
        <div className="relative shrink-0">
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as AiPanelMode)}
            className="h-8 cursor-pointer appearance-none rounded-md border bg-muted/60 pl-2 pr-7 text-xs font-medium outline-none hover:bg-accent"
            title={MODE_META[mode].hint}
            aria-label="AI mode"
          >
            {(Object.keys(MODE_META) as AiPanelMode[]).map((key) => (
              <option key={key} value={key} title={MODE_META[key].hint}>
                {MODE_META[key].label}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        </div>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={`Ask (${MODE_META[mode].label} mode)…`}
          rows={2}
          className="max-h-24 min-h-8 flex-1 resize-none rounded-md border bg-background px-2.5 py-1.5 text-xs outline-none placeholder:text-muted-foreground focus:border-primary"
        />
        <button
          className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Voice input (coming soon)"
          aria-label="Voice input (coming soon)"
          onClick={() => setStatus("Voice input is not available yet")}
        >
          <Mic className="size-4" />
        </button>
        <button
          className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Attach an open file"
          aria-label="Attach an open file"
          onClick={() => setAttachOpen((v) => !v)}
        >
          <Plus className="size-4" />
        </button>
        {streaming ? (
          <button
            onClick={handleStop}
            className="rounded-md bg-primary p-2 text-primary-foreground hover:bg-primary/90"
            title="Stop generating"
            aria-label="Stop generating"
          >
            <Square className="size-4" />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!input.trim()}
            className="rounded-md bg-primary p-2 text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            title="Send"
            aria-label="Send"
          >
            <ArrowUp className="size-4" />
          </button>
        )}
        {attachOpen && (
          <>
            <div
              className="fixed inset-0 z-10"
              onClick={() => setAttachOpen(false)}
            />
            <div className="absolute bottom-12 right-2 z-20 max-h-48 w-64 overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
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
  );
}
