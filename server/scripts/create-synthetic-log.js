import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { config } from '../src/config.ts';

const TARGET_SIZE = 200 * 1024 * 1024;
const FILE_NAME = 'm4-synthetic-200mb.ndjson';

await mkdir(config.logDir, { recursive: true });

const filePath = join(config.logDir, FILE_NAME);
const stream = createWriteStream(filePath);

const line = Buffer.from(
  JSON.stringify({
    t: Date.now(),
    type: 'chat',
    playerId: 'benchmark',
    name: 'Benchmark',
    text: 'x'.repeat(900),
  }) + '\n',
);

let bytesWritten = 0;

try {
  while (bytesWritten < TARGET_SIZE) {
    const canContinue = stream.write(line);
    bytesWritten += line.length;

    if (!canContinue) {
      await once(stream, 'drain');
    }
  }

  stream.end();
  await once(stream, 'finish');

  console.log(
    `Created ${filePath}: ` + `${(bytesWritten / (1024 * 1024)).toFixed(1)} MB`,
  );
} catch (error) {
  stream.destroy();
  throw error;
}
