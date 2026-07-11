import { RevisionConflictError, SessionNotFoundError } from "./domain/errors.js";
import { freezeSnapshot } from "./domain/session.js";

export class InMemorySessionStore {
  constructor() {
    this.sessions = new Map();
    this.messageResults = new Map();
  }

  async create(snapshot) {
    if (this.sessions.has(snapshot.session_id)) {
      throw new RevisionConflictError(-1, this.sessions.get(snapshot.session_id).revision);
    }
    const stored = freezeSnapshot(snapshot);
    this.sessions.set(snapshot.session_id, stored);
    return stored;
  }

  async get(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  async transition(sessionId, expectedRevision, update) {
    const current = this.sessions.get(sessionId);
    if (!current) throw new SessionNotFoundError(sessionId);
    if (current.revision !== expectedRevision) {
      throw new RevisionConflictError(expectedRevision, current.revision);
    }

    const proposed = update(current);
    const next = freezeSnapshot({
      ...proposed,
      session_id: current.session_id,
      server_incarnation_id: current.server_incarnation_id,
      revision: current.revision + 1
    });
    this.sessions.set(sessionId, next);
    return next;
  }

  async getMessageResult(sessionId, messageId) {
    return this.messageResults.get(`${sessionId}:${messageId}`) || null;
  }

  async rememberMessageResult(sessionId, messageId, result) {
    const key = `${sessionId}:${messageId}`;
    if (!this.messageResults.has(key)) this.messageResults.set(key, result);
    return this.messageResults.get(key);
  }
}
