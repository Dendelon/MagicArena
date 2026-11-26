import { expect, test } from '@playwright/test';
import { z } from 'zod';

import { createE2ERoom, joinGame } from './helpers.ts';

const ManifestIconSchema = z.object({
  src: z.string(),
  sizes: z.string(),
  type: z.string(),
  purpose: z.string().optional(),
});

const WebManifestSchema = z.object({
  name: z.string().min(1),
  short_name: z.string().min(1),
  start_url: z.string().min(1),
  scope: z.string().optional(),
  display: z.enum(['standalone', 'fullscreen', 'minimal-ui', 'browser']),
  background_color: z.string().min(1),
  theme_color: z.string().min(1),
  icons: z.array(ManifestIconSchema).min(2),
});

test('Serves valid PWA manifest, PNG icons, active Service Worker, and keeps multiplayer functional', async ({
  page,
  request,
}) => {
  const manifestRes = await request.get('/manifest.webmanifest');
  expect(manifestRes.status()).toBe(200);
  expect(manifestRes.headers()['content-type']).toContain(
    'application/manifest+json',
  );
  expect(manifestRes.headers()['cache-control']).toBe('no-cache');

  const manifestJson: unknown = await manifestRes.json();
  const manifest = WebManifestSchema.parse(manifestJson);
  expect(manifest.start_url).toBe('/');
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.some((icon) => icon.sizes === '192x192')).toBe(true);
  expect(manifest.icons.some((icon) => icon.sizes === '512x512')).toBe(true);

  for (const icon of manifest.icons) {
    const iconRes = await request.get(icon.src);
    expect(iconRes.status()).toBe(200);
    expect(iconRes.headers()['content-type']).toBe('image/png');
    const bytes = await iconRes.body();
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  }

  const swRes = await request.get('/sw.js');
  expect(swRes.status()).toBe(200);
  expect(swRes.headers()['content-type']).toContain('text/javascript');
  expect(swRes.headers()['cache-control']).toBe('no-cache');

  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => {
    pageErrors.push(error);
  });

  await page.goto('/');

  const manifestHref = await page
    .locator('link[rel="manifest"]')
    .getAttribute('href');
  expect(manifestHref).toBe('/manifest.webmanifest');

  const swStatus = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return {
      activeState: registration.active?.state ?? null,
      scope: registration.scope,
    };
  });
  expect(swStatus.activeState).toBe('activated');
  expect(swStatus.scope.endsWith('/')).toBe(true);

  const room = await createE2ERoom(request);
  await joinGame(page, 'PWA Pilot', room.id);

  const healthOk = await page.evaluate(async () => {
    const res = await fetch('/health');
    const data: unknown = await res.json();
    return (
      res.ok &&
      typeof data === 'object' &&
      data !== null &&
      'status' in data &&
      data.status === 'ok'
    );
  });
  expect(healthOk).toBe(true);
  expect(pageErrors).toEqual([]);
});

