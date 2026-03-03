import { BEDROCK_TIMEOUT } from "./util/limits.js";
import { logger } from "./util/log.js";

export type NovaModel = "nova-premier" | "nova-lite";

export const NOVA_MODELS: Record<NovaModel, string> = {
  "nova-premier": "us.amazon.nova-premier-v1:0",
  "nova-lite": "us.amazon.nova-lite-v1:0",
};

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;

export interface BedrockOptions {
  timeout?: number;
  maxTokens?: number;
  model?: NovaModel;
  temperature?: number;
}

export async function converseWithBedrock(
  systemPrompt: string,
  userMessage: string,
  opts: BedrockOptions = {},
): Promise<string> {
  const {
    timeout = BEDROCK_TIMEOUT,
    maxTokens = 4096,
    model = "nova-premier",
    temperature = 0.2,
  } = opts;

  const modelId = NOVA_MODELS[model];

  const token = process.env.NEEDLE_BEDROCK_BEARER_TOKEN;
  if (!token) {
    throw new Error("NEEDLE_BEDROCK_BEARER_TOKEN environment variable is required");
  }

  const region = process.env.NEEDLE_AWS_REGION ?? "us-east-1";
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/converse`;

  const body = {
    system: [{ text: systemPrompt }],
    messages: [
      {
        role: "user",
        content: [{ text: userMessage }],
      },
    ],
    inferenceConfig: {
      maxTokens,
      temperature,
    },
  };

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      logger.info("Retrying Bedrock request", { attempt, delay });
      await new Promise((r) => setTimeout(r, delay));
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`Bedrock API error ${response.status}: ${text}`);
      }

      const result = (await response.json()) as {
        output?: { message?: { content?: { text?: string }[] } };
      };

      const text =
        result.output?.message?.content?.[0]?.text ?? "";

      if (!text) {
        throw new Error("Empty response from Bedrock");
      }

      logger.info("Bedrock response received", {
        model,
        length: text.length,
        attempt,
      });
      return text;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      logger.warn("Bedrock request failed", {
        model,
        attempt,
        error: lastError.message,
      });
    }
  }

  throw lastError ?? new Error("Bedrock request failed after retries");
}
