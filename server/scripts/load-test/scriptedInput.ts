import { mulberry32 } from '@magicarena/shared';

export interface ScriptedControls {
  readonly thrust: boolean;
  readonly turn: -1 | 0 | 1;
  readonly brake: boolean;
  readonly fire: boolean;
  readonly homingFire: boolean;
  readonly fireSeq?: number;
}

export type ScriptedInputStep = (stepIndex: number) => ScriptedControls;

const INPUT_HZ = 30;
const FIRE_PERIOD_MIN_STEPS = 12;
const FIRE_PERIOD_SPAN = 9;
const HOMING_PERIOD_MIN_STEPS = 75;
const HOMING_PERIOD_SPAN = 30;
const TURN_PERIOD_MIN_STEPS = 40;
const TURN_PERIOD_SPAN = 40;

/**
 * Creates a deterministic, zero-allocation scripted input generator for one headless client.
 */
export const createScriptedPlayer = (seed: number, clientIndex: number): ScriptedInputStep => {
  const clientSeed = (seed + Math.imul(clientIndex + 1, 2654435761)) >>> 0;
  const rng = mulberry32(clientSeed);

  const turnDirection: -1 | 1 = rng() < 0.5 ? -1 : 1;
  const turnPeriod = TURN_PERIOD_MIN_STEPS + Math.floor(rng() * TURN_PERIOD_SPAN);
  const turnPhase = Math.floor(rng() * turnPeriod);

  const fireInterval = FIRE_PERIOD_MIN_STEPS + Math.floor(rng() * FIRE_PERIOD_SPAN);
  const fireOffset = Math.floor(rng() * fireInterval);

  const homingInterval = HOMING_PERIOD_MIN_STEPS + Math.floor(rng() * HOMING_PERIOD_SPAN);
  const homingOffset = Math.floor(rng() * homingInterval);

  const brakePhase = Math.floor(rng() * (INPUT_HZ * 4));
  let fireSeq = 0;

  return (stepIndex: number): ScriptedControls => {
    const turnCycle = (stepIndex + turnPhase) % turnPeriod;
    const halfPeriod = Math.floor(turnPeriod / 2);
    const quarterPeriod = Math.floor(turnPeriod / 4);

    let turn: -1 | 0 | 1 = turnDirection;
    if (turnCycle >= halfPeriod && turnCycle < halfPeriod + quarterPeriod) {
      turn = 0;
    } else if (turnCycle >= halfPeriod + quarterPeriod) {
      turn = turnDirection === 1 ? -1 : 1;
    }

    const brake = (stepIndex + brakePhase) % (INPUT_HZ * 4) < 3;
    const thrust = !brake;

    const shouldHoming = (stepIndex + homingOffset) % homingInterval === 0;
    const shouldFire = !shouldHoming && (stepIndex + fireOffset) % fireInterval === 0;

    if (shouldFire || shouldHoming) {
      fireSeq += 1;
      return {
        thrust,
        turn,
        brake,
        fire: shouldFire,
        homingFire: shouldHoming,
        fireSeq,
      };
    }

    return {
      thrust,
      turn,
      brake,
      fire: false,
      homingFire: false,
    };
  };
};

