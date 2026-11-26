import { createHash } from 'node:crypto'

export class InvalidCalendarPreconditionError extends Error {}
export class StaleCalendarError extends Error {}

/** Opaque revision of a consistent persisted snapshot; never expose its contents. */
export function calendarTag(snapshot: unknown, scope: string) {
  return `"${createHash('sha256').update(JSON.stringify({ scope, snapshot })).digest('hex')}"`
}

export function assertCalendarPrecondition(expected: string | undefined, actual: string) {
  // Existing clients remain compatible. The administrative UI always sends a revision.
  if (expected === undefined) return
  if (!/^"[a-f0-9]{64}"$/.test(expected)) throw new InvalidCalendarPreconditionError()
  if (expected !== actual) throw new StaleCalendarError()
}
