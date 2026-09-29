import * as vscode from "vscode";
import { MiniMaxClient, type ChatOptions } from "../api/MiniMaxClient";
import { MiniMaxError } from "../api/MiniMaxError";
import { convertMessages } from "../utils/MessageConverter";
import {
  getApiBaseUrl,
  modelsWithApiKey,
  resolveMaxTokens,
  resolveModelInfo,
  resolveTemperature,
  resolveTopP,
} from "../utils/ModelConfig";
import {
  getLatestReasoningUpdate,
  getThinkingPartCtor,
  InlineThinkingParser,
  reportReasoning,
} from "../utils/ThinkingHelper";
import { TokenCounter } from "../utils/TokenCounter";
import {
  accumulateToolCalls,
  convertTools,
  isToolCallFinish,
  reportToolCalls,
  resolveToolChoice,
  type AccumulatedToolCall,
} from "../utils/ToolConverter";
import { MiniMaxErrorMapper } from "./ErrorMapper";
import { MiniMaxAuthentication } from "./MiniMaxAuthentication";

type PrepareOptionsWithConfiguration = vscode.PrepareLanguageModelChatModelOptions & {
  configuration?: Record<string, unknown>;
  modelConfiguration?: Record<string, unknown>;
};

function getObjectProperty(source: unknown, key: string): unknown {
  if (!source || typeof source !== "object") {
    return undefined;
  }
  return (source as Record<string, unknown>)[key];
}

