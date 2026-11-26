import { readFile, readFileSync } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';

// Scenario-map attributes reads to their direct caller in the project's test directory.
export function readSync(file) {
  return readFileSync(file, 'utf8');
}

export function readAsync(file) {
  return readFileAsync(file);
}

export function readCallback(file) {
  return new Promise((resolve, reject) => {
    readFile(file, 'utf8', (error, text) => (error ? reject(error) : resolve(text)));
  });
}
