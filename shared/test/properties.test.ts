import { describe, expect, test } from 'vitest';
import fc from 'fast-check';

import {
  BinaryDecodeError,
  InputMessageSchema,
  SnapshotMessageSchema,
  binaryCodec,
  createInputMessage,
  createSnapshotMessage,
  decodeInput,
  decodeMessage,
  decodeSnapshot,
  encodeInput,
  encodeMessage,
  encodeSnapshot,
  parseClientMessage,
  toEntityId,
  toSeq,
} from '../src/index.ts';

import { integrate } from '../src/sim/sword.ts';

import type {
  BulletSnapshot,
  EntitySnapshot,
  ExplosionSnapshot,
  GameEntityKind,
  ObstacleSnapshot,
  PickupSnapshot,
  SnapshotMessage,
  SwordSnapshot,
} from '../src/index.ts';

const PROPERTY_OPTIONS = {
  numRuns: 300,
  seed: 1337,
};

const uint32 = fc.integer({
  min: 0,
  max: 0xffffffff,
});

const finiteNumber = (min: number, max: number) =>
  fc
    .double({
      min,
      max,
      noNaN: true,
      noDefaultInfinity: true,
    })
    .map((value) => (Object.is(value, -0) ? 0 : value));

const entityKindArb: fc.Arbitrary<GameEntityKind> = fc.constantFrom(
  'sword',
  'bullet',
  'obstacle',
  'pickup',
  'explosion',
);

const entityIdArb = fc.oneof(
  uint32.map((n) => toEntityId(n)),
  fc.string({ minLength: 1, maxLength: 24 }).map((s) => toEntityId(s)),
);

const playerIdArb = fc.string({ minLength: 1, maxLength: 24 });

const vec2Arb = fc.record({
  x: finiteNumber(-2000, 2000),
  y: finiteNumber(-2000, 2000),
});

const homingArb = fc.option(
  fc.record({
    targetKind: entityKindArb,
    turnRate: finiteNumber(0, 20),
    speed: fc.option(finiteNumber(0, 1000), { nil: null }),
  }),
  { nil: null },
);

const baseEntityFieldsArb = fc.record({
  id: entityIdArb,
  pos: vec2Arb,
  vel: vec2Arb,
  angle: finiteNumber(-Math.PI, Math.PI),
  radius: finiteNumber(0, 100),
  alive: fc.boolean(),
});

const swordSnapshotArb: fc.Arbitrary<SwordSnapshot> = fc
  .tuple(
    baseEntityFieldsArb,
    fc.record({
      kind: fc.constant('sword' as const),
      ownerId: fc.option(playerIdArb, { nil: null }),
      hp: finiteNumber(0, 10),
      damageCooldown: finiteNumber(0, 5),
      thrust: fc.boolean(),
    }),
  )
  .map(([base, extra]) => ({ ...base, ...extra }));

const bulletSnapshotArb: fc.Arbitrary<BulletSnapshot> = fc
  .tuple(
    baseEntityFieldsArb,
    fc.record({
      kind: fc.constant('bullet' as const),
      ttl: finiteNumber(0, 10),
      ownerId: fc.option(entityIdArb, { nil: null }),
      ownerPlayerId: fc.option(playerIdArb, { nil: null }),
      originSeq: fc.option(uint32.map(toSeq), { nil: null }),
      damage: finiteNumber(0, 10),
      homing: homingArb,
    }),
  )
  .map(([base, extra]) => ({ ...base, ...extra }));

const obstacleSnapshotArb: fc.Arbitrary<ObstacleSnapshot> = fc
  .tuple(
    baseEntityFieldsArb,
    fc.record({
      kind: fc.constant('obstacle' as const),
      hp: finiteNumber(0, 20),
      homing: homingArb,
    }),
  )
  .map(([base, extra]) => ({ ...base, ...extra }));

const pickupSnapshotArb: fc.Arbitrary<PickupSnapshot> = fc
  .tuple(
    baseEntityFieldsArb,
    fc.record({
      kind: fc.constant('pickup' as const),
      effect: fc.option(
        fc.record({
          kind: fc.constant('healing' as const),
          amount: finiteNumber(0, 10),
        }),
        { nil: null },
      ),
    }),
  )
  .map(([base, extra]) => ({ ...base, ...extra }));

