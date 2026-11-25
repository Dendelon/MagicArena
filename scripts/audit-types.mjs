import ts from 'typescript';

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = ['client/src', 'server/src', 'shared/src'];

const files = [];

const collect = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      collect(path);
    } else if (path.endsWith('.ts')) {
      files.push(path);
    }
  }
};

ROOTS.forEach(collect);

const assertions = [];
const explicitAny = [];
const nonNullAssertions = [];

for (const file of files) {
  const text = readFileSync(file, 'utf8');

  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const location = (node) => {
    const { line } = source.getLineAndCharacterOfPosition(
      node.getStart(source),
    );

    return `${relative(process.cwd(), file)}:${line + 1}`;
  };

  const visit = (node) => {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      assertions.push(location(node));
    }

    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      explicitAny.push(location(node));
    }

    if (ts.isNonNullExpression(node)) {
      nonNullAssertions.push(location(node));
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
}

console.log(`TypeScript files: ${files.length}`);
console.log(`Explicit any: ${explicitAny.length}`);
console.log(`Type assertions: ${assertions.length}`);
console.log(`Non-null assertions: ${nonNullAssertions.length}`);

for (const [name, items] of [
  ['Explicit any', explicitAny],
  ['Type assertion', assertions],
  ['Non-null assertion', nonNullAssertions],
]) {
  for (const item of items) {
    console.log(`${name}: ${item}`);
  }
}

if (
  explicitAny.length > 0 ||
  assertions.length >= 5 ||
  nonNullAssertions.length > 0
) {
  process.exitCode = 1;
}

