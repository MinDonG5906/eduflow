import "server-only";

export class DocumentImportError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
