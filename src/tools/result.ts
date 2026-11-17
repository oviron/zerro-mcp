import { ToolInputError } from "../view";
import { UnknownOutcomeError, ZenMoneyError } from "../zenmoney/client";

export const toolText = (text: string) => ({ content: [{ type: "text" as const, text }] });
export const toolError = (text: string) => ({ ...toolText(text), isError: true });

/** Turns expected failures into tool errors; anything else is a bug and says so. */
export function withErrors<A, R>(handler: (args: A) => Promise<R>) {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (error) {
      if (error instanceof ToolInputError || error instanceof ZenMoneyError || error instanceof UnknownOutcomeError)
        return toolError(error.message);
      return toolError(`Internal error: ${(error as Error).message}`);
    }
  };
}
