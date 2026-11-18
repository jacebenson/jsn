import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// This module must come from canonical main, never the selected release tree.
export function verifyProductionRelease({ cwd, tag, eventName, eventRef, eventSha, remote = 'https://github.com/jacebenson/jsn.git' }) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag ?? '')) {
    throw new Error('Select an existing production version tag, for example v4.3.5');
  }
  if (eventName === 'workflow_dispatch') {
    if (eventRef !== 'refs/heads/main') throw new Error('Dispatch production publishing from main');
  } else if (eventName === 'push') {
    if (eventRef !== `refs/tags/${tag}` || !/^[a-f0-9]{40}$/.test(eventSha ?? '')) {
      throw new Error('Expected a version tag push with an immutable event SHA');
    }
  } else {
    throw new Error('Unsupported production publishing event');
  }
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  // Fetch only the canonical main and the exact tag. Unshallow before checking
  // ancestry: a shallow merge-base can otherwise reject a legitimate old tag.
  const shallow = git('rev-parse', '--is-shallow-repository') === 'true';
  git('fetch', '--force', '--no-tags', ...(shallow ? ['--unshallow'] : []), remote,
    '+refs/heads/main:refs/remotes/origin/main',
    `+refs/tags/${tag}:refs/release-candidate/tag`);
  const sha = git('rev-parse', '--verify', 'refs/release-candidate/tag^{commit}');
  if (eventName === 'push' && git('rev-parse', '--verify', `${eventSha}^{commit}`) !== sha) {
    throw new Error('The fetched tag no longer matches the tag push SHA');
  }
  try {
    git('merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main');
  } catch {
    throw new Error('The production tag commit is not an ancestor of canonical main');
  }
  // Read data from the verified object, without running candidate code/hooks.
  const pkg = JSON.parse(git('show', `${sha}:cli/package.json`));
  if (`v${pkg.version}` !== tag) throw new Error('The production tag does not match cli/package.json version');
  return { tag, sha };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = verifyProductionRelease({
      cwd: process.cwd(), tag: process.env.RELEASE_TAG,
      eventName: process.env.GITHUB_EVENT_NAME, eventRef: process.env.GITHUB_REF,
      eventSha: process.env.GITHUB_SHA,
    });
    appendFileSync(process.env.GITHUB_OUTPUT, `tag=${result.tag}\nsha=${result.sha}\n`);
    console.log(`Verified ${result.tag} at ${result.sha} on canonical main`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
