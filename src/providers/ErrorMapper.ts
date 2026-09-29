import { MiniMaxError } from "../api/MiniMaxError";

export class MiniMaxErrorMapper {
  static async throwMappedError(error: unknown): Promise<never> {
    if (error instanceof MiniMaxError) {
      if (error.statusCode === 401) {
        // Do NOT delete the stored key here. A 401 is also what the API
        // returns when minimax.apiBaseUrl points at a different platform than
        // the one that issued the key, and wiping the key there sends the user
        // into a re-prompt loop that can never succeed.
        throw new Error(
          "MiniMax rejected the API key (HTTP 401). If the key is valid, check that " +
            "minimax.apiBaseUrl matches the platform that issued it: " +
            "https://api.minimax.io/v1 (platform.minimax.io) or " +
            "https://api.minimaxi.com/v1 (platform.minimaxi.com).",
        );
      }
      if (error.statusCode === 429) {
        throw new Error("Rate limit exceeded. Please wait and try again.");
      }
      throw new Error(`MiniMax API error: ${error.message}`);
    }

    if (error instanceof Error) {
      throw error;
    }

    throw new Error(String(error));
  }
}
