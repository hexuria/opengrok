export class AgentStoreUnauthorizedError extends Error {
  constructor(message = "Agent store token is unauthorized") { super(message); this.name = "AgentStoreUnauthorizedError"; }
}
export class AgentStoreDirectoryListingError extends Error {
  constructor(message: string) { super(message); this.name = "AgentStoreDirectoryListingError"; }
}
export class AgentStoreProtocolError extends Error {
  constructor(message: string) { super(message); this.name = "AgentStoreProtocolError"; }
}
