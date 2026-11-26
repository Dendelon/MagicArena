import type WebSocket from 'ws';

import type {
  EntityId,
  Seq,
  PlayerId,
  InputMessage,
  FireAckMessage,
} from '@magicarena/shared';

export interface Player {
  readonly id: PlayerId;
  readonly name: string;
  readonly socket: WebSocket;
}

export interface RoomOptions {
  id?: string;
  name: string;
  obstacleCount?: number;
  maxPlayers?: number;
  persistent?: boolean;
}

export interface ContinuousInput {
  thrust: boolean;
  turn: number;
  brake: boolean;
}

export interface QueuedInput extends ContinuousInput {
  seq: Seq;
  fireSeq: Seq | null;
  fire: boolean;
  homingFire: boolean;
}

export type FireAck = Omit<FireAckMessage, 'v' | 'type'>;

export interface MatchPlayerState {
  playerId: PlayerId;
  entityId: EntityId;

  lastReceivedSeq: Seq | -1;
  lastProcessedSeq: Seq;

  inputQueue: QueuedInput[];
  handledShotSeqs: Set<Seq>;
  pendingFireAcks: FireAck[];

  lastContinuousInput: ContinuousInput;
  lastKnownThrust: boolean;

  idleTicks: number;
  respawnTimer: number | null;
}

export type InputCommand = InputMessage;

export interface ChatEvent {
  playerId: PlayerId;
  name: string;
  text: string;
}

export type RoomLogEvent =
  | {
      t: number;
      type: 'join';
      playerId: PlayerId;
      name: string;
    }
  | {
      t: number;
      type: 'leave';
      playerId: PlayerId;
      name: string;
    }
  | ({
      t: number;
      type: 'chat';
    } & ChatEvent);

export interface SocketState {
  missedPongs: number;

  tokens: number;
  lastRefill: number;

  chatTokens: number;
  lastChatRefill: number;
}

