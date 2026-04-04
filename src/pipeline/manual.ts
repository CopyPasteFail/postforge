import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export const waitForConfirmation = async (message: string): Promise<void> => {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Interactive confirmation is unavailable in a non-TTY environment.");
  }

  const rl = readline.createInterface({ input, output });
  try {
    await rl.question(`${message}\nPress Enter to continue... `);
  } finally {
    rl.close();
  }
};
