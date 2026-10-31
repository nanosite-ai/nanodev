// Prompts that never block a script or an agent: without a TTY (or in --json mode) they fail fast and
// name the argument that answers the question instead. Built on node:readline (no prompt library).
import { createInterface } from "node:readline/promises";
import { NeedsInputError } from "./errors.mjs";
import { isJsonMode } from "./output.mjs";

export const canPrompt = (): boolean => Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY) && !isJsonMode();

const ask = async (question: string): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
};

/** Parse a 1-based menu answer. Returns the index, or null when it is not a valid choice. */
export const parseChoice = (answer: string, count: number): number | null => {
  if (!/^\d+$/.test(answer.trim())) return null;
  const n = Number(answer.trim());
  return n >= 1 && n <= count ? n - 1 : null;
};

/** Pick one of `choices` (shown with their labels). Non-interactive: throws naming `flagHint`. */
export const select = async <T,>(
  message: string,
  choices: readonly { label: string; value: T }[],
  flagHint: string,
): Promise<T> => {
  if (!canPrompt()) throw new NeedsInputError(`${message}: ${flagHint}`);
  process.stdout.write(`${message}\n`);
  choices.forEach((choice, i) => process.stdout.write(`  ${i + 1}) ${choice.label}\n`));
  for (;;) {
    const index = parseChoice(await ask(`Choose 1-${choices.length}: `), choices.length);
    if (index !== null) return choices[index].value;
  }
};
