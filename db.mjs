import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const dataDirectory = join(projectRoot, 'data');
mkdirSync(dataDirectory, { recursive: true });

const databasePath = process.env.JOBTRACKER_DB || join(dataDirectory, 'jobs.sqlite');
const database = new DatabaseSync(databasePath, { timeout: 5000 });
database.exec(readFileSync(join(projectRoot, 'schema.sql'), 'utf8'));

function ensureColumn(table, column, definition) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((candidate) => candidate.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn('jobs', 'structured_details', "TEXT NOT NULL DEFAULT '{}'");
ensureColumn('jobs', 'interest_status', "TEXT NOT NULL DEFAULT 'unreviewed'");
ensureColumn('jobs', 'interest_note', "TEXT NOT NULL DEFAULT ''");
ensureColumn('companies', 'profile_details', "TEXT NOT NULL DEFAULT '{}'");

function normalize(value = '') {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(incorporated|inc|llc|ltd|limited|corp|corporation|company|co)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value ?? '');
  } catch {
    return fallback;
  }
}

function mergeObjects(current = {}, incoming = {}) {
  const result = { ...current };
  for (const [key, value] of Object.entries(incoming || {})) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = mergeObjects(result[key] && typeof result[key] === 'object' ? result[key] : {}, value);
    } else if (value !== '' && value !== null && value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function mapJob(row) {
  if (!row) return null;
  return {
    ...row,
    customFields: parseJson(row.custom_fields, {}),
    companyCustomFields: parseJson(row.company_custom_fields, {}),
    structuredDetails: parseJson(row.structured_details, {}),
    companyProfile: parseJson(row.company_profile_details, {}),
    custom_fields: undefined,
    company_custom_fields: undefined,
    structured_details: undefined,
    company_profile_details: undefined,
  };
}

const baseJobSelect = `
  SELECT
    j.*,
    c.name AS company,
    c.description AS company_description,
    c.website AS company_website,
    c.industry AS company_industry,
    c.company_size,
    c.notes AS company_notes,
    c.custom_fields AS company_custom_fields,
    c.profile_details AS company_profile_details
  FROM jobs j
  LEFT JOIN companies c ON c.id = j.company_id
`;

export function listJobs() {
  return database.prepare(`${baseJobSelect} ORDER BY c.name COLLATE NOCASE, j.updated_at DESC`).all().map(mapJob);
}

export function getJob(id) {
  return mapJob(database.prepare(`${baseJobSelect} WHERE j.id = ?`).get(id));
}

export function getJobSources(id) {
  return database.prepare(`
    SELECT s.id, s.source_type, s.raw_text, s.raw_html, s.parsed_json, s.created_at
    FROM sources s
    JOIN source_jobs sj ON sj.source_id = s.id
    WHERE sj.job_id = ?
    ORDER BY s.created_at DESC, s.id DESC
  `).all(id).map((row) => ({ ...row, parsed: parseJson(row.parsed_json, null), parsed_json: undefined }));
}

function createSource({ sourceType, rawText, rawHtml, parsed }) {
  const result = database.prepare(`
    INSERT INTO sources (source_type, raw_text, raw_html, parsed_json)
    VALUES (?, ?, ?, ?)
  `).run(sourceType || 'unknown', rawText || '', rawHtml || '', JSON.stringify(parsed ?? null));
  return Number(result.lastInsertRowid);
}

function attachSource(sourceId, jobId) {
  database.prepare('INSERT OR IGNORE INTO source_jobs (source_id, job_id) VALUES (?, ?)').run(sourceId, jobId);
}

function getOrCreateCompany(name, details = {}) {
  if (!name?.trim()) return null;
  const normalizedName = normalize(name);
  if (!normalizedName) return null;

  let company = database.prepare('SELECT * FROM companies WHERE normalized_name = ?').get(normalizedName);
  if (!company) {
    const result = database.prepare(`
      INSERT INTO companies (name, normalized_name, description, website, industry, company_size, profile_details)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(name.trim(), normalizedName, details.description || null, details.website || null, details.industry || null, details.companySize || null, JSON.stringify(details));
    company = database.prepare('SELECT * FROM companies WHERE id = ?').get(Number(result.lastInsertRowid));
  } else if (Object.keys(details).length) {
    const mergedProfile = mergeObjects(parseJson(company.profile_details, {}), details);
    database.prepare(`
      UPDATE companies SET
        description = COALESCE(NULLIF(?, ''), description),
        website = COALESCE(NULLIF(?, ''), website),
        industry = COALESCE(NULLIF(?, ''), industry),
        company_size = COALESCE(NULLIF(?, ''), company_size),
        profile_details = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(details.description || '', details.website || '', details.industry || '', details.companySize || '', JSON.stringify(mergedProfile), company.id);
  }
  return company.id;
}

function findExistingJob(job, companyId) {
  if (job.linkedinJobId) {
    const found = database.prepare('SELECT * FROM jobs WHERE linkedin_job_id = ?').get(job.linkedinJobId);
    if (found) return found;
  }
  if (job.jobUrl) {
    const found = database.prepare('SELECT * FROM jobs WHERE job_url = ?').get(job.jobUrl);
    if (found) return found;
  }
  if (companyId && job.title) {
    return database.prepare(`
      SELECT * FROM jobs
      WHERE company_id = ? AND lower(trim(title)) = lower(trim(?))
        AND lower(trim(COALESCE(location, ''))) = lower(trim(COALESCE(?, '')))
      LIMIT 1
    `).get(companyId, job.title, job.location || '');
  }
  return null;
}

function mergeJob(existingId, job, companyId) {
  const existing = database.prepare('SELECT structured_details FROM jobs WHERE id = ?').get(existingId);
  const structuredDetails = mergeObjects(parseJson(existing?.structured_details, {}), job.structuredDetails || {});
  if (Object.hasOwn(job.structuredDetails || {}, 'jobSeekerInsights')) {
    structuredDetails.jobSeekerInsights = job.structuredDetails.jobSeekerInsights;
  }
  database.prepare(`
    UPDATE jobs SET
      company_id = COALESCE(?, company_id),
      linkedin_job_id = COALESCE(NULLIF(?, ''), linkedin_job_id),
      title = COALESCE(NULLIF(?, ''), title),
      location = COALESCE(NULLIF(?, ''), location),
      work_arrangement = COALESCE(NULLIF(?, ''), work_arrangement),
      employment_type = COALESCE(NULLIF(?, ''), employment_type),
      seniority = COALESCE(NULLIF(?, ''), seniority),
      salary = COALESCE(NULLIF(?, ''), salary),
      description = CASE WHEN length(COALESCE(?, '')) > length(COALESCE(description, '')) THEN ? ELSE description END,
      job_url = COALESCE(NULLIF(?, ''), job_url),
      structured_details = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    companyId,
    job.linkedinJobId || '',
    job.title || '',
    job.location || '',
    job.workArrangement || '',
    job.employmentType || '',
    job.seniority || '',
    job.salary || '',
    job.description || '',
    job.description || '',
    job.jobUrl || '',
    JSON.stringify(structuredDetails),
    existingId,
  );
}

function insertJob(job, companyId) {
  const result = database.prepare(`
    INSERT INTO jobs (
      company_id, linkedin_job_id, title, location, work_arrangement,
      employment_type, seniority, salary, description, job_url, status, structured_details
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    companyId,
    job.linkedinJobId || null,
    job.title?.trim() || 'Untitled job',
    job.location || null,
    job.workArrangement || null,
    job.employmentType || null,
    job.seniority || null,
    job.salary || null,
    job.description || null,
    job.jobUrl || null,
    job.status || 'saved',
    JSON.stringify(job.structuredDetails || {}),
  );
  return Number(result.lastInsertRowid);
}

export function importJobs({ sourceType, rawText, rawHtml, jobs }) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const sourceId = createSource({ sourceType, rawText, rawHtml, parsed: { jobs } });
    const results = [];
    for (const job of jobs) {
      const companyId = getOrCreateCompany(job.company, job.companyDetails);
      const existing = findExistingJob(job, companyId);
      let jobId;
      let action;
      if (existing) {
        jobId = existing.id;
        mergeJob(jobId, job, companyId);
        action = 'updated';
      } else {
        jobId = insertJob(job, companyId);
        action = 'created';
      }
      attachSource(sourceId, jobId);
      results.push({ action, job: getJob(jobId) });
    }
    database.exec('COMMIT');
    return results;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

const editableJobFields = {
  title: 'title',
  location: 'location',
  workArrangement: 'work_arrangement',
  employmentType: 'employment_type',
  seniority: 'seniority',
  salary: 'salary',
  description: 'description',
  jobUrl: 'job_url',
  status: 'status',
  interestStatus: 'interest_status',
  interestNote: 'interest_note',
  notes: 'notes',
  customFields: 'custom_fields',
  structuredDetails: 'structured_details',
};

export function updateJob(id, changes) {
  const allowedStatuses = new Set(['saved', 'considering', 'applied', 'screening', 'interviewing', 'offer', 'rejected', 'archived']);
  const allowedInterestStatuses = new Set(['unreviewed', 'follow_up', 'not_interested']);
  if ('status' in changes && !allowedStatuses.has(changes.status)) throw new Error('Invalid application status');
  if ('interestStatus' in changes && !allowedInterestStatuses.has(changes.interestStatus)) throw new Error('Invalid interest status');
  const assignments = [];
  const values = [];
  for (const [apiName, columnName] of Object.entries(editableJobFields)) {
    if (!(apiName in changes)) continue;
    assignments.push(`${columnName} = ?`);
    values.push(['customFields', 'structuredDetails'].includes(apiName) ? JSON.stringify(changes[apiName] || {}) : changes[apiName]);
  }
  if ('company' in changes && changes.company?.trim()) {
    assignments.push('company_id = ?');
    values.push(getOrCreateCompany(changes.company));
  }
  if (!assignments.length) return getJob(id);
  assignments.push('updated_at = CURRENT_TIMESTAMP');
  values.push(id);
  database.prepare(`UPDATE jobs SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
  return getJob(id);
}

export function enrichJob(id, { sourceType, rawText, rawHtml, details }) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const existing = getJob(id);
    if (!existing) throw new Error('Job not found');
    const safeDetails = {
      ...details,
      title: existing.title,
      company: existing.company,
      location: existing.location,
      jobUrl: existing.job_url,
      linkedinJobId: existing.linkedin_job_id,
    };
    const companyName = existing.company;
    const companyId = getOrCreateCompany(companyName, safeDetails.companyDetails || {});
    mergeJob(id, safeDetails, companyId);
    const sourceId = createSource({ sourceType, rawText, rawHtml, parsed: safeDetails });
    attachSource(sourceId, id);
    database.exec('COMMIT');
    return getJob(id);
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function listFieldDefinitions() {
  return database.prepare('SELECT * FROM field_definitions ORDER BY scope, id').all().map((row) => ({
    id: row.id,
    scope: row.scope,
    key: row.field_key,
    label: row.label,
    type: row.field_type,
    options: parseJson(row.options_json, []),
  }));
}

function makeFieldKey(label) {
  const base = normalize(label).replace(/\s+/g, '_') || 'custom_field';
  let key = base;
  let suffix = 2;
  while (database.prepare('SELECT 1 FROM field_definitions WHERE field_key = ?').get(key)) {
    key = `${base}_${suffix++}`;
  }
  return key;
}

export function createFieldDefinition({ scope = 'job', label, type = 'text', options = [] }) {
  if (!label?.trim()) throw new Error('A field label is required');
  if (!['job', 'company'].includes(scope)) throw new Error('Invalid custom-field scope');
  if (!['text', 'long_text', 'number', 'date', 'checkbox', 'select', 'url'].includes(type)) throw new Error('Invalid custom-field type');
  if (label.trim().length > 80) throw new Error('Custom-field labels must be 80 characters or fewer');
  if (!Array.isArray(options) || options.length > 50 || options.some((option) => typeof option !== 'string' || option.length > 120)) {
    throw new Error('Custom-field options are invalid');
  }
  const key = makeFieldKey(label);
  const result = database.prepare(`
    INSERT INTO field_definitions (scope, field_key, label, field_type, options_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(scope, key, label.trim(), type, JSON.stringify(options));
  return listFieldDefinitions().find((field) => field.id === Number(result.lastInsertRowid));
}

export function deleteFieldDefinition(id) {
  database.prepare('DELETE FROM field_definitions WHERE id = ?').run(id);
}

export function databaseInfo() {
  return { path: databasePath };
}
