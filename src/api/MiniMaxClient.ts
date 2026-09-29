import * as vscode from "vscode";
import OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions/completions";
import type { MiniMaxMessage, MiniMaxToolDefinition } from "./types";
import { MiniMaxError } from "./MiniMaxError";
import { toMiniMaxError } from "./MiniMaxErrorMapper";

export { MiniMaxError };

export interface ChatOptions {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  apiKey?: string;
  baseUrl?: string;
  tools?: MiniMaxToolDefinition[];
  toolChoice?: "auto" | "required";
  reasoningSplit?: boolean;
}

export class MiniMaxClient {
  private readonly defaultBaseUrl = "https://api.minimax.io/v1";

  /**
   * Starts a streaming chat request.
   *
   * NOTE: This is intentionally NOT an `async *` generator function. With a
   * generator, the request would only fire when the consumer pulls the first
   * chunk inside its `for await` loop — which escapes the provider's
   * try/catch, so a 401 (bad key) never triggers the re-prompt flow and the
   * user gets asked for the key on every single message.
   *
   * Instead, we await the request setup + first chunk here, so auth errors
   * throw synchronously at the `await` point. The returned generator replays
   * the first chunk and then continues the stream.
   */
  async streamChat(
    model: string,
    messages: MiniMaxMessage[],
    options?: ChatOptions,
    cancellationToken?: vscode.CancellationToken,
  ): Promise<AsyncGenerator<ChatCompletionChunk>> {
    const apiKey = options?.apiKey?.trim();
    if (!apiKey) {
      throw new MiniMaxError("API key is required", "NO_API_KEY", 401);
    }

    const abortController = new AbortController();
    const cancellationDisposable = cancellationToken?.onCancellationRequested(() =>
      abortController.abort(),
    );

    try {
      const baseUrl = options?.baseUrl?.trim() || this.defaultBaseUrl;
      const client = new OpenAI({ apiKey, baseURL: baseUrl });

      const params: ChatCompletionCreateParamsStreaming = {
        model,
        stream: true,
        messages: this.toOpenAiMessages(messages),
        temperature: options?.temperature ?? 1,
        max_tokens: options?.maxTokens ?? 8192,
      };
      if (typeof options?.topP === "number" && options.topP > 0 && options.topP <= 1) {
        (params as ChatCompletionCreateParamsStreaming & { top_p?: number }).top_p = options.topP;
      }
      if (options?.tools && options.tools.length > 0) {
        (params as ChatCompletionCreateParamsStreaming & { tools?: MiniMaxToolDefinition[] }).tools =
          options.tools;
      }
      if (options?.toolChoice) {
        (params as ChatCompletionCreateParamsStreaming & { tool_choice?: "auto" | "required" }).tool_choice =
          options.toolChoice;
      }
      (params as ChatCompletionCreateParamsStreaming & { extra_body?: { reasoning_split?: boolean } }).extra_body =
        { reasoning_split: options?.reasoningSplit ?? true };
      params.stream_options = { include_usage: true };

      const stream = (await client.chat.completions.create(params, {
        signal: abortController.signal,
      })) as AsyncIterable<ChatCompletionChunk>;

      // Pull the first chunk now, so a request-level error (e.g. 401) throws
      // here instead of inside the consumer's for-await loop.
      const iterator = stream[Symbol.asyncIterator]();
      const first = await iterator.next();

      return this.replay(iterator, first, cancellationToken, cancellationDisposable);
    } catch (error) {
      cancellationDisposable?.dispose();
      throw toMiniMaxError(error);
    }
  }

  private async *replay(
    iterator: AsyncIterator<ChatCompletionChunk>,
    first: IteratorResult<ChatCompletionChunk>,
    cancellationToken: vscode.CancellationToken | undefined,
    cancellationDisposable: vscode.Disposable | undefined,
  ): AsyncGenerator<ChatCompletionChunk> {
    try {
      if (!first.done) {
        if (!cancellationToken?.isCancellationRequested) {
          yield first.value;
        }
      }
      while (true) {
        if (cancellationToken?.isCancellationRequested) {
          return;
        }
        const next = await iterator.next();
        if (next.done) {
          return;
        }
        yield next.value;
      }
    } finally {
      cancellationDisposable?.dispose();
    }
  }

  private toOpenAiMessages(messages: MiniMaxMessage[]): ChatCompletionMessageParam[] {
    return messages.map((message) => {
      if (message.role === "assistant") {
        return {
          role: "assistant",
          content: message.content,
          tool_calls: message.tool_calls,
          reasoning_details: message.reasoning_details,
          ...(message.name ? { name: message.name } : {}),
        } as unknown as ChatCompletionMessageParam;
      }
      if (message.role === "tool") {
        return {
          role: "tool",
          tool_call_id: message.tool_call_id,
          content: message.content,
        } as unknown as ChatCompletionMessageParam;
      }
      if (message.role === "user") {
        return {
          role: "user",
          content: message.content,
          ...(message.name ? { name: message.name } : {}),
        } as unknown as ChatCompletionMessageParam;
      }
      return {
        role: "system",
        content: message.content,
        ...(message.name ? { name: message.name } : {}),
      } as ChatCompletionMessageParam;
    });
  }
}
