import { config } from "../config.js";
import { HttpError } from "../http.js";

export class PasswordOperationGate {
  #active = 0;
  #waiting: (() => void)[] = [];
  constructor(
    private maximumActive: number,
    private maximumWaiting: number,
  ) {
    if (
      !Number.isInteger(maximumActive) ||
      maximumActive < 1 ||
      !Number.isInteger(maximumWaiting) ||
      maximumWaiting < 0
    )
      throw new RangeError(
        "Password capacity must have a positive concurrency and a nonnegative queue size",
      );
  }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#active < this.maximumActive) this.#active++;
    else {
      if (this.#waiting.length >= this.maximumWaiting)
        throw new HttpError(
          503,
          "AUTHENTICATION_BUSY",
          "Sign-in is busy. Try again shortly.",
          { "Retry-After": "1" },
        );
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
    try {
      return await operation();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#active--;
    }
  }
}
let gate: PasswordOperationGate | undefined;
export function runPasswordOperation<T>(operation: () => Promise<T>) {
  const options = config();
  gate ??= new PasswordOperationGate(
    options.MILL_PASSWORD_VERIFY_CONCURRENCY,
    options.MILL_PASSWORD_VERIFY_QUEUE_LIMIT,
  );
  return gate.run(operation);
}
