'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { evaluate, sha256 } = require('./qa-annotations');

function parseArguments(args) {
  const options = {};
  const names = new Set([
    'predictions',
    'labels',
    'output',
    'min-blind-points',
    'min-pairs',
    'min-person',
    'min-head',
    'min-scalp',
  ]);
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    if (
      !name.startsWith('--') ||
      !names.has(name.slice(2)) ||
      !args[i + 1] ||
      args[i + 1].startsWith('--')
    ) {
      throw new Error(`Invalid argument: ${name}`);
    }
    const key = name.slice(2);
    if (Object.hasOwn(options, key)) throw new Error(`Repeated argument: ${name}`);
    options[key] = args[i + 1];
  }
  for (const name of ['predictions', 'labels', 'output'])
    if (!options[name]) throw new Error(`Missing --${name}`);
  for (const name of ['min-blind-points', 'min-pairs', 'min-person', 'min-head', 'min-scalp']) {
    if (
      options[name] !== undefined &&
      (!/^[1-9]\d*$/.test(options[name]) || !Number.isSafeInteger(Number(options[name])))
    ) {
      throw new Error(`--${name} must be a positive integer`);
    }
  }
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const predictionsPath = path.resolve(options.predictions);
  const labelsPath = path.resolve(options.labels);
  const predictionsBytes = fs.readFileSync(predictionsPath);
  const labelsBytes = fs.readFileSync(labelsPath);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const predictions = JSON.parse(decoder.decode(predictionsBytes));
  const labels = JSON.parse(decoder.decode(labelsBytes));
  const report = evaluate(
    predictions,
    labels,
    path.dirname(predictionsPath),
    path.dirname(labelsPath),
  );
  report.provenance = {
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    predictionsSha256: sha256(predictionsBytes),
    labelsSha256: sha256(labelsBytes),
    evaluatorSha256: sha256(fs.readFileSync(require.resolve('./qa-annotations'))),
    commandSha256: sha256(fs.readFileSync(__filename)),
  };
  const required = [
    ['min-blind-points', report.pointError.blindAutomatic.count],
    ['min-pairs', Math.min(report.dual.reviewedSame, report.dual.reviewedTarget)],
    ['min-person', report.personBlind.classified],
    ['min-head', report.headBlind.classified],
    ['min-scalp', report.scalpBlind.classified],
  ];
  const insufficient = required.filter(
    ([name, count]) => options[name] && count < Number(options[name]),
  );
  report.minimumRequirements = required
    .filter(([name]) => options[name])
    .map(([name, count]) => ({
      name,
      requested: Number(options[name]),
      observed: count,
      met: count >= Number(options[name]),
    }));
  fs.writeFileSync(path.resolve(options.output), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
  });
  console.log(`Report: ${path.resolve(options.output)}`);
  console.log(
    `Samples: ${report.counts.total}; reviewed: ${report.counts.labeled}; blind automatic points: ${report.pointError.blindAutomatic.count}`,
  );
  console.log(
    `Pair reviews: ${report.dual.reviewedSame}; person classified: ${report.person.classified}; head classified: ${report.head.classified}; scalp classified: ${report.scalp.classified}`,
  );
  if (insufficient.length) {
    console.error(
      'Insufficient independent evidence: ' + insufficient.map(([name]) => name).join(', '),
    );
    process.exitCode = 2;
  }
}

try {
  main();
} catch (error) {
  console.error(`Evaluation failed: ${error.message}`);
  process.exitCode = 1;
}
