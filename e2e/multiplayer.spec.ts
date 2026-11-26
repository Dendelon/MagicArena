import { expect, test } from '@playwright/test';

import { createE2ERoom, joinGame, readRenderProbe } from './helpers.ts';

const wrappedDistance = (a: number, b: number, size: number): number => {
  const distance = Math.abs(a - b) % size;

  return Math.min(distance, size - distance);
};

const measureRemoteDisplacement = async (
  pageTwo: Parameters<typeof readRenderProbe>[0],
  playerOneOwnerId: string,
  initialPos: { readonly x: number; readonly y: number },
  initialTick: number,
): Promise<number> => {
  const frame = await readRenderProbe(pageTwo);

  if (!frame || frame.tick === null || frame.tick <= initialTick) {
    return 0;
  }

  const remote = frame.swords.find(
    (sword) => !sword.isOwnSword && sword.ownerId === playerOneOwnerId,
  );

  if (!remote) return 0;

  const dx = wrappedDistance(remote.x, initialPos.x, frame.width);
  const dy = wrappedDistance(remote.y, initialPos.y, frame.height);

  return Math.hypot(dx, dy);
};

test('Two players see each other move and exchange chat messages', async ({
  browser,
  request,
}) => {
  const room = await createE2ERoom(request);

  const contextOne = await browser.newContext();
  const contextTwo = await browser.newContext();

  try {
    const pageOne = await contextOne.newPage();
    const pageTwo = await contextTwo.newPage();

    const pageOneErrors: Error[] = [];
    const pageTwoErrors: Error[] = [];

    pageOne.on('pageerror', (error) => {
      pageOneErrors.push(error);
    });
    pageTwo.on('pageerror', (error) => {
      pageTwoErrors.push(error);
    });

    // Scenario A — Both players join the same obstacle-free room.
    await joinGame(pageOne, 'Player One', room.id);
    await joinGame(pageTwo, 'Player Two', room.id);

    for (const page of [pageOne, pageTwo]) {
      const roster = page.locator('.magic-chat-roster');

      await expect(roster).toContainText('Player One');
      await expect(roster).toContainText('Player Two');
    }

    await expect
      .poll(async () => {
        const frameOne = await readRenderProbe(pageOne);
        const frameTwo = await readRenderProbe(pageTwo);

        if (!frameOne || !frameTwo) return false;
        if (frameOne.swords.length !== 2 || frameTwo.swords.length !== 2) {
          return false;
        }

        return (
          frameOne.swords.filter((s) => s.isOwnSword).length === 1 &&
          frameOne.swords.filter((s) => !s.isOwnSword).length === 1 &&
          frameTwo.swords.filter((s) => s.isOwnSword).length === 1 &&
          frameTwo.swords.filter((s) => !s.isOwnSword).length === 1
        );
      })
      .toBe(true);

    const frameOne = await readRenderProbe(pageOne);
    const frameTwo = await readRenderProbe(pageTwo);

    expect(frameOne).not.toBeNull();
    expect(frameTwo).not.toBeNull();

    const playerOneOwn = frameOne?.swords.find((sword) => sword.isOwnSword);
    expect(playerOneOwn).toBeDefined();
    expect(playerOneOwn?.ownerId).not.toBeNull();

    const playerOneOwnerId = playerOneOwn?.ownerId ?? null;
    expect(playerOneOwnerId).not.toBeNull();

    const initialRemote = frameTwo?.swords.find(
      (sword) => !sword.isOwnSword && sword.ownerId === playerOneOwnerId,
    );

    expect(initialRemote).toBeDefined();
    expect(frameTwo?.tick).not.toBeNull();

    if (!initialRemote || playerOneOwnerId === null || frameTwo === null || frameTwo.tick === null) {
      throw new Error('Expected initial remote sword and tick on Player Two');
    }

    const initialPos = {
      x: initialRemote.x,
      y: initialRemote.y,
    };
    const initialTick = frameTwo.tick;

    // Scenario B — Player One moves forward with real keyboard input and Player Two renders the movement.
    await pageOne.bringToFront();
    await pageOne.locator('#game').click();

    await pageOne.keyboard.down('w');
    const movementStartedAt = performance.now();

    try {
      let firstVisibleMovementLatencyMs: number | null = null;

      await expect
        .poll(
          async () => {
            const distance = await measureRemoteDisplacement(
              pageTwo,
              playerOneOwnerId,
              initialPos,
              initialTick,
            );

            if (distance >= 3 && firstVisibleMovementLatencyMs === null) {
              firstVisibleMovementLatencyMs = performance.now() - movementStartedAt;
            }

            return distance;
          },
          {
            timeout: 500,
            intervals: [16, 25, 33, 50],
          },
        )
        .toBeGreaterThanOrEqual(3);

      expect(firstVisibleMovementLatencyMs).not.toBeNull();
      expect(firstVisibleMovementLatencyMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(500);

      await expect
        .poll(
          () =>
            measureRemoteDisplacement(
              pageTwo,
              playerOneOwnerId,
              initialPos,
              initialTick,
            ),
          {
            intervals: [25, 50],
          },
        )
        .toBeGreaterThanOrEqual(20);
    } finally {
      await pageOne.keyboard.up('w');
    }

    const afterMoveFrame = await readRenderProbe(pageTwo);
    expect(afterMoveFrame?.tick).not.toBeNull();
    expect(afterMoveFrame?.tick ?? 0).toBeGreaterThan(initialTick);

    // Scenario C — Bidirectional chat delivery through real WebSocket broadcast.
    await pageOne
      .getByPlaceholder('Type a message...')
      .fill('Hello from Player One');

    await pageOne
      .locator('.magic-chat-form')
      .getByRole('button', { name: 'Send' })
      .click();

    await expect(
      pageTwo
        .locator('.magic-chat-messages')
        .getByText('Player One: Hello from Player One', { exact: true }),
    ).toBeVisible();

    await pageTwo
      .getByPlaceholder('Type a message...')
      .fill('Hello back from Player Two');

    await pageTwo
      .locator('.magic-chat-form')
      .getByRole('button', { name: 'Send' })
      .click();

    await expect(
      pageOne
        .locator('.magic-chat-messages')
        .getByText('Player Two: Hello back from Player Two', { exact: true }),
    ).toBeVisible();

    // Scenario D — No uncaught browser JS errors occurred.
    expect(pageOneErrors).toEqual([]);
    expect(pageTwoErrors).toEqual([]);
  } finally {
    await contextOne.close();
    await contextTwo.close();
  }
});

