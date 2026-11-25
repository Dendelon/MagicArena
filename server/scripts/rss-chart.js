import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const input = process.argv[2];

if (!input) {
  throw new Error('Usage: node server/scripts/rss-chart.js <rss.csv>');
}

const raw = await readFile(resolve(input), 'utf8');

const samples = raw
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .map((line) => {
    const [seconds, rss] = line.split(',').map(Number);
    return { seconds, rss };
  })
  .filter((item) => Number.isFinite(item.seconds) && Number.isFinite(item.rss));

if (samples.length < 2) {
  throw new Error('At least two RSS samples are required');
}

const width = 900;
const height = 420;

const left = 70;
const right = 25;
const top = 50;
const bottom = 55;

const plotWidth = width - left - right;
const plotHeight = height - top - bottom;

const maxSeconds = Math.max(1, ...samples.map((item) => item.seconds));

const maxRss = Math.max(1, ...samples.map((item) => item.rss));

const yMax = maxRss * 1.1;

const getX = (seconds) => left + (seconds / maxSeconds) * plotWidth;

const getY = (rss) => height - bottom - (rss / yMax) * plotHeight;

const grid = Array.from({ length: 5 }, (_, i) => {
  const rss = (yMax * i) / 4;
  const y = getY(rss);

  return `
    <line x1="${left}" y1="${y}"
      x2="${width - right}" y2="${y}"
      stroke="#ddd6fe" opacity="0.4"/>
    <text x="${left - 12}" y="${y + 4}"
      text-anchor="end" font-size="13">${rss.toFixed(0)}</text>
  `;
}).join('');

const points = samples
  .map(({ seconds, rss }) => `${getX(seconds).toFixed(1)},${getY(rss).toFixed(1)}`)
  .join(' ');

const svg = `
<svg xmlns="http://www.w3.org/2000/svg"
  width="${width}" height="${height}"
  viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#ffffff"/>

  <text x="${width / 2}" y="28"
    text-anchor="middle" font-size="20"
    font-family="Arial" fill="#312e81">
    Node.js RSS during throttled replay download
  </text>

  <g fill="#374151" font-family="Arial">
    ${grid}

    <line x1="${left}" y1="${top}"
      x2="${left}" y2="${height - bottom}"
      stroke="#374151"/>

    <line x1="${left}" y1="${height - bottom}"
      x2="${width - right}" y2="${height - bottom}"
      stroke="#374151"/>

    <polyline fill="none" stroke="#7c3aed"
      stroke-width="2.5" points="${points}"/>

    <text x="${left}" y="${height - 20}"
      font-size="13">0 s</text>

    <text x="${width - right}" y="${height - 20}"
      font-size="13" text-anchor="end">
      ${maxSeconds.toFixed(0)} s
    </text>

    <text x="${width / 2}" y="${height - 6}"
      font-size="13" text-anchor="middle">
      Time (seconds)
    </text>

    <text x="18" y="45" font-size="13">
      RSS (MB)
    </text>
  </g>
</svg>`;

const output = resolve('docs/lab04/rss.svg');

await mkdir(dirname(output), { recursive: true });
await writeFile(output, svg);

const minRss = Math.min(...samples.map((item) => item.rss));

console.log(`Graph saved: ${output}`);
console.log(`Samples: ${samples.length}`);
console.log(`RSS min: ${minRss.toFixed(2)} MB`);
console.log(`RSS max: ${maxRss.toFixed(2)} MB`);
