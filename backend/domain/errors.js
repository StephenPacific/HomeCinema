export class DomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.details = details;
  }
}

export class SessionNotFoundError extends DomainError {
  constructor(sessionId) {
    super("SESSION_NOT_FOUND", `Session ${sessionId} does not exist`, { session_id: sessionId });
  }
}

export class RevisionConflictError extends DomainError {
  constructor(expected, actual) {
    super("REVISION_CONFLICT", `Expected revision ${expected}, found ${actual}`, {
      expected_revision: expected,
      actual_revision: actual
    });
  }
}

export class InvalidTransitionError extends DomainError {
  constructor(from, operation) {
    super("INVALID_TRANSITION", `Cannot ${operation} while session is ${from}`, {
      state: from,
      operation
    });
  }
}

export class ProtocolViolationError extends DomainError {
  constructor(code, message, details = {}) {
    super(code, message, details);
  }
}
