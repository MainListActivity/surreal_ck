import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const allDependencies = {
  ...packageJson.dependencies,
  ...packageJson.devDependencies,
};

const univerEntries = Object.entries(allDependencies).filter(([name]) =>
  name.startsWith('@univerjs/'),
);

const versions = new Set(univerEntries.map(([, version]) => version));

if (versions.size > 1) {
  const detail = univerEntries.map(([name, version]) => `${name}@${version}`).join(', ');
  throw new Error(`All @univerjs/* packages must share one exact version. Found: ${detail}`);
}

console.log(`Verified ${univerEntries.length} @univerjs/* packages on ${[...versions][0] ?? 'n/a'}.`);
