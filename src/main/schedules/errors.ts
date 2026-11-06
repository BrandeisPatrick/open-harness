// Validation failures carry a stable code at the start of the message, so the model (and the window) can tell
// what to fix without parsing prose.

export type ScheduleErrorCode =
  | 'frequency_too_high'
  | 'not_future'
  | 'bad_time'
  | 'bad_cron'
  | 'too_many'
  | 'not_found'
  | 'too_long'
  /** A required argument is missing or of the wrong kind (an empty prompt, an unknown target) */
  | 'bad_input';

export class ScheduleError extends Error {
  constructor(
    readonly code: ScheduleErrorCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'ScheduleError';
  }
}
