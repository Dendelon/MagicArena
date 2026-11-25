import { z } from 'zod';

export interface Vec2Like {
  readonly x: number;
  readonly y: number;
}

export interface Bounds {
  readonly width: number;
  readonly height: number;
}

export type RandomSource = () => number;

export const EntityIdSchema = z
  .union([z.number(), z.string()])
  .brand<'EntityId'>();

export const TickSchema = z
  .number()
  .int()
  .min(0)
  .max(0xffffffff)
  .brand<'Tick'>();

export const SeqSchema = z
  .number()
  .int()
  .min(0)
  .max(0xffffffff)
  .brand<'Seq'>();

export type EntityId = z.infer<typeof EntityIdSchema>;

export type Tick = z.infer<typeof TickSchema>;

export type Seq = z.infer<typeof SeqSchema>;

export type PlayerId = string;

