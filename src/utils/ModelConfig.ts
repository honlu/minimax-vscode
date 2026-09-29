import * as vscode from "vscode";
import {
  SUPPORTED_MODELS,
  getModelById,
  type ModelInfo,
} from "../api/types";

export const CONFIG_SECTION = "minimax";
export const VISIBLE_MODELS_KEY = "visibleModels";
export const CUSTOM_MODELS_KEY = "customModels";
export const API_BASE_URL_KEY = "apiBaseUrl";
export const DEFAULT_TEMPERATURE = 1;
export const DEFAULT_MAX_TOKENS = 8192;

export interface CustomModelConfig {
  id: string;
  name?: string;
  apiModelId?: string;
  contextLength?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  imageInput?: boolean;
}

const CUSTOM_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function getCustomModels(): ModelInfo[] {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const raw = config.get<unknown>(CUSTOM_MODELS_KEY);
  if (!Array.isArray(raw)) {
    return [];
  }

  const result: ModelInfo[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const candidate = entry as Partial<CustomModelConfig>;
    const id = candidate.id;
    if (typeof id !== "string" || !CUSTOM_MODEL_ID_PATTERN.test(id)) {
      continue;
    }
    if (SUPPORTED_MODELS.some((model) => model.id === id)) {
      continue;
    }
    if (result.some((model) => model.id === id)) {
      continue;
    }

    const contextLength = toPositiveInt(candidate.contextLength, 204_800);
    const maxInputTokens = Math.min(
      toPositiveInt(candidate.maxInputTokens, contextLength),
      contextLength,
    );
    const maxOutputTokens = toPositiveInt(candidate.maxOutputTokens, DEFAULT_MAX_TOKENS);

    result.push({
      id,
      name:
        typeof candidate.name === "string" && candidate.name.trim().length > 0
          ? candidate.name.trim()
          : id,
      apiModelId:
        typeof candidate.apiModelId === "string" && candidate.apiModelId.trim().length > 0
          ? candidate.apiModelId.trim()
          : undefined,
      contextLength,
      maxInputTokens,
      maxOutputTokens,
      imageInput: candidate.imageInput === true,
    });
  }
  return result;
}

function toPositiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

export function getApiBaseUrl(): string | undefined {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const url = config.get<string>(API_BASE_URL_KEY);
  if (typeof url !== "string" || url.trim().length === 0) {
    return undefined;
  }

  // The OpenAI SDK appends "/chat/completions" to this value, so trailing
  // slashes would produce a double slash and 404. Normalize it.
  return url.trim().replace(/\/+$/, "");
}

export function modelsWithApiKey(): vscode.LanguageModelChatInformation[] {
  const visibleModels = getVisibleModels();
  return visibleModels.map(
    (model) =>
      ({
        id: model.id,
        name: model.name,
        detail: "Token Plan",
        tooltip: `${model.name} -- in ${model.maxInputTokens.toLocaleString()} / out ${model.maxOutputTokens.toLocaleString()} max tokens (context up to ${model.contextLength.toLocaleString()})`,
        family: "minimax",
        version: getModelVersion(model.id),
        maxInputTokens: model.maxInputTokens,
        maxOutputTokens: model.maxOutputTokens,
        isUserSelectable: true,
        capabilities: {
          toolCalling: true,
          imageInput: model.imageInput === true,
        },
      }) as vscode.LanguageModelChatInformation,
  );
}

function getModelVersion(modelId: string): string {
  const match = /^MiniMax-M(.+)$/.exec(modelId);
  return match ? match[1] : "custom";
}

export function resolveModelInfo(id: string): ModelInfo | undefined {
  const builtin = getModelById(id);
  if (builtin) {
    return builtin;
  }
  return getCustomModels().find((model) => model.id === id);
}

function getVisibleModels(): readonly ModelInfo[] {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const raw = config.get<unknown>(VISIBLE_MODELS_KEY);
  const customModels = getCustomModels();

  if (!Array.isArray(raw)) {
    return [...SUPPORTED_MODELS, ...customModels];
  }

  // visibleModels only filters builtin models; custom models are always visible.
  // NOTE: the setting has a default array in package.json, so raw is almost
  // always an array even when the user never configured it — do not use its
  // presence to decide whether filtering applies.
  const configuredIds = new Set(
    raw
      .filter((value): value is string => typeof value === "string")
      .filter((id) => getModelById(id) !== undefined),
  );
  const visibleBuiltins = SUPPORTED_MODELS.filter((model) => configuredIds.has(model.id));
  const visibleModels = [...visibleBuiltins, ...customModels];
  return visibleModels.length > 0 ? visibleModels : [...SUPPORTED_MODELS, ...customModels];
}

export function resolveMaxTokens(
  options: vscode.ProvideLanguageModelChatResponseOptions,
  model: ModelInfo,
): number {
  const value = options.modelOptions?.maxTokens;
  const base =
    typeof value === "number" && Number.isInteger(value) && value > 0
      ? value
      : DEFAULT_MAX_TOKENS;
  return Math.min(base, model.maxOutputTokens);
}

export function resolveTemperature(
  options: vscode.ProvideLanguageModelChatResponseOptions,
): number {
  const value = options.modelOptions?.temperature;
  if (typeof value === "number" && value > 0 && value <= 1) {
    return value;
  }
  return DEFAULT_TEMPERATURE;
}

export function resolveTopP(
  options: vscode.ProvideLanguageModelChatResponseOptions,
): number | undefined {
  const optionsRecord = options.modelOptions as
    | { topP?: unknown; top_p?: unknown }
    | undefined;
  if (!optionsRecord) {
    return undefined;
  }
  const raw = optionsRecord.topP ?? optionsRecord.top_p;
  if (typeof raw === "number" && raw > 0 && raw <= 1) {
    return raw;
  }
  return undefined;
}
