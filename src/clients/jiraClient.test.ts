import { describe, expect, it } from 'vitest';
import { buildSearchUrl } from './jiraClient.js';

describe('buildSearchUrl', () => {
  it('encodes the JQL and fields into a search query string', () => {
    const url = buildSearchUrl('https://example.atlassian.net', 'status = "In Review"', ['summary', 'status']);

    expect(url).toBe(
      'https://example.atlassian.net/rest/api/3/search/jql?jql=status+%3D+%22In+Review%22&fields=summary%2Cstatus',
    );
  });

  it('strips a trailing slash from the base URL', () => {
    const url = buildSearchUrl('https://example.atlassian.net/', 'x', ['summary']);
    expect(url.startsWith('https://example.atlassian.net/rest/api/3/search/jql?')).toBe(true);
  });

  it('defaults to summary, status, description fields', () => {
    const url = buildSearchUrl('https://example.atlassian.net', 'x');
    expect(url).toContain('fields=summary%2Cstatus%2Cdescription');
  });
});