const explosionSnapshotArb: fc.Arbitrary<ExplosionSnapshot> = fc
  .tuple(
    baseEntityFieldsArb,
    fc.record({
      kind: fc.constant('explosion' as const),
      color: fc.string({ minLength: 1, maxLength: 16 }),
      particles: fc.array(
        fc.record({
          pos: vec2Arb,
          vel: vec2Arb,
          lifetime: finiteNumber(0.01, 5),
          remaining: finiteNumber(0, 5),
          radius: finiteNumber(0.1, 20),
        }),
        { maxLength: 4 },
      ),
    }),
  )
  .map(([base, extra]) => ({ ...base, ...extra }));

const entitySnapshotArb: fc.Arbitrary<EntitySnapshot> = fc.oneof(
  swordSnapshotArb,
  bulletSnapshotArb,
  obstacleSnapshotArb,
  pickupSnapshotArb,
  explosionSnapshotArb,
);

const worldEventArb: fc.Arbitrary<
  NonNullable<SnapshotMessage['events']>[number]
> = fc.oneof(
  fc.record({
    type: fc.constant('fired' as const),
    detail: fc.record({
      entityId: entityIdArb,
      ownerId: fc.option(entityIdArb, { nil: null }),
      ownerPlayerId: fc.option(playerIdArb, { nil: null }),
      originSeq: fc.option(uint32.map(toSeq), { nil: null }),
      pos: vec2Arb,
    }),
  }),
  fc.record({
    type: fc.constant('hit' as const),
    detail: fc.record({
      kind: entityKindArb,
      pos: vec2Arb,
    }),
  }),
  fc.record({
    type: fc.constant('exploded' as const),
    detail: fc.record({
      kind: entityKindArb,
      pos: vec2Arb,
    }),
  }),
  fc.record({
    type: fc.constant('healed' as const),
    detail: fc.record({
      hp: finiteNumber(0, 10),
    }),
  }),
  fc.record({
    type: fc.constant('scoreChanged' as const),
    detail: fc.record({
      score: finiteNumber(-10000, 10000),
    }),
  }),
);

const inputArbitrary = fc
  .record({
    seq: uint32,
    tick: uint32,

    turn: finiteNumber(-1, 1),

    thrust: fc.boolean(),
    brake: fc.boolean(),
    fire: fc.boolean(),
    homingFire: fc.boolean(),

    fireSeq: fc.option(uint32, {
      nil: undefined,
    }),
  })
  .map((input) => createInputMessage(input));

const snapshotArbitrary = fc
  .record({
    tick: uint32,
    lastProcessedSeq: uint32,
    entities: fc.array(entitySnapshotArb, { maxLength: 6 }),
    score: fc.option(finiteNumber(-10000, 10000), { nil: undefined }),
    bounds: fc.option(
      fc.record({
        width: finiteNumber(0, 4000),
        height: finiteNumber(0, 4000),
      }),
      { nil: undefined },
    ),
    events: fc.option(fc.array(worldEventArb, { maxLength: 3 }), {
      nil: undefined,
    }),
    respawnSeconds: fc.option(
      fc.option(finiteNumber(0, 30), { nil: null }),
      { nil: undefined },
    ),
  })
  .map((snapshot) => createSnapshotMessage(snapshot));

const angleDistance = (a: number, b: number): number =>
  Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

const expectF32Equal = (actual: number, expected: number): void => {
  expect(actual).toBe(Math.fround(expected));
};

const expectVecF32Equal = (
  actual: { readonly x: number; readonly y: number },
  expected: { readonly x: number; readonly y: number },
): void => {
  expectF32Equal(actual.x, expected.x);
  expectF32Equal(actual.y, expected.y);
};

