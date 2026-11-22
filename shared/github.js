import { defineTool } from '@earendil-works/pi-durable';
import { obj, str } from '@earendil-works/pi-schema';

/** Accept only owner/name, not URLs, API paths, or search qualifiers. */
export function repository(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/.test(value) ||
      ['.', '..'].includes(value.split('/')[1])) {
    throw new Error('Provide a GitHub repository as owner/name');
  }
  return value;
}

/** A minimal GitHub REST client for the agents' own tools, authenticated as the gh login. */
export function githubClient(token) {
  return async function github(path, body) {
    const response = await fetch(`https://api.github.com${path}`, {
      method: body ? 'POST' : 'GET',
      body: body && JSON.stringify(body),
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
    return response.json();
  };
}

export function searchIssuesTool(github) {
  return defineTool({
    name: 'search_issues',
    description: 'Find open and closed issues in the specified GitHub repository using up to three distinctive keywords.',
    parameters: obj({ repo: str(), query: str() }),
    async execute({ repo, query }) {
      repository(repo);
      const terms = query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 3) ?? [];
      if (!terms.length) throw new Error('Provide at least one keyword');
      const q = `repo:${repo} is:issue (${terms.map((term) => `"${term}"`).join(' OR ')})`;
      const result = await github(`/search/issues?${new URLSearchParams({ q, per_page: '5' })}`);
      if (result.incomplete_results) throw new Error('GitHub search was incomplete');
      const matches = result.items.map(({ title, state, html_url, body }) => ({
        title, state, url: html_url, excerpt: body?.slice(0, 300),
      }));
      return { output: [{ type: 'text', text: JSON.stringify(matches) }] };
    },
  });
}

/**
 * Publish an issue. `create` decides what to post and returns the issue URL, so callers
 * can add provenance or guard against publishing twice.
 */
export function createIssueTool(create) {
  return defineTool({
    name: 'create_issue',
    description: 'Publish an issue in the specified GitHub repository with the supplied title and description.',
    parameters: obj({ repo: str(), title: str(), description: str() }),
    async execute({ repo, title, description }) {
      repository(repo);
      const url = await create({ repo, title, description });
      return { output: [{ type: 'text', text: url }] };
    },
  });
}