function getStringProperty(source: unknown, key: string): string | undefined {
  if (!source || typeof source !== "object") {
    return undefined;
  }
  const value = (source as Record<string, unknown>)[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export class MiniMaxProvider implements vscode.LanguageModelChatProvider {
  private readonly modelsChangedEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.modelsChangedEmitter.event;

  private readonly modelApiKeys = new Map<string, string>();
  private lastPromptTokens = 0;

  constructor(
    private readonly apiClient: MiniMaxClient,
    private readonly authManager: MiniMaxAuthentication,
    private readonly tokenCounter: TokenCounter,
  ) { }

  notifyModelsChanged(): void {
    this.modelsChangedEmitter.fire();
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const optionsWithConfig = options as PrepareOptionsWithConfiguration;
    const configuredApiKey = this.extractConfiguredApiKey(optionsWithConfig);
    const models = modelsWithApiKey();

    if (!configuredApiKey) {
      this.modelApiKeys.clear();
      return [];
    }

    this.modelApiKeys.clear();
    for (const model of models) {
      this.modelApiKeys.set(model.id, configuredApiKey);
    }

    // Persist the vendor-configured key into our own secret storage, so that
    // request-time lookups succeed even when VS Code does not pass the
    // configuration back to provideLanguageModelChatResponse.
    // Only write when it actually changed: VS Code calls this method many
    // times per model-list refresh, and Keychain writes are expensive.
    const stored = await this.authManager.getApiKey();
    if (stored !== configuredApiKey) {
      await this.authManager.storeApiKey(configuredApiKey);
    }

    return models;
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    // Key resolution order:
    //  1. request options — VS Code passes the vendor config here
    //  2. in-memory cache — filled during provideLanguageModelChatInformation
    //  3. our own secret storage — fallback for older VS Code versions
    //  4. prompt the user
    const apiKey =
      this.extractApiKeyFromUnknown(options) ??
      this.modelApiKeys.get(model.id) ??
      (await this.authManager.getOrPromptApiKey());

    if (!apiKey) {
      throw new Error("API key not configured. Use the API key navigation action in the MiniMax model picker.");
    }

    try {
      await this.streamResponse(model, messages, options, progress, token, apiKey);
    } catch (error) {
      if (error instanceof MiniMaxError && error.statusCode === 401) {
        // Returns normally once the retry has produced a response; only
        // reaches the mapper below when the retry itself failed and threw.
        await this.retryWithNewApiKey(model, messages, options, progress, token);
        return;
      }
      await MiniMaxErrorMapper.throwMappedError(error);
    }
  }

  /**
   * Handles a 401 by asking for a fresh API key and retrying once.
   *
   * A 401 does not necessarily mean the key is wrong — it is also what the API
   * returns when `minimax.apiBaseUrl` points at a different platform than the
   * one the key was issued for (minimax.io vs minimaxi.com). We therefore keep
   * the key in place, and if the retry also fails we surface that hint instead
   * of silently looping between the prompt and the failing request.
   */
  private async retryWithNewApiKey(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    this.notifyModelsChanged();
    const newKey = await this.authManager.promptForApiKey();
    this.modelApiKeys.clear();

    if (!newKey) {
      this.notifyModelsChanged();
      throw new Error(
        "Invalid API key. Please set a new one using the API key navigation action in the MiniMax model picker.",
      );
    }

    this.modelApiKeys.set(model.id, newKey);
    this.notifyModelsChanged();

    try {
      await this.streamResponse(model, messages, options, progress, token, newKey);
    } catch (retryError) {
      if (retryError instanceof MiniMaxError && retryError.statusCode === 401) {
        throw new Error(
          `Still rejected with HTTP 401 after entering a new key. The key is likely valid for a different platform: ` +
            `set minimax.apiBaseUrl to https://api.minimax.io/v1 (platform.minimax.io) or ` +
            `https://api.minimaxi.com/v1 (platform.minimaxi.com) to match where the key was issued.`,
        );
      }
      await MiniMaxErrorMapper.throwMappedError(retryError);
    }
  }

  provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Thenable<number> {
    if (typeof text === "string") {
      return Promise.resolve(this.tokenCounter.estimateTokens(text));
    }

    let tokens = 0;
    for (const part of text.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        tokens += this.tokenCounter.estimateTokens(part.value);
      } else if (part instanceof vscode.LanguageModelDataPart) {
        tokens += Math.ceil(part.data.length / 4);
      }
    }
    return Promise.resolve(tokens);
  }

  private async streamResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    apiKey: string,
  ): Promise<void> {
    const resolvedModel = resolveModelInfo(model.id);
    if (!resolvedModel) {
      throw new Error(`Unsupported model "${model.id}" for MiniMax (coding / Token Plan).`);
    }

    let reasoningBuffer = "";
    const thinkingPartCtor = getThinkingPartCtor();
    const inlineParser = new InlineThinkingParser();
    const pendingToolCalls = new Map<number, AccumulatedToolCall>();
    let toolCallsEmitted = false;
    const tools = convertTools(options.tools);

    const chatOptions: ChatOptions = {
      maxTokens: resolveMaxTokens(options, resolvedModel),
      temperature: resolveTemperature(options),
      apiKey,
      baseUrl: getApiBaseUrl(),
      tools,
      toolChoice: resolveToolChoice(options, tools),
      reasoningSplit: true,
    };
    const topP = resolveTopP(options);
    if (topP !== undefined) {
      chatOptions.topP = topP;
    }

    const stream = await this.apiClient.streamChat(
      resolvedModel.apiModelId ?? resolvedModel.id,
      convertMessages(messages),
      chatOptions,
      token,
    );

    for await (const chunk of stream) {
      if (token.isCancellationRequested) {
        return;
      }

      for (const choice of chunk.choices) {
        const latestReasoning = getLatestReasoningUpdate(choice);
        const reasoningContent = (choice.delta as { reasoning_content?: string } | undefined)
          ?.reasoning_content;

        if (latestReasoning) {
          const newReasoning = latestReasoning.text.startsWith(reasoningBuffer)
            ? latestReasoning.text.slice(reasoningBuffer.length)
            : latestReasoning.text;

          if (newReasoning) {
            reportReasoning(progress, thinkingPartCtor, newReasoning, latestReasoning);
            reasoningBuffer = latestReasoning.text;
          }
        } else if (reasoningContent) {
          if (thinkingPartCtor) {
            progress.report(new thinkingPartCtor(reasoningContent) as vscode.LanguageModelResponsePart);
          } else {
            progress.report(new vscode.LanguageModelTextPart(`[thinking]${reasoningContent}[/thinking]`));
          }
        }

        const rawContent = choice.delta?.content;
        if (rawContent) {
          const { cleaned, thinking: inlineThinking } = inlineParser.feed(rawContent);
          if (inlineThinking) {
            if (thinkingPartCtor) {
              progress.report(new thinkingPartCtor(inlineThinking) as vscode.LanguageModelResponsePart);
            } else {
              progress.report(new vscode.LanguageModelTextPart(`[thinking]${inlineThinking}[/thinking]`));
            }
          }
          if (cleaned) {
            progress.report(new vscode.LanguageModelTextPart(cleaned));
          }
        }

        accumulateToolCalls(choice, pendingToolCalls);
        if (!toolCallsEmitted && isToolCallFinish(choice)) {
          reportToolCalls(progress, pendingToolCalls);
          toolCallsEmitted = true;
        }
      }
      
      if (chunk.usage?.prompt_tokens) {
        this.lastPromptTokens = chunk.usage.prompt_tokens;
      }
    }
  }

  private extractConfiguredApiKey(
    options: PrepareOptionsWithConfiguration,
  ): string | undefined {
    return this.extractApiKeyFromUnknown(options);
  }

  private extractApiKeyFromUnknown(options: unknown): string | undefined {
    // VS Code 1.120+ passes provider config as `modelConfiguration`;
    // older versions use `configuration`. Read both.
    const fromModelConfig = getStringProperty(getObjectProperty(options, "modelConfiguration"), "apiKey");
    if (fromModelConfig) {
      return fromModelConfig;
    }
    const fromLegacyConfig = getStringProperty(getObjectProperty(options, "configuration"), "apiKey");
    if (fromLegacyConfig) {
      return fromLegacyConfig;
    }
    return undefined;
  }
}
