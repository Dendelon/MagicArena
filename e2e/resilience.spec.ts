import { expect, test, type WebSocketRoute } from '@playwright/test';
import { PROTOCOL_VERSION } from '@magicarena/shared';

import { createE2ERoom, joinGame, readRenderProbe } from './helpers.ts';

test('Browser client reconnects after unexpected disconnect and stops cleanly on server shutdown', async ({
  page,
  request,
}) => {
  const room = await createE2ERoom(request);
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => {
    pageErrors.push(error);
  });

  let wsConnectionCount = 0;
  let activeRoute: WebSocketRoute | null = null;
  const requireActiveRoute = (): WebSocketRoute => {
    if (activeRoute === null) {
      throw new Error('Expected active Playwright WebSocketRoute');
    }
    return activeRoute;
  };

  await page.routeWebSocket('**/ws', (ws) => {
    wsConnectionCount += 1;
    activeRoute = ws;
    ws.connectToServer();
  });

  await joinGame(page, 'Resilient One', room.id);
  expect(wsConnectionCount).toBe(1);

  const beforeDrop = await readRenderProbe(page);
  expect(beforeDrop?.tick).not.toBeNull();

  // Scenario 1 — Unexpected WS drop triggers automatic reconnect and resumes snapshots.
  await requireActiveRoute().close({
    code: 1011,
    reason: 'Chaos transient failure',
  });

  await expect.poll(() => wsConnectionCount, { timeout: 5_000 }).toBe(2);
  await expect(page.locator('.magic-chat-status')).toHaveText('Connected');

  await expect
    .poll(async () => {
      const probe = await readRenderProbe(page);
      return probe?.swords.some((sword) => sword.isOwnSword) ?? false;
    })
    .toBe(true);

  // Scenario 2 — Intentional server shutdown stops session and prevents reconnect loops.
  const secondRoute = requireActiveRoute();
  secondRoute.send(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'shutdown',
      reason: 'Server is shutting down',
    }),
  );
  await secondRoute.close({
    code: 1001,
    reason: 'Server shutting down',
  });

  await expect(page.locator('.magic-chat-status')).toHaveText(
    'Server is shutting down',
  );
  await expect(page.locator('.magic-chat-messages')).toContainText(
    'Server is shutting down',
  );
  await expect(
    page.locator('.magic-chat-form input'),
  ).toBeDisabled();

  // Observe past the 1000ms initial backoff window to verify no reconnect attempt fires.
  await page.waitForTimeout(1200);
  expect(wsConnectionCount).toBe(2);

  expect(pageErrors).toEqual([]);
});
