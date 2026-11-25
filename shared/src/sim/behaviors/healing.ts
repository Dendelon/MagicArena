import type { HealingData } from '../../types.ts';

export interface Healable {
  heal?(amount: number): boolean;
}

export interface HealingEffect extends HealingData {
  apply(entity: Healable): boolean;
}

export const createHealingEffect = (amount = 1): HealingEffect => {
  const apply = (entity: Healable): boolean => {
    if (typeof entity.heal !== 'function') {
      return false;
    }

    return entity.heal(amount);
  };

  return {
    kind: 'healing',
    amount,
    apply,
  };
};

