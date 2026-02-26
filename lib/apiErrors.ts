import type { VercelResponse } from "@vercel/node";

export type ApiErrorPayload = {
  code: string;
  message: string;
  requestId: string;
  details?: unknown;
};

export function buildApiErrorPayload(input: ApiErrorPayload): ApiErrorPayload & { error: string } {
  const payload: ApiErrorPayload & { error: string } = {
    code: input.code,
    error: input.code,
    message: input.message,
    requestId: input.requestId
  };

  if (input.details !== undefined) payload.details = input.details;
  return payload;
}

export function sendApiError(
  res: VercelResponse,
  statusCode: number,
  input: ApiErrorPayload
): VercelResponse {
  return res.status(statusCode).json(buildApiErrorPayload(input));
}
