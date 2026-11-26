import { expect, test } from '@playwright/test';

import { createE2ERoom, joinGame, readRenderProbe } from './helpers.ts';

const wrappedDistance = (a: number, b: number, size: number): number => {
  const distance = Math.abs(a - b) % size;
  return Math.min(distance, size - distance);
};

test('Web Worker decodes binary snapshots via Transferable ArrayBuffers and cleans up on disconnect', async ({
  browser,
  request,
}) => {
  const room = await createE2ERoom(request);

  const contextOne = await browser.newContext();
  const contextTwo = await browser.newContext();

  try {
    const pageOne = await contextOne.newPage();
    const pageTwo = await browser.newPage();

    await pageOne.addInitScript(() => {
      let count = 0;

      Object.defineProperty(window, '__workerTerminateCount', {
        get: () => count,
      });

      const BaseWorker = window.Worker;

      class TrackedWorker extends BaseWorker {
        override terminate(): void {
          count += 1;
          super.terminate();
        }
      }

      window.Worker = TrackedWorker;
    });

    const pageOneErrors: Error[] = [];
    const pageTwoErrors: Error[] = [];
    pageOne.on('pageerror', (err) => pageOneErrors.push(err));
    pageTwo.on('pageerror', (err) => pageTwoErrors.push(err));

    await joinGame(pageOne, 'Worker One', room.id, '/?decode=worker');
    await joinGame(pageTwo, 'Worker Two', room.id, '/?decode=worker');

    // Verify Worker started, ArrayBuffers transferred & detached (byteLength === 0).
    await expect
      .poll(async () => {
        return pageOne.evaluate(() => {
          const status = window.magicArenaProfile?.getDecodeStatus?.();
          if (!status || !status.worker) return null;

          return {
            requestedMode: status.requestedMode,
            actualMode: status.actualMode,
            fallbackOccurred: status.fallbackOccurred,
            ready: status.worker.ready,
            transferredBuffers: status.worker.transferredBuffers,
            detachedBuffers: status.worker.detachedBuffers,
          };
        });
      })
      .toMatchObject({
        requestedMode: 'worker',
        actualMode: 'worker',
        fallbackOccurred: false,
        ready: true,
      });

    const transferStats = await pageOne.evaluate(() =>
      window.magicArenaProfile?.getDecodeStatus?.(),
    );
    expect(transferStats?.worker?.transferredBuffers ?? 0).toBeGreaterThan(0);
    expect(transferStats?.worker?.detachedBuffers).toBe(
      transferStats?.worker?.transferredBuffers,
    );

    // Wait for both swords to appear and verify real movement across clients.
    await expect
      .poll(async () => {
        const frameTwo = await readRenderProbe(pageTwo);
        return frameTwo?.swords.length ?? 0;
      })
      .toBe(2);

    const frameOne = await readRenderProbe(pageOne);
    const frameTwo = await readRenderProbe(pageTwo);
    const p1Sword = frameOne?.swords.find((s) => s.isOwnSword);
    const p1OwnerId = p1Sword?.ownerId ?? null;
    const remoteBefore = frameTwo?.swords.find(
      (s) => !s.isOwnSword && s.ownerId === p1OwnerId,
    );

    if (!p1OwnerId || !remoteBefore || !frameTwo || frameTwo.tick === null) {
      throw new Error('Expected remote sword and tick for Worker One');
    }

    const initialPos = { x: remoteBefore.x, y: remoteBefore.y };
    const initialTick = frameTwo.tick;

    await pageOne.bringToFront();
    await pageOne.locator('#game').click();
    await pageOne.keyboard.down('w');

    try {
      await expect
        .poll(async () => {
          const frame = await readRenderProbe(pageTwo);
          if (!frame || frame.tick === null || frame.tick <= initialTick) {
            return 0;
          }
          const remote = frame.swords.find(
            (s) => !s.isOwnSword && s.ownerId === p1OwnerId,
          );
          if (!remote) return 0;

          return Math.hypot(
            wrappedDistance(remote.x, initialPos.x, frame.width),
            wrappedDistance(remote.y, initialPos.y, frame.height),
          );
        })
        .toBeGreaterThanOrEqual(20);
    } finally {
      await pageOne.keyboard.up('w');
    }

    // Verify bidirectional chat while decoding via Worker.
    await pageOne.getByPlaceholder('Type a message...').fill('Worker ping');
    await pageOne.locator('.magic-chat-form').getByRole('button', { name: 'Send' }).click();

    await expect(
      pageTwo
        .locator('.magic-chat-messages')
        .getByText('Worker One: Worker ping', { exact: true }),
    ).toBeVisible();

    // Trigger disconnect / unload lifecycle and verify Worker is terminated cleanly.
    await pageOne.evaluate(() => {
      window.dispatchEvent(new Event('beforeunload'));
    });

    const cleanupStatus = await pageOne.evaluate(() => ({
      terminated:
        window.magicArenaProfile?.getDecodeStatus?.()?.worker?.terminated ??
        false,
      terminateCount: Number(Reflect.get(window, '__workerTerminateCount')),
    }));

    expect(cleanupStatus.terminated).toBe(true);
    expect(cleanupStatus.terminateCount).toBeGreaterThanOrEqual(1);
    expect(pageOneErrors).toEqual([]);
    expect(pageTwoErrors).toEqual([]);
  } finally {
    await contextOne.close();
    await contextTwo.close();
  }
});