describe('Property-based tests', () => {
  test('Binary input round-trip preserves generated messages', () => {
    fc.assert(
      fc.property(inputArbitrary, (input) => {
        const decoded = decodeInput(encodeInput(input));

        expect(decoded).toEqual(input);
      }),
      PROPERTY_OPTIONS,
    );
  });

  test('Binary input packet matches documented size', () => {
    fc.assert(
      fc.property(inputArbitrary, (input) => {
        const packet = encodeInput(input);

        const expectedSize = input.fireSeq === undefined ? 19 : 23;

        expect(packet.byteLength).toBe(expectedSize);
      }),
      PROPERTY_OPTIONS,
    );
  });

  test('Truncated input packets are rejected', () => {
    fc.assert(
      fc.property(inputArbitrary, fc.nat(), (input, offset) => {
        const packet = encodeInput(input);

        const length = offset % packet.byteLength;
        const truncated = packet.slice(0, length);

        expect(() => decodeInput(truncated)).toThrow();
      }),
      PROPERTY_OPTIONS,
    );
  });

  test('Corrupted protocol version byte in binary input is rejected', () => {
    fc.assert(
      fc.property(
        inputArbitrary,
        fc.integer({ min: 0, max: 255 }).filter((v) => v !== 1),
        (input, badVersion) => {
          const packet = encodeInput(input);
          packet[1] = badVersion;

          expect(() => decodeInput(packet)).toThrow();
        },
      ),
      PROPERTY_OPTIONS,
    );
  });

  test('Integrated sword remains inside arena', () => {
    fc.assert(
      fc.property(
        fc.record({
          x: finiteNumber(0, 959),
          y: finiteNumber(0, 639),
          vx: finiteNumber(-320, 320),
          vy: finiteNumber(-320, 320),
          angle: finiteNumber(-Math.PI, Math.PI),
        }),
        inputArbitrary,
        (state, input) => {
          const bounds = {
            width: 960,
            height: 640,
          };

          const next = integrate(state, input, 1 / 30, bounds);

          expect(Number.isFinite(next.x)).toBe(true);
          expect(Number.isFinite(next.y)).toBe(true);

          expect(next.x).toBeGreaterThanOrEqual(0);
          expect(next.x).toBeLessThan(bounds.width);

          expect(next.y).toBeGreaterThanOrEqual(0);
          expect(next.y).toBeLessThan(bounds.height);

          expect(Math.hypot(next.vx, next.vy)).toBeLessThanOrEqual(320 + 1e-8);
        },
      ),
      PROPERTY_OPTIONS,
    );
  });

  test('Integrated sword remains finite, bounded, and within max speed over 1000 input steps', () => {
    fc.assert(
      fc.property(
        fc.record({
          x: finiteNumber(0, 959),
          y: finiteNumber(0, 639),
          vx: finiteNumber(-320, 320),
          vy: finiteNumber(-320, 320),
          angle: finiteNumber(-Math.PI, Math.PI),
        }),
        fc.array(inputArbitrary, { minLength: 1000, maxLength: 1000 }),
        (initialState, inputs) => {
          const bounds = {
            width: 960,
            height: 640,
          };
          const dt = 1 / 30;
          let current = initialState;

          for (const input of inputs) {
            const next = integrate(current, input, dt, bounds);

            expect(Number.isFinite(next.x)).toBe(true);
            expect(Number.isFinite(next.y)).toBe(true);
            expect(Number.isFinite(next.vx)).toBe(true);
            expect(Number.isFinite(next.vy)).toBe(true);

            expect(next.x).toBeGreaterThanOrEqual(0);
            expect(next.x).toBeLessThan(bounds.width);
            expect(next.y).toBeGreaterThanOrEqual(0);
            expect(next.y).toBeLessThan(bounds.height);

            expect(Math.hypot(next.vx, next.vy)).toBeLessThanOrEqual(320 + 1e-8);
            current = next;
          }
        },
      ),
      {
        numRuns: 25,
        seed: 1337,
      },
    );
  });

  test('Valid inputs are accepted and corrupted inputs rejected', () => {
    fc.assert(
      fc.property(inputArbitrary, (input) => {
        expect(parseClientMessage(input).success).toBe(true);

        expect(
          parseClientMessage({
            ...input,
            seq: String(input.seq),
          }).success,
        ).toBe(false);

        expect(
          parseClientMessage({
            ...input,
            v: 255,
          }).success,
        ).toBe(false);

        expect(
          parseClientMessage({
            ...input,
            turn: 2,
          }).success,
        ).toBe(false);
      }),
      PROPERTY_OPTIONS,
    );
  });

  test('Binary snapshot round-trip preserves all entity kinds within format precision', () => {
    fc.assert(
      fc.property(snapshotArbitrary, (snapshot) => {
        const decoded = decodeSnapshot(encodeSnapshot(snapshot));

        expect(decoded.v).toBe(snapshot.v);
        expect(decoded.type).toBe(snapshot.type);
        expect(decoded.tick).toBe(snapshot.tick);
        expect(decoded.lastProcessedSeq).toBe(snapshot.lastProcessedSeq);
        expect(decoded.score).toBe(snapshot.score);

        if (snapshot.bounds === undefined) {
          expect(decoded.bounds).toBeUndefined();
        } else {
          expect(decoded.bounds).toBeDefined();
          if (decoded.bounds) {
            expectF32Equal(decoded.bounds.width, snapshot.bounds.width);
            expectF32Equal(decoded.bounds.height, snapshot.bounds.height);
          }
        }

        if (snapshot.respawnSeconds === undefined) {
          expect(decoded.respawnSeconds).toBeUndefined();
        } else if (snapshot.respawnSeconds === null) {
          expect(decoded.respawnSeconds).toBeNull();
        } else {
          expect(typeof decoded.respawnSeconds).toBe('number');
          if (typeof decoded.respawnSeconds === 'number') {
            expectF32Equal(decoded.respawnSeconds, snapshot.respawnSeconds);
          }
        }

        expect(decoded.entities.length).toBe(snapshot.entities.length);

        snapshot.entities.forEach((orig, index) => {
          const dec = decoded.entities[index];
          expect(dec).toBeDefined();
          if (!dec) return;

          expect(dec.kind).toBe(orig.kind);
          expect(dec.id).toBe(orig.id);
          expect(dec.alive).toBe(orig.alive);
          expectVecF32Equal(dec.pos, orig.pos);
          expectVecF32Equal(dec.vel, orig.vel);
          expectF32Equal(dec.radius, orig.radius);
          expect(angleDistance(orig.angle, dec.angle)).toBeLessThanOrEqual(
            0.000501,
          );

          if (orig.kind === 'sword' && dec.kind === 'sword') {
            expect(dec.ownerId).toBe(orig.ownerId);
            expectF32Equal(dec.hp, orig.hp);
            expectF32Equal(dec.damageCooldown, orig.damageCooldown);
            expect(dec.thrust).toBe(orig.thrust);
          } else if (orig.kind === 'bullet' && dec.kind === 'bullet') {
            expectF32Equal(dec.ttl, orig.ttl);
            expect(dec.ownerId).toBe(orig.ownerId);
            expect(dec.ownerPlayerId).toBe(orig.ownerPlayerId);
            expect(dec.originSeq).toBe(orig.originSeq);
            expectF32Equal(dec.damage, orig.damage);
            if (orig.homing === null) {
              expect(dec.homing).toBeNull();
            } else {
              expect(dec.homing).not.toBeNull();
              if (dec.homing) {
                expect(dec.homing.targetKind).toBe(orig.homing.targetKind);
                expectF32Equal(dec.homing.turnRate, orig.homing.turnRate);
                if (orig.homing.speed === null) {
                  expect(dec.homing.speed).toBeNull();
                } else if (dec.homing.speed !== null) {
                  expectF32Equal(dec.homing.speed, orig.homing.speed);
                }
              }
            }
          } else if (orig.kind === 'obstacle' && dec.kind === 'obstacle') {
            expectF32Equal(dec.hp, orig.hp);
            if (orig.homing === null) {
              expect(dec.homing).toBeNull();
            } else if (dec.homing) {
              expect(dec.homing.targetKind).toBe(orig.homing.targetKind);
              expectF32Equal(dec.homing.turnRate, orig.homing.turnRate);
            }
          } else if (orig.kind === 'pickup' && dec.kind === 'pickup') {
            if (orig.effect === null) {
              expect(dec.effect).toBeNull();
            } else if (dec.effect) {
              expect(dec.effect.kind).toBe(orig.effect.kind);
              expectF32Equal(dec.effect.amount, orig.effect.amount);
            }
          } else if (orig.kind === 'explosion' && dec.kind === 'explosion') {
            expect(dec.color).toBe(orig.color);
            expect(dec.particles.length).toBe(orig.particles.length);
            orig.particles.forEach((p, pIdx) => {
              const dp = dec.particles[pIdx];
              expect(dp).toBeDefined();
              if (!dp) return;
              expectVecF32Equal(dp.pos, p.pos);
              expectVecF32Equal(dp.vel, p.vel);
              expectF32Equal(dp.lifetime, p.lifetime);
              expectF32Equal(dp.remaining, p.remaining);
              expectF32Equal(dp.radius, p.radius);
            });
          }
        });
      }),
      PROPERTY_OPTIONS,
    );
  });

  test('JSON codec round-trip preserves input and snapshot messages without precision loss', () => {
    fc.assert(
      fc.property(inputArbitrary, snapshotArbitrary, (input, snapshot) => {
        expect(decodeMessage(encodeMessage(input))).toEqual(input);
        expect(decodeMessage(encodeMessage(snapshot))).toEqual(snapshot);
      }),
      PROPERTY_OPTIONS,
    );
  });

  test('Binary decoders reject arbitrary garbage buffers with BinaryDecodeError unless valid', () => {
    const assertDecodesOrBinaryDecodeError = (
      buffer: Uint8Array,
      decodeFn: (data: Uint8Array) => unknown,
      validateDecoded: (decoded: unknown) => boolean,
    ): void => {
      try {
        const decoded = decodeFn(buffer);
        expect(validateDecoded(decoded)).toBe(true);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(BinaryDecodeError);
      }
    };

    const withValidHeader = (typeByte: number, payload: Uint8Array): Uint8Array => {
      const framed = new Uint8Array(2 + payload.byteLength);
      framed[0] = typeByte;
      framed[1] = 1;
      framed.set(payload, 2);
      return framed;
    };

    const isValidGameMessage = (v: unknown): boolean =>
      InputMessageSchema.safeParse(v).success ||
      SnapshotMessageSchema.safeParse(v).success;

    // Explicit empty buffer check across all public binary decode boundaries
    for (const [decodeFn, validate] of [
      [(data: Uint8Array) => decodeInput(data), (v: unknown) => InputMessageSchema.safeParse(v).success],
      [(data: Uint8Array) => decodeSnapshot(data), (v: unknown) => SnapshotMessageSchema.safeParse(v).success],
      [(data: Uint8Array) => binaryCodec.decode(data), isValidGameMessage],
    ] as const) {
      assertDecodesOrBinaryDecodeError(new Uint8Array(0), decodeFn, validate);
    }

    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 0, maxLength: 512 }),
        (bytes) => {
          assertDecodesOrBinaryDecodeError(
            bytes,
            (data) => decodeInput(data),
            (v) => InputMessageSchema.safeParse(v).success,
          );
          assertDecodesOrBinaryDecodeError(
            bytes,
            (data) => decodeSnapshot(data),
            (v) => SnapshotMessageSchema.safeParse(v).success,
          );
          assertDecodesOrBinaryDecodeError(
            bytes,
            (data) => binaryCodec.decode(data),
            isValidGameMessage,
          );

          // Valid message header + arbitrary payload bytes (corrupted/non-empty payloads)
          assertDecodesOrBinaryDecodeError(
            withValidHeader(1, bytes),
            (data) => decodeInput(data),
            (v) => InputMessageSchema.safeParse(v).success,
          );
          assertDecodesOrBinaryDecodeError(
            withValidHeader(2, bytes),
            (data) => decodeSnapshot(data),
            (v) => SnapshotMessageSchema.safeParse(v).success,
          );
        },
      ),
      PROPERTY_OPTIONS,
    );

    fc.assert(
      fc.property(
        inputArbitrary,
        snapshotArbitrary,
        fc.nat(),
        fc.integer({ min: 0, max: 255 }),
        (input, snapshot, selector, byteValue) => {
          for (const [packet, decodeFn, validate] of [
            [
              encodeInput(input),
              (data: Uint8Array) => decodeInput(data),
              (v: unknown) => InputMessageSchema.safeParse(v).success,
            ],
            [
              encodeSnapshot(snapshot),
              (data: Uint8Array) => decodeSnapshot(data),
              (v: unknown) => SnapshotMessageSchema.safeParse(v).success,
            ],
            [
              encodeSnapshot(snapshot),
              (data: Uint8Array) => binaryCodec.decode(data),
              isValidGameMessage,
            ],
          ] as const) {
            const cutLength = selector % packet.byteLength;
            assertDecodesOrBinaryDecodeError(packet.slice(0, cutLength), decodeFn, validate);

            const mutated = packet.slice();
            const index = selector % mutated.byteLength;
            mutated[index] = ((mutated[index] ?? 0) ^ (byteValue === 0 ? 1 : byteValue)) & 0xff;
            assertDecodesOrBinaryDecodeError(mutated, decodeFn, validate);
          }
        },
      ),
      PROPERTY_OPTIONS,
    );
  });
});

