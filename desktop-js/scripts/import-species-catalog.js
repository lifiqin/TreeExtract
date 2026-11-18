'use strict';

// Convert the supplied hierarchy without evaluating user-provided JavaScript.
const fs = require('node:fs');

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node import-species-catalog.js input output');
const source = fs.readFileSync(input, 'utf8');
const groups = [];
let group;
for (const line of source.split(/\r?\n/)) {
  const groupMatch = line.match(/^\s*'([^']+)':\s*\[/);
  if (groupMatch) {
    group = { name: groupMatch[1], entries: [] };
    groups.push(group);
    continue;
  }
  const entry = line.match(/\{\s*value:\s*'([^']+)',\s*name:\s*'([^']+)'\s*\}/);
  if (entry) {
    if (!group) throw new Error('Entry outside a group');
    group.entries.push({ value: entry[1], name: entry[2] });
  }
}
const entries = groups.flatMap((item) => item.entries);
if (groups.length !== 7 || entries.length !== 119) throw new Error('Unexpected taxonomy size');
if (new Set(entries.map((item) => item.value)).size !== entries.length)
  throw new Error('Taxonomy values must be unique');
fs.writeFileSync(output, `${JSON.stringify(groups, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
