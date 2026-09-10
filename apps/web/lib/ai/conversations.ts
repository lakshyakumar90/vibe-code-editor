import { api } from "@/lib/api";

export interface ConversationSummary {
  id: string;
  projectId: string;
  title: string | null;
  mode: string;
  createdAt: string;
  updatedAt: string;
  _count?: { messages: number };
}

export interface StoredMessage {
  id: string;
  role: string;
  content: string;
  createdAt: string;
}

interface Envelope<T> {
  success: boolean;
  data: T;
}

/** Recent conversations for a project (newest first). */
export async function listConversations(projectId: string): Promise<ConversationSummary[]> {
  const res = await api.get<Envelope<ConversationSummary[]>>(
    `/api/ai/conversations?projectId=${encodeURIComponent(projectId)}`,
  );
  return res.data;
}

/** Create a conversation explicitly (new-chat flow). */
export async function createConversation(
  projectId: string,
  title?: string,
  mode?: string,
): Promise<ConversationSummary> {
  const res = await api.post<Envelope<ConversationSummary>>("/api/ai/conversations", {
    projectId,
    ...(title ? { title } : {}),
    ...(mode ? { mode } : {}),
  });
  return res.data;
}

/** Full message history for a conversation (oldest first). */
export async function getConversationMessages(conversationId: string): Promise<StoredMessage[]> {
  const res = await api.get<Envelope<{ messages: StoredMessage[] }>>(
    `/api/ai/conversations/${conversationId}/messages?limit=100`,
  );
  return res.data.messages;
}
