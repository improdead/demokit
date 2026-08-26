/**
 * Generate the fabricated findings queue for flows/seeded-example.json.
 *
 *   node fixtures/gen-findings.mjs
 *
 * One script, one committed output, no typed numbers. Everything derived from
 * BASE so take 2 matches take 1 and a human can review exactly what was made
 * up. This is the shape every fixture set should have; see skill/SKILL.md §5.
 */
import { writeFileSync } from 'node:fs';

const BASE = Date.parse('2026-08-26T15:41:00Z');   // must equal flow.seed.clock
const mins = (m) => new Date(BASE - m * 60000).toISOString();

// Bursty, not evenly spaced: a scan fired ~1h ago and another overnight.
const rows = [
  ['sqli',  'critical', 'billing-api',   'services/billing/queries.py',            41,   14, 'Unparameterised SQL built from org_id'],
  ['ssrf',  'critical', 'webhooks',      'services/webhooks/dispatch.go',          88,   17, 'Webhook target fetched without an internal-range guard'],
  ['authz', 'critical', 'billing-api',   'services/billing/routes.py',            206,   23, 'Invoice endpoint missing org scope check'],
  ['xss',   'high',     'console-web',   'app/components/CommentBody.tsx',         62,   58, 'dangerouslySetInnerHTML on unsanitised comment markdown'],
  ['secret','high',     'infra-terraform','modules/rds/main.tf',                   19,   61, 'Database password committed as a default variable value'],
  ['deps',  'high',     'console-web',   'package-lock.json',                    1204,  184, 'axios 0.27.2 — CVE-2023-45857, proxy credentials leak'],
  ['cors',  'high',     'edge-gateway',  'gateway/cors.ts',                        27,  191, 'Access-Control-Allow-Origin reflects the request Origin header'],
  ['proto', 'medium',   'console-web',   'app/lib/merge.ts',                       11,  402, 'Recursive merge reachable from a user-controlled payload, allowing prototype pollution on the settings object'],
  ['jwt',   'medium',   'edge-gateway',  'gateway/auth/verify.ts',                 44,  418, 'JWT verified without pinning the expected algorithm'],
  ['logs',  'medium',   'billing-api',   'services/billing/audit.py',              77,  455, 'Full card BIN written to the audit log'],
  ['rate',  'medium',   'edge-gateway',  'gateway/limits.ts',                      31, 1290, 'Password reset endpoint is not rate limited'],
  ['perm',  'medium',   'infra-terraform','modules/s3/main.tf',                    52, 1471, 'Bucket policy grants s3:GetObject to *'],
];

// Ids in the app's own shape, non-contiguous, and stable across runs.
const id = (slug, i) => 'fnd_' + (0x5f2a1 + i * 2731).toString(36) + '_' + slug;

const findings = rows.map(([slug, severity, repo, path, line, ago, title], i) => ({
  id: id(slug, i), title, severity, repo, path, line,
  detectedAt: mins(ago),
  // TEST-NET-1 (RFC 5737) and an invented domain: safe to put on camera.
  evidence: {
    sqli:   'POST /v1/orgs/8841/invoices\nsrc=192.0.2.47  ua=curl/8.4.0\norg_id="8841\' OR 1=1 --"',
    ssrf:   'POST /v1/webhooks/test\ntarget=http://169.254.169.254/latest/meta-data/\nsrc=192.0.2.113',
    secret: 'variable "db_password" {\n  default = "REDACTED-BY-TRIDENT"\n}',
  }[slug] || `${path}:${line}\n${title}`,
}));

const bySev = (s) => findings.filter((f) => f.severity === s).length;
const repos = new Set(findings.map((f) => f.repo));

// Derived, never typed: the KPI has to agree with the rows beneath it.
const out = {
  findings,
  openCount: findings.length,
  criticalCount: bySev('critical'),
  repoCount: repos.size,
  mttf: '4h 12m',
};

writeFileSync(new URL('./findings.json', import.meta.url), JSON.stringify(out, null, 1));
console.log(`${out.openCount} findings · ${out.criticalCount} critical · ${bySev('high')} high · ${out.repoCount} repos`);
