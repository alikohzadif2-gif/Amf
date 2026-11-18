import { FERTILE_AFTER, FERTILE_BEFORE, LUTEAL_DAYS, PMS_DAYS, type DayInfo } from './cycle';

/** R5b: the coloured stretches of the progress ring, as fractions (0..1) of one cycle, clockwise from the top. */
export type RingArc = { phase: 'period' | 'fertile' | 'pms'; from: number; to: number };

export function ringArcs(info: DayInfo): RingArc[] {
  const length = Math.max(info.cycleLength, 1);
  const ov = length - LUTEAL_DAYS;
  const out: RingArc[] = [];
  const add = (phase: RingArc['phase'], a: number, b: number) => {
    if (b > a) out.push({ phase, from: a / length, to: Math.min(b, length) / length });
  };
  add('period', 0, info.periodLength);
  const fertileFrom = Math.max(info.periodLength, ov - FERTILE_BEFORE);
  const fertileTo = ov + FERTILE_AFTER + 1;
  add('fertile', fertileFrom, fertileTo);
  add('pms', Math.max(length - PMS_DAYS, fertileTo, info.periodLength), length); // the phase order of cycle.ts: fertile before PMS
  return out;
}

/** Where today's dot sits (middle of today's slice); stays at the end of the ring while the period is late. */
export function ringMarker(info: DayInfo): number {
  const length = Math.max(info.cycleLength, 1);
  return Math.min(info.dayOfCycle - 0.5, length) / length;
}
