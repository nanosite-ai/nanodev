/** A failure with a one-line, actionable message. The CLI prints it and exits with `exitCode`. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** Raised when a command needs an answer it can't ask for (no TTY, or --json). */
export class NeedsInputError extends CliError {
  constructor(message: string) {
    super(message, 2);
    this.name = "NeedsInputError";
  }
}
