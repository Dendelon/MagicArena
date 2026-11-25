import { z } from 'zod';

const AssetEntrySchema = z.object({
  id: z.string().min(1),
  url: z.string().min(1),
});

export const AssetManifestSchema = z.object({
  sprites: z.array(AssetEntrySchema).optional(),
  audio: z.array(AssetEntrySchema).optional(),
  arena: AssetEntrySchema.optional(),
});

export type AssetManifest = z.infer<typeof AssetManifestSchema>;

export type AssetEntry = z.infer<typeof AssetEntrySchema>;

