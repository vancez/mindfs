export type ResponseProtectionInput = {
  required: boolean;
  ok: boolean;
  protectedResponse: boolean;
  hasContext: boolean;
  allowPlaintext?: boolean;
};

/**
 * Returns an error code when a JSON response must not be trusted, or null when
 * it may be parsed. Encrypted responses always need the request context used to
 * derive their AAD; successful responses must be encrypted while E2EE is on.
 */
export function responseProtectionError(input: ResponseProtectionInput): string | null {
  if (input.protectedResponse) {
    return input.hasContext ? null : "e2ee_response_context_missing";
  }
  if (input.required && input.ok && !input.allowPlaintext) {
    return "e2ee_response_unprotected";
  }
  return null;
}
