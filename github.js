import { defineTool } from '@earendil-works/pi-durable';
import { obj, str } from '@earendil-works/pi-schema';

export const repo = 'ipdelete/floe';

/** A minimal GitHub REST client for intake's own tools, authenticated as the gh login. */
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

export function searchFeaturesTool(github) {
  return defineTool({
    name: 'search_features',
    description: 'Find open and closed Floe issues using up to three distinctive keywords.',
    parameters: obj({ query: str() }),
    async execute({ query }) {
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
 * Publish a Floe issue. `create` decides what to post and returns the issue URL, so callers
 * can add provenance or guard against publishing twice.
 */
export function createFeatureIssueTool(create, { terminate = false } = {}) {
  return defineTool({
    name: 'create_feature_issue',
    description: 'Publish an issue with the supplied title and description.',
    parameters: obj({ title: str(), description: str() }),
    async execute({ title, description }) {
      const url = await create({ title, description });
      return { output: [{ type: 'text', text: url }], ...(terminate ? { control: { terminate: true } } : {}) };
    },
  });
}
