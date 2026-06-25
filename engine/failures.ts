export type FailureCode =
  | 'INVALID_INPUT'
  | 'UNSUPPORTED_PROVIDER'
  | 'AUTH_REQUIRED'
  | 'CAPTCHA'
  | 'RATE_LIMITED'
  | 'SELECTOR_MISSING'
  | 'BROWSER_LAUNCH'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'PERSISTENCE_ERROR'
  | 'EXTRACTION_EMPTY'
  | 'UNKNOWN';

export class DomainError extends Error {
  public readonly code: FailureCode;
  public readonly publicMessage: string;
  public readonly diagnostic?: string;
  public readonly stage?: string;
  public readonly submissionConfirmed: boolean;

  constructor(params: {
    code: FailureCode;
    message: string;
    publicMessage?: string;
    diagnostic?: string;
    stage?: string;
    submissionConfirmed?: boolean;
  }) {
    super(params.message);
    this.name = 'DomainError';
    this.code = params.code;
    this.publicMessage = params.publicMessage ?? params.message;
    this.diagnostic = params.diagnostic;
    this.stage = params.stage;
    this.submissionConfirmed = params.submissionConfirmed ?? false;
  }
}

export type FailureClassification = {
  code: FailureCode;
  message: string;
  publicMessage: string;
  stage?: string;
  submissionConfirmed: boolean;
  retryable: boolean;
};

export function classifyFailure(error: unknown, submissionConfirmed = false): FailureClassification {
  const err = error as any;
  const message = err?.message || String(error);
  const code = classifyFailureCode(error);
  const stage = err?.stage;
  const confirmed = Boolean(err?.submissionConfirmed ?? submissionConfirmed);
  const retryable = isRetryableFailure(code, stage, confirmed);

  return {
    code,
    message,
    publicMessage: err?.publicMessage || publicMessageForCode(code),
    stage,
    submissionConfirmed: confirmed,
    retryable
  };
}

export function isRetryableFailure(code: FailureCode, stage?: string, submissionConfirmed = false): boolean {
  if (submissionConfirmed) return false;
  if (code === 'RATE_LIMITED') return true;
  if (code !== 'TIMEOUT' && code !== 'SELECTOR_MISSING') return false;
  return stage === 'navigation' || stage === 'input readiness' || stage === 'browser launch' || stage === 'context creation' || stage === 'page creation';
}

export function publicMessageForCode(code: FailureCode): string {
  switch (code) {
    case 'INVALID_INPUT': return 'The request input is invalid.';
    case 'UNSUPPORTED_PROVIDER': return 'The requested provider is not supported.';
    case 'AUTH_REQUIRED': return 'The provider requires authentication.';
    case 'CAPTCHA': return 'The provider requires manual CAPTCHA intervention.';
    case 'RATE_LIMITED': return 'The provider is temporarily rate limited.';
    case 'SELECTOR_MISSING': return 'The provider interface could not be located.';
    case 'BROWSER_LAUNCH': return 'The browser could not be launched in the current runtime.';
    case 'TIMEOUT': return 'The provider operation timed out.';
    case 'ABORTED': return 'The provider operation was cancelled.';
    case 'PERSISTENCE_ERROR': return 'The result could not be persisted.';
    case 'EXTRACTION_EMPTY': return 'The provider returned no extractable output.';
    case 'UNKNOWN': return 'The provider failed for an unknown reason.';
  }
}

function classifyFailureCode(error: unknown): FailureCode {
  const err = error as any;
  const code = err?.code;
  const failureClass = err?.failure_class;
  const message = err?.message || String(error);

  if (code === 'ABORT_ERR' || code === 'CANCELLED' || err?.name === 'AbortError') return 'ABORTED';
  if (code === 'TIMEOUT' || /timed out|timeout/i.test(message)) return 'TIMEOUT';
  if (code === 'INTERVENTION_REQUIRED' && /auth|login/i.test(`${failureClass} ${message}`)) return 'AUTH_REQUIRED';
  if (/AUTH_EXPIRED|auth|login/i.test(`${failureClass} ${message}`)) return 'AUTH_REQUIRED';
  if (/CAPTCHA/i.test(`${failureClass} ${message}`)) return 'CAPTCHA';
  if (/RATE_LIMITED|rate limit|too many requests/i.test(`${failureClass} ${message}`)) return 'RATE_LIMITED';
  if (/headed browser without having an? XServer|Missing X server|platform failed to initialize|browserType\.launch/i.test(message)) return 'BROWSER_LAUNCH';
  if (/selector|locator|Failed to locate|not visible|input readiness/i.test(message)) return 'SELECTOR_MISSING';
  if (/empty markdown|empty_extraction|no extractable/i.test(`${failureClass} ${message}`)) return 'EXTRACTION_EMPTY';
  if (/Unsupported provider/i.test(message)) return 'UNSUPPORTED_PROVIDER';
  if (/invalid|required/i.test(message)) return 'INVALID_INPUT';
  return 'UNKNOWN';
}
