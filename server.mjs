import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createFieldDefinition,
  databaseInfo,
  deleteFieldDefinition,
  enrichJob,
  getJob,
  getJobSources,
  importJobs,
  listFieldDefinitions,
  listJobs,
  updateJob,
} from './db.mjs';
import { parsePastedContent } from './linkedin-parser.mjs';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const publicDirectory = join(projectRoot, 'public');
const port = Number(process.env.PORT || 3210);
const host = process.env.HOST || '127.0.0.1';
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const allowRemote = process.env.JOBTRACKER_ALLOW_REMOTE === '1';
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}
if (!loopbackHosts.has(host) && !allowRemote) {
  throw new Error('Refusing to expose private job data beyond this computer. Set JOBTRACKER_ALLOW_REMOTE=1 only if you understand the risk.');
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(response, status, payload, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    const error = new Error('Requests that change data must use application/json.');
    error.statusCode = 415;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error('The pasted content is too large (8 MB maximum).');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('The request did not contain valid JSON.');
  }
}

function assertSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return;
  const expectedOrigin = `http://${request.headers.host || `${host}:${port}`}`;
  if (origin !== expectedOrigin) {
    const error = new Error('Cross-origin requests are not allowed.');
    error.statusCode = 403;
    throw error;
  }
}

function assertTrustedHost(request) {
  if (allowRemote) return;
  try {
    const requestHost = new URL(`http://${request.headers.host || ''}`).hostname;
    if (loopbackHosts.has(requestHost)) return;
  } catch {
    // The common error below intentionally covers malformed and untrusted hosts.
  }
  const error = new Error('The request Host is not allowed.');
  error.statusCode = 421;
  throw error;
}

function jobIdFrom(pathname, suffix = '') {
  const escapedSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return pathname.match(new RegExp(`^/api/jobs/(\\d+)${escapedSuffix}$`))?.[1];
}

async function handleApi(request, response, url) {
  const { pathname } = url;

  if (request.method === 'GET' && pathname === '/api/health') {
    return json(response, 200, { ok: true });
  }

  if (request.method === 'GET' && pathname === '/api/jobs') {
    return json(response, 200, { jobs: listJobs() });
  }

  if (request.method === 'GET' && pathname === '/api/export') {
    const exportData = {
      exportedAt: new Date().toISOString(),
      jobs: listJobs().map((job) => ({ ...job, sources: getJobSources(job.id) })),
      customFields: listFieldDefinitions(),
    };
    return json(response, 200, exportData, {
      'Content-Disposition': `attachment; filename="job-tracker-${new Date().toISOString().slice(0, 10)}.json"`,
    });
  }

  if (request.method === 'GET' && pathname === '/api/custom-fields') {
    return json(response, 200, { fields: listFieldDefinitions() });
  }

  if (request.method === 'POST' && pathname === '/api/custom-fields') {
    const body = await readJsonBody(request);
    return json(response, 201, { field: createFieldDefinition(body) });
  }

  const fieldId = pathname.match(/^\/api\/custom-fields\/(\d+)$/)?.[1];
  if (request.method === 'DELETE' && fieldId) {
    deleteFieldDefinition(Number(fieldId));
    return json(response, 200, { ok: true });
  }

  if (request.method === 'POST' && pathname === '/api/parse') {
    const body = await readJsonBody(request);
    const result = parsePastedContent(
      { plainText: body.plainText || '', html: body.html || '' },
      { mode: body.mode || 'auto' },
    );
    return json(response, 200, result);
  }

  if (request.method === 'POST' && pathname === '/api/import') {
    const body = await readJsonBody(request);
    if (!Array.isArray(body.jobs) || !body.jobs.length) throw new Error('There are no jobs to import.');
    const results = importJobs({
      sourceType: body.sourceType || 'pasted_alert',
      rawText: body.plainText || '',
      rawHtml: body.html || '',
      jobs: body.jobs,
    });
    return json(response, 201, { results });
  }

  const sourcesJobId = jobIdFrom(pathname, '/sources');
  if (request.method === 'GET' && sourcesJobId) {
    return json(response, 200, { sources: getJobSources(Number(sourcesJobId)) });
  }

  const enrichJobId = jobIdFrom(pathname, '/enrich');
  if (request.method === 'POST' && enrichJobId) {
    const body = await readJsonBody(request);
    if (!body.details) throw new Error('Parsed job details are required.');
    const job = enrichJob(Number(enrichJobId), {
      sourceType: body.sourceType || 'pasted_job_details',
      rawText: body.plainText || '',
      rawHtml: body.html || '',
      details: body.details,
    });
    return json(response, 200, { job });
  }

  const jobId = jobIdFrom(pathname);
  if (request.method === 'GET' && jobId) {
    const job = getJob(Number(jobId));
    return job ? json(response, 200, { job }) : json(response, 404, { error: 'Job not found.' });
  }

  if (request.method === 'PATCH' && jobId) {
    const body = await readJsonBody(request);
    const job = updateJob(Number(jobId), body);
    return job ? json(response, 200, { job }) : json(response, 404, { error: 'Job not found.' });
  }

  return json(response, 404, { error: 'API endpoint not found.' });
}

async function serveStatic(response, pathname) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const relativePath = decodeURIComponent(requestedPath).replace(/^[/\\]+/, '');
  const filePath = resolve(publicDirectory, relativePath);
  if (filePath !== publicDirectory && !filePath.startsWith(`${publicDirectory}${sep}`)) {
    response.writeHead(403);
    return response.end('Forbidden');
  }
  try {
    const contents = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': mimeTypes[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
    });
    response.end(contents);
  } catch (error) {
    if (error.code === 'ENOENT') {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    throw error;
  }
}

const server = createServer(async (request, response) => {
  try {
    assertTrustedHost(request);
    const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);
    if (url.pathname.startsWith('/api/')) {
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method)) assertSameOrigin(request);
      await handleApi(request, response, url);
    } else {
      await serveStatic(response, url.pathname);
    }
  } catch (error) {
    console.error(error);
    if (!response.headersSent) json(response, error.statusCode || 400, { error: error.message || 'Unexpected error.' });
    else response.end();
  }
});

server.listen(port, host, () => {
  console.log(`JobTracker is running at http://${host}:${port}`);
  console.log(`Database: ${databaseInfo().path}`);
});
