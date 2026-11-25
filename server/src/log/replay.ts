import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const VALID_ID = /^[a-zA-Z0-9_-]{1,100}$/;

export const getReplayPath = (logDir: string, id: string): string | null => {
  if (!VALID_ID.test(id)) {
    return null;
  }

  return join(logDir, `${id}.ndjson`);
};

export const listReplays = async (logDir: string): Promise<string[]> => {
  const files = await readdir(logDir, {
    withFileTypes: true,
  });

  return files
    .filter((file) => file.isFile() && file.name.endsWith('.ndjson'))
    .map((file) => file.name.slice(0, -'.ndjson'.length))
    .sort();
};

// Асинхронний генератор для читання подій
export async function* readReplayEvents(
  filePath: string,
): AsyncGenerator<unknown> {
  const stream = createReadStream(filePath, {
    encoding: 'utf8',
  });

  let remaining = '';

  for await (const chunk of stream) {
    remaining += String(chunk);

    let newlineIndex = remaining.indexOf('\n');

    while (newlineIndex !== -1) {
      const line = remaining.slice(0, newlineIndex);
      remaining = remaining.slice(newlineIndex + 1);

      if (line.trim()) {
        const event: unknown = JSON.parse(line);
        yield event;
      }

      newlineIndex = remaining.indexOf('\n');
    }
  }

  if (remaining.trim()) {
    const event: unknown = JSON.parse(remaining);
    yield event;
  }
}

