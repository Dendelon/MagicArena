export interface Codec<T, TWire = string | ArrayBuffer> {
  readonly name: string;

  encode(message: T): TWire;

  decode(data: unknown): T;
}

