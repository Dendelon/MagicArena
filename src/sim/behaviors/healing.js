export const createHealingEffect = (amount = 1) => {
  const apply = (entity) => {
    if (typeof entity.heal !== 'function') {
      return false;
    }

    return entity.heal(amount);
  };

  return { apply };
};
