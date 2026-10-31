import { buildSnapshot } from '../cli/src/commands/docs/snapshot.js';
const [docsDir, outputDir, revision, artifactBaseURL] = process.argv.slice(2);
if (!docsDir || !outputDir || !revision || !artifactBaseURL) throw new Error('Usage: node scripts/build-docs-snapshot.mjs DOCS_DIR OUTPUT_DIR REVISION ARTIFACT_BASE_URL');
const manifest = buildSnapshot({ docsDir, outputDir, revision, artifactBaseURL });
process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
