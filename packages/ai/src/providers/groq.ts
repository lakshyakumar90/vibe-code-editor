import { OpenAICompatProvider, type OpenAICompatConfig } from "./openai-compat.js";

export class GroqProvider extends OpenAICompatProvider {
  readonly id = "groq" as const;
  readonly name = "Groq";

  protected config(): OpenAICompatConfig {
    return {
      baseURL: "https://api.groq.com/openai/v1",
      apiKey: process.env["GROQ_API_KEY"] || "",
      defaultModel: "openai/gpt-oss-20b",
    };
  }

  isConfigured(): boolean {
    return this.config().apiKey.length > 0;
  }
}
