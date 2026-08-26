/** Fail-closed FD199 handoff errors. @module @deepseek-ai/dsh-remote-host-fd199/error */

/** The FD199 authority, descriptor, or transition is unavailable or invalid. */
export class Fd199AuthorityError extends Error {
  constructor() {
    super('the signed-Host FD199 handoff is unavailable or invalid')
    this.name = 'Fd199AuthorityError'
  }
}
