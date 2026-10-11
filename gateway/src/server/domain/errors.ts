/**
 * Business errors carry a stable code, an HTTP status for the dashboard API and a short message that is safe to speak
 * aloud (the voice tools return it to the agent verbatim).
 */
export class GatewayError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 409,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new GatewayError('NOT_FOUND', `${what} was not found.`, 404);
