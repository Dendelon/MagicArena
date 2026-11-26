import { expect } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { z } from 'zod';

import { RoomInfoSchema } from '@magicarena/shared/protocol';
import type { RoomInfo } from '@magicarena/shared';

const RenderedSwordSchema = z.object({
  entityId: z.union([z.number(), z.string()]),
  ownerId: z.string().nullable(),
  isOwnSword: z.boolean(),
  x: z.number(),
  y: z.number(),
  angle: z.number(),
});

const RenderProbeSchema = z.object({
  tick: z.number().nullable(),
  width: z.number(),
  height: z.number(),
  swords: z.array(RenderedSwordSchema),
});

export type E2ERenderProbe = z.infer<typeof RenderProbeSchema>;

export const createE2ERoom = async (
  request: APIRequestContext,
): Promise<RoomInfo> => {
  const response = await request.post('/api/rooms', {
    data: {
      name: 'E2E Arena',
      obstacleCount: 0,
    },
  });

  expect(response.status()).toBe(201);

  const raw: unknown = await response.json();

  return RoomInfoSchema.parse(raw);
};

export const readRenderProbe = async (
  page: Page,
): Promise<E2ERenderProbe | null> => {
  const attribute = await page
    .locator('#game')
    .getAttribute('data-e2e-swords');

  if (!attribute) {
    return null;
  }

  const raw: unknown = JSON.parse(attribute);

  return RenderProbeSchema.parse(raw);
};

export const joinGame = async (
  page: Page,
  playerName: string,
  roomId: string,
): Promise<void> => {
  await page.goto('/');

  const lobby = page.locator('.magic-lobby');

  await expect(lobby).toBeVisible();

  await lobby.getByLabel('Player name').fill(playerName);

  const roomSelect = lobby.locator('select');

  await expect(roomSelect).toBeVisible();
  await expect(roomSelect).toBeEnabled();

  await expect(roomSelect.locator(`option[value="${roomId}"]`)).toHaveCount(1);

  await roomSelect.selectOption(roomId);

  await lobby.getByRole('button', { name: 'Join' }).click();

  await expect(lobby).toHaveCount(0);

  await expect(page.locator('.magic-chat-status')).toHaveText('Connected');

  await expect(page.locator('#game')).toBeVisible();

  await expect(page.locator('.magic-chat-roster')).toContainText(playerName);

  await expect
    .poll(async () => {
      const frame = await readRenderProbe(page);

      if (!frame || frame.tick === null || frame.width <= 0) {
        return false;
      }

      return frame.swords.some((sword) => sword.isOwnSword);
    })
    .toBe(true);
};

