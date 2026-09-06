import { OpenAICompatProvider, type OpenAICompatConfig } from "./openai-compat";

export class OpenAIProvider extends OpenAICompatProvider {
  readonly id = "openai" as const;
  readonly name = "OpenAI";

  protected config(): OpenAICompatConfig {
    return {
      baseURL: process.env["OPENAI_BASE_URL"] || "https://api.openai.com/v1",
      apiKey: process.env["OPENAI_API_KEY"] || "",
      defaultModel: "gpt-4o-mini",
    };
  }

  isConfigured(): boolean {
    return this.config().apiKey.length > 0;
  }
}
