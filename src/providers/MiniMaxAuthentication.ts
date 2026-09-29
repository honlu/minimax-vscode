import * as vscode from "vscode";

const API_KEY_SECRET_KEY = "minimax-vscode.apiKey";

export class MiniMaxAuthentication {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getApiKey(): Promise<string | undefined> {
    return this.secrets.get(API_KEY_SECRET_KEY);
  }

  async storeApiKey(key: string): Promise<void> {
    await this.secrets.store(API_KEY_SECRET_KEY, key.trim());
  }

  async getOrPromptApiKey(): Promise<string | undefined> {
    return (await this.getApiKey()) ?? this.promptForApiKey();
  }

  async promptForApiKey(): Promise<string | undefined> {
    const input = await vscode.window.showInputBox({
      prompt: "MiniMax Token Plan API key (platform.minimax.io or platform.minimaxi.com — must match minimax.apiBaseUrl)",
      password: true,
      placeHolder: "Paste API key",
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || value.trim().length === 0) {
          return "API key cannot be empty";
        }
        return undefined;
      },
    });

    if (!input) {
      return undefined;
    }

    const key = input.trim();
    await this.secrets.store(API_KEY_SECRET_KEY, key);
    vscode.window.showInformationMessage("MiniMax API key saved successfully");
    return key;
  }
}
