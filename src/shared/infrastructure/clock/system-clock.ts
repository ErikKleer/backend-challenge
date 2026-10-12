import type { Clock } from "../../application/clock.port";

export class SystemClock implements Clock {
  public now(): Date {
    return new Date();
  }
}

