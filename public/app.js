const state = {
  jobs: [],
  fields: [],
  selectedJob: null,
  importSource: { plainText: '', html: '' },
  importResult: null,
  detailSource: { plainText: '', html: '' },
  enrichResult: null,
  quickFilter: 'all',
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function titleCase(value = '') {
  return String(value).replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatPostingDate(dateValue = '', originalRelative = '') {
  if (!dateValue) return originalRelative;
  const posted = new Date(`${dateValue}T12:00:00`);
  if (Number.isNaN(posted.getTime())) return originalRelative || dateValue;
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const days = Math.max(0, Math.floor((today - posted) / 86_400_000));
  let relative;
  if (days === 0) relative = 'today';
  else if (days === 1) relative = '1 day ago';
  else if (days < 7) relative = `${days} days ago`;
  else if (days < 60) {
    const weeks = Math.floor(days / 7);
    relative = `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  } else if (days < 730) {
    const months = Math.floor(days / 30);
    relative = `${months} month${months === 1 ? '' : 's'} ago`;
  } else {
    const years = Math.floor(days / 365);
    relative = `${years} year${years === 1 ? '' : 's'} ago`;
  }
  const date = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(posted);
  return `${date} (${relative})`;
}

function formatDate(dateValue = '') {
  if (!dateValue) return '';
  const date = new Date(`${dateValue}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? dateValue
    : new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

function monogram(name = '') {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0]?.slice(0, 2) || '–').toUpperCase();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

let toastTimer;
function toast(message, type = 'success') {
  const element = $('#toast');
  element.textContent = message;
  element.className = `toast visible ${type === 'error' ? 'error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.className = 'toast'; }, 3400);
}

function setBusy(button, busy, busyText = 'Working…') {
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = busy;
  button.textContent = busy ? busyText : button.dataset.label;
}

function capturePaste(element, sourceKey) {
  element.addEventListener('paste', (event) => {
    const plainText = event.clipboardData?.getData('text/plain') || '';
    const html = event.clipboardData?.getData('text/html') || '';
    if (!plainText && !html) return;
    event.preventDefault();
    state[sourceKey] = { plainText, html };
    element.textContent = plainText || 'Formatted content pasted';
    if (sourceKey === 'importSource') {
      $('#import-paste-status').textContent = `${plainText.length.toLocaleString()} characters${html ? ' · formatting preserved' : ''}`;
    }
  });

  element.addEventListener('input', () => {
    state[sourceKey] = { plainText: element.innerText.trim(), html: '' };
    if (sourceKey === 'importSource') {
      $('#import-paste-status').textContent = element.innerText.trim() ? `${element.innerText.trim().length.toLocaleString()} characters` : 'Nothing pasted yet';
    }
  });
}

async function loadData() {
  const [{ jobs }, { fields }] = await Promise.all([api('/api/jobs'), api('/api/custom-fields')]);
  state.jobs = jobs;
  state.fields = fields;
  renderAll();
}

function renderStats() {
  const count = (statuses) => state.jobs.filter((job) => statuses.includes(job.status)).length;
  $('#stat-needs-details').textContent = state.jobs.filter((job) => !job.description).length;
  $('#stat-total').textContent = state.jobs.length;
  $('#stat-saved').textContent = count(['saved', 'considering']);
  $('#stat-applied').textContent = count(['applied']);
  $('#stat-progress').textContent = count(['screening', 'interviewing', 'offer']);
  for (const [selector, filter] of [
    ['#filter-needs-details', 'needs_details'], ['#filter-all-jobs', 'all'], ['#filter-saved', 'saved'],
    ['#filter-applied', 'applied'], ['#filter-in-progress', 'in_progress'],
  ]) {
    $(selector).classList.toggle('active', state.quickFilter === filter);
    $(selector).setAttribute('aria-pressed', String(state.quickFilter === filter));
  }
}

function jobSeekerInsights(job) {
  return job.structuredDetails?.jobSeekerInsights || { skills: [], education: [], attributes: [] };
}

function countValues(values) {
  const counts = new Map();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

function insightChip(label, count) {
  return `<button class="insight-chip" type="button" data-insight-query="${escapeHtml(label)}"><span>${escapeHtml(label)}</span><strong>${count}</strong></button>`;
}

function renderInsights() {
  const detailedJobs = state.jobs.filter((job) => String(job.description || '').trim());
  const total = state.jobs.length;
  $('#insights-sample').textContent = detailedJobs.length
    ? `Based on ${detailedJobs.length} of ${total} ${total === 1 ? 'job' : 'jobs'} with full details`
    : 'Add full job details to build your insights';

  if (!detailedJobs.length) {
    $('#market-insights').innerHTML = '<article class="insight-card insight-empty"><h3>Insights will appear here</h3><p>Paste full postings into your tracked jobs to discover recurring skills and requirements.</p></article>';
    return;
  }

  const skills = countValues(detailedJobs.flatMap((job) =>
    [...new Set((jobSeekerInsights(job).skills || []).map(({ name }) => name))]));
  const attributes = countValues(detailedJobs.flatMap((job) =>
    [...new Set(jobSeekerInsights(job).attributes || [])]));
  const education = countValues(detailedJobs.flatMap((job) =>
    [...new Set(jobSeekerInsights(job).education || [])]));
  const arrangements = countValues(state.jobs.map((job) =>
    job.work_arrangement || (/\b(remote|hybrid|on[- ]site)\b/i.exec(job.location || '')?.[1] ?? 'Not specified')))
    .map(([label, count]) => [titleCase(label), count]);
  const experience = detailedJobs
    .map((job) => jobSeekerInsights(job).minimumExperienceYears)
    .filter((years) => Number.isFinite(years))
    .sort((left, right) => left - right);
  const medianExperience = experience.length ? experience[Math.floor(experience.length / 2)] : null;
  const salaryCount = detailedJobs.filter((job) => job.salary).length;
  const closedCount = state.jobs.filter((job) => /no longer|not accepting|closed|expired|filled/i.test(job.structuredDetails?.listingStatus || '')).length;

  $('#market-insights').innerHTML = `
    <article class="insight-card insight-skills">
      <div class="insight-card-heading"><h3>Common skills</h3><span>Jobs mentioning each skill</span></div>
      <div class="insight-chips">${skills.length ? skills.slice(0, 14).map(([label, count]) => insightChip(label, count)).join('') : '<p>No recognized skill terms yet.</p>'}</div>
    </article>
    <article class="insight-card">
      <div class="insight-card-heading"><h3>Search readiness</h3><span>Coverage of your saved data</span></div>
      <div class="insight-metrics">
        <div><strong>${detailedJobs.length}/${total}</strong><span>full postings</span></div>
        <div><strong>${salaryCount}/${detailedJobs.length}</strong><span>show salary</span></div>
        <div><strong>${closedCount}</strong><span>closed listings</span></div>
      </div>
    </article>
    <article class="insight-card">
      <div class="insight-card-heading"><h3>Role profile</h3><span>Work model and experience</span></div>
      <div class="insight-breakdown">${arrangements.map(([label, count]) => `<div><span>${escapeHtml(label)}</span><strong>${count}</strong></div>`).join('')}</div>
      <p class="insight-note">${medianExperience == null ? 'No explicit experience minimums detected.' : `Median stated minimum: <strong>${medianExperience}+ years</strong> across ${experience.length} ${experience.length === 1 ? 'role' : 'roles'}.`}</p>
    </article>
    <article class="insight-card insight-expectations">
      <div class="insight-card-heading"><h3>Common expectations</h3><span>Leadership and qualification signals</span></div>
      <div class="insight-chips compact">${attributes.slice(0, 6).map(([label, count]) => insightChip(label, count)).join('') || '<p>No recurring expectations detected yet.</p>'}</div>
      ${education.length ? `<p class="insight-note">Education mentioned: ${education.map(([label, count]) => `<strong>${escapeHtml(label)}</strong> (${count})`).join(' · ')}</p>` : ''}
    </article>
  `;
}

function dateNumber(value = '') {
  if (!value) return 0;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function formatStoredDate(value = '') {
  const timestamp = dateNumber(value);
  return timestamp ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(timestamp)) : '';
}

function sortJobs(jobs) {
  const sort = $('#sort-jobs').value;
  return [...jobs].sort((left, right) => {
    if (sort === 'company_asc') return String(left.company || '').localeCompare(String(right.company || '')) || String(left.title).localeCompare(String(right.title));
    if (sort === 'title_asc') return String(left.title).localeCompare(String(right.title));
    if (sort === 'posting_desc') {
      return (dateNumber(right.structuredDetails?.postedDate) || dateNumber(right.created_at)) -
        (dateNumber(left.structuredDetails?.postedDate) || dateNumber(left.created_at));
    }
    if (sort === 'updated_desc') return dateNumber(right.updated_at) - dateNumber(left.updated_at);
    return dateNumber(right.created_at) - dateNumber(left.created_at);
  });
}

function filteredJobs() {
  const query = $('#search').value.trim().toLowerCase();
  const status = $('#status-filter').value;
  const interest = $('#interest-filter').value;
  const jobs = state.jobs.filter((job) => {
    if (state.quickFilter === 'needs_details' && job.description) return false;
    if (state.quickFilter === 'saved' && !['saved', 'considering'].includes(job.status)) return false;
    if (state.quickFilter === 'applied' && job.status !== 'applied') return false;
    if (state.quickFilter === 'in_progress' && !['screening', 'interviewing', 'offer'].includes(job.status)) return false;
    if (status && job.status !== status) return false;
    if (interest && (job.interest_status || 'unreviewed') !== interest) return false;
    if (!query) return true;
    const insights = jobSeekerInsights(job);
    return [job.title, job.company, job.location, job.notes, job.interest_note, job.description,
      ...(insights.skills || []).map(({ name }) => name), ...(insights.attributes || [])]
      .some((value) => String(value || '').toLowerCase().includes(query));
  });
  return sortJobs(jobs);
}

function jobCard(job) {
  const detailsLabel = job.description ? '' : '<span class="status-pill needs-details">Needs details</span>';
  const applicationsClosed = /no longer|not accepting|closed|expired|filled/i.test(job.structuredDetails?.listingStatus || '');
  const interestStatus = job.interest_status || 'unreviewed';
  const interestLabel = interestStatus === 'follow_up' ? 'Follow up' : (interestStatus === 'not_interested' ? 'Not interested' : '');
  const interestBadge = interestLabel ? `<span class="status-pill interest-${escapeHtml(interestStatus.replace('_', '-'))}">${escapeHtml(interestLabel)}</span>` : '';
  const arrangement = job.work_arrangement || (/\b(remote|hybrid|on[- ]site)\b/i.exec(job.location || '')?.[1] ?? '');
  const postingDate = formatDate(job.structuredDetails?.postedDate);
  const addedDate = formatStoredDate(job.created_at);
  return `
    <article class="job-card" tabindex="0" role="button" data-job-id="${job.id}" aria-label="Open ${escapeHtml(job.title)} at ${escapeHtml(job.company || 'unknown company')}">
      <div class="job-card-top">
        <span class="status-pill status-${escapeHtml(job.status)}">${escapeHtml(titleCase(job.status))}</span>
        <span class="job-card-badges">${interestBadge}${applicationsClosed ? '<span class="status-pill listing-closed">Applications closed</span>' : ''}${detailsLabel}</span>
      </div>
      <h3>${escapeHtml(job.title)}</h3>
      <p class="company-name">${escapeHtml(job.company || 'Company not identified')}</p>
      <div class="job-meta">
        ${job.location ? `<span>⌖ ${escapeHtml(job.location)}</span>` : ''}
        ${arrangement ? `<span>◌ ${escapeHtml(titleCase(arrangement))}</span>` : ''}
        ${job.salary ? `<span>${escapeHtml(job.salary)}</span>` : ''}
        ${postingDate ? `<span>Posted ${escapeHtml(postingDate)}</span>` : (addedDate ? `<span>Added ${escapeHtml(addedDate)}</span>` : '')}
        ${interestLabel && job.interest_note ? `<span class="interest-note">${escapeHtml(job.interest_note)}</span>` : ''}
      </div>
    </article>
  `;
}

function renderJobs() {
  const jobs = filteredJobs();
  const list = $('#job-list');
  const empty = $('#empty-state');
  const hasFilters = $('#search').value || $('#status-filter').value || $('#interest-filter').value || state.quickFilter !== 'all';

  if (!jobs.length) {
    list.innerHTML = hasFilters ? '<p class="warning">No jobs match the current filters.</p>' : '';
    empty.classList.toggle('hidden', Boolean(hasFilters));
    return;
  }
  empty.classList.add('hidden');

  if (!$('#group-company').checked) {
    list.innerHTML = `<div class="job-cards">${jobs.map(jobCard).join('')}</div>`;
    return;
  }

  const groups = new Map();
  for (const job of jobs) {
    const name = job.company || 'Company not identified';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(job);
  }
  list.innerHTML = [...groups.entries()].map(([company, companyJobs]) => `
    <section class="company-group">
      <header class="company-group-header">
        <span class="company-monogram">${escapeHtml(monogram(company))}</span>
        <div><h2>${escapeHtml(company)}</h2><span>${companyJobs.length} ${companyJobs.length === 1 ? 'opportunity' : 'opportunities'}</span></div>
      </header>
      <div class="job-cards">${companyJobs.map(jobCard).join('')}</div>
    </section>
  `).join('');
}

function renderAll() {
  renderStats();
  renderInsights();
  renderJobs();
  renderFieldList();
}

function setQuickFilter(filter) {
  state.quickFilter = filter;
  $('#search').value = '';
  $('#status-filter').value = '';
  $('#interest-filter').value = '';
  renderStats();
  renderJobs();
}

function openImport() {
  state.importSource = { plainText: '', html: '' };
  state.importResult = null;
  $('#import-paste').textContent = '';
  $('#import-paste-status').textContent = 'Nothing pasted yet';
  $('#import-paste-step').classList.remove('hidden');
  $('#import-preview-step').classList.add('hidden');
  $('#analyze-import').classList.remove('hidden');
  $('#commit-import').classList.add('hidden');
  $('#import-dialog').showModal();
  setTimeout(() => $('#import-paste').focus(), 30);
}

function renderWarnings(container, warnings = []) {
  container.innerHTML = warnings.map((warning) => `<p class="warning">${escapeHtml(warning)}</p>`).join('');
}

function renderImportPreview(result) {
  const jobs = result.jobs || (result.details ? [result.details] : []);
  state.importResult = { ...result, jobs };
  $('#preview-title').textContent = `${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'} found`;
  renderWarnings($('#import-warnings'), result.warnings || []);
  $('#import-preview-list').innerHTML = jobs.map((job, index) => `
    <article class="preview-card" data-preview-index="${index}">
      <input type="checkbox" checked aria-label="Import ${escapeHtml(job.title || 'this job')}">
      <div class="preview-fields">
        <label>Position<input data-field="title" value="${escapeHtml(job.title || '')}"></label>
        <label>Company<input data-field="company" value="${escapeHtml(job.company || '')}"></label>
        <label>Location<input data-field="location" value="${escapeHtml(job.location || '')}"></label>
        <label>LinkedIn URL<input data-field="jobUrl" type="url" value="${escapeHtml(job.jobUrl || '')}"></label>
      </div>
    </article>
  `).join('');
  $('#import-paste-step').classList.add('hidden');
  $('#import-preview-step').classList.remove('hidden');
  $('#analyze-import').classList.add('hidden');
  $('#commit-import').classList.remove('hidden');
}

async function analyzeImport() {
  const button = $('#analyze-import');
  if (!state.importSource.plainText && !state.importSource.html) {
    toast('Paste a LinkedIn alert first.', 'error');
    return;
  }
  setBusy(button, true, 'Analyzing…');
  try {
    const result = await api('/api/parse', {
      method: 'POST',
      body: JSON.stringify({ ...state.importSource, mode: 'alert' }),
    });
    renderImportPreview(result);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

function collectImportJobs() {
  return $$('.preview-card', $('#import-preview-list')).flatMap((card) => {
    if (!$('input[type="checkbox"]', card).checked) return [];
    const original = state.importResult.jobs[Number(card.dataset.previewIndex)];
    const value = (field) => $(`[data-field="${field}"]`, card).value.trim();
    return [{
      ...original,
      title: value('title'),
      company: value('company'),
      location: value('location'),
      jobUrl: value('jobUrl'),
    }];
  });
}

async function commitImport() {
  const jobs = collectImportJobs();
  if (!jobs.length) return toast('Select at least one job to import.', 'error');
  const button = $('#commit-import');
  setBusy(button, true, 'Importing…');
  try {
    const { results } = await api('/api/import', {
      method: 'POST',
      body: JSON.stringify({
        ...state.importSource,
        sourceType: state.importResult.detectedType || 'pasted_alert',
        jobs,
      }),
    });
    $('#import-dialog').close();
    await loadData();
    const created = results.filter((result) => result.action === 'created').length;
    const updated = results.length - created;
    toast(`${created} job${created === 1 ? '' : 's'} added${updated ? ` · ${updated} existing updated` : ''}.`);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

function customFieldControl(field, value) {
  const common = `data-custom-key="${escapeHtml(field.key)}"`;
  if (field.type === 'checkbox') {
    return `<label>${escapeHtml(field.label)}<select ${common}><option value="false" ${value ? '' : 'selected'}>No</option><option value="true" ${value ? 'selected' : ''}>Yes</option></select></label>`;
  }
  if (field.type === 'select') {
    return `<label>${escapeHtml(field.label)}<select ${common}><option value="">—</option>${field.options.map((option) => `<option value="${escapeHtml(option)}" ${String(value) === String(option) ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}</select></label>`;
  }
  if (field.type === 'long_text') {
    return `<label class="span-two">${escapeHtml(field.label)}<textarea rows="3" ${common}>${escapeHtml(value || '')}</textarea></label>`;
  }
  const inputType = ({ number: 'number', date: 'date', url: 'url' })[field.type] || 'text';
  return `<label>${escapeHtml(field.label)}<input type="${inputType}" ${common} value="${escapeHtml(value ?? '')}"></label>`;
}

function fillJobForm(job) {
  const form = $('#job-shell');
  const fields = ['title', 'company', 'location', 'status', 'interestStatus', 'interestNote', 'workArrangement', 'employmentType', 'seniority', 'salary', 'jobUrl', 'notes', 'description'];
  const values = {
    ...job,
    interestStatus: job.interest_status || 'unreviewed',
    interestNote: job.interest_note || '',
    workArrangement: job.work_arrangement || '',
    employmentType: job.employment_type || '',
    jobUrl: job.job_url || '',
  };
  for (const field of fields) form.elements.namedItem(field).value = values[field] || '';
  syncOpenJobLink();
  syncOpenCompanyLink(job.companyProfile?.linkedinUrl || '');
  renderStructuredDetails(job);
  syncDescriptionCapture(job);

  const customFields = state.fields.filter((field) => field.scope === 'job');
  $('#custom-field-section').classList.toggle('hidden', !customFields.length);
  $('#job-custom-fields').innerHTML = customFields.map((field) => customFieldControl(field, job.customFields?.[field.key])).join('');
}

function syncOpenCompanyLink(url = '') {
  const link = $('#open-company-link');
  const isLinkedInCompanyUrl = /^https:\/\/(?:[a-z]+\.)?linkedin\.com\/company\//i.test(url);
  link.classList.toggle('hidden', !isLinkedInCompanyUrl);
  link.href = isLinkedInCompanyUrl ? url : '#';
}

function syncOpenJobLink() {
  const value = $('#job-url').value.trim();
  const link = $('#open-job-link');
  const isWebUrl = /^https?:\/\//i.test(value);
  link.classList.toggle('hidden', !isWebUrl);
  link.href = isWebUrl ? value : '#';
}

function syncDescriptionCapture(job) {
  const needsDetails = !String(job.description || '').trim();
  $('#job-description-title').textContent = needsDetails ? 'Add job details' : 'Job description';
  $('#job-description-subtitle').textContent = needsDetails
    ? 'Paste the full posting here to capture the description and structured details.'
    : 'Saved here even if the listing disappears.';
  $('#job-description-editor').classList.toggle('hidden', needsDetails);
  $('#toggle-enrich').classList.toggle('hidden', needsDetails);
  $('#enrich-panel').classList.toggle('hidden', !needsDetails);
  $('#enrich-panel').classList.toggle('missing-details', needsDetails);
}

function renderStructuredDetails(job) {
  const details = job.structuredDetails || {};
  const profile = job.companyProfile || {};
  const seeker = jobSeekerInsights(job);
  const facts = [
    ['Posting date', formatPostingDate(details.postedDate, details.postedAgo)], ['Applicant activity', details.applicantActivity],
    ['Listing status', details.listingStatus],
    ['Application deadline', formatDate(details.applicationDeadline)],
    ['Application method', details.applicationMethod], ['Job type', details.jobType],
    ['Shift', details.shift], ['Primary location', details.primaryLocation],
    ['Additional locations', details.additionalLocations], ['Position of trust', details.positionOfTrust],
    ['Schedule', details.scheduleType?.split(/[.\n]/)[0]],
    ['Employee growth', details.applicantInsights?.employeeGrowth],
    ['Applicant education', details.applicantInsights?.education],
    ['Applicant seniority', details.applicantInsights?.seniority],
  ].filter(([, value]) => value);
  const standardSections = [
    ['Overview', details.overview],
    ['Posting information', details.postingInformation],
    ['Responsibilities', details.responsibilities],
    ['Core competencies', details.coreCompetencies],
    ['Qualification summary', details.qualificationSummary],
    ['Minimum qualifications', details.minimumQualifications],
    ['Preferred qualifications', details.preferredQualifications],
    ['Team', details.team],
    ['Incentive compensation', details.incentiveCompensation],
    ['Compensation details', details.compensationDetails],
    ['Benefits', details.benefits],
    ['Work location', details.workLocation],
    ['Work model', details.workModel],
    ['Additional information', details.additionalInformation],
    ['Posting statement', details.postingStatement],
  ].filter(([, value]) => value);
  const sections = Array.isArray(details.sections) && details.sections.length
    ? details.sections.map((section) => [section.heading, section.content])
    : standardSections;
  const companyFacts = [profile.industry, profile.companySize, profile.followers, profile.linkedInEmployees].filter(Boolean).join(' · ');
  const seekerSummary = [
    seeker.minimumExperienceYears ? `${seeker.minimumExperienceYears}+ years experience` : '',
    ...(seeker.education || []),
    seeker.travelRequirement ? `${seeker.travelRequirement} travel` : '',
  ].filter(Boolean);
  const hasSeekerInsights = (seeker.skills || []).length || (seeker.attributes || []).length || seekerSummary.length;
  const hasContent = hasSeekerInsights || facts.length || sections.length || companyFacts || profile.description;
  $('#structured-detail-section').classList.toggle('hidden', !hasContent);
  $('#structured-job-details').innerHTML = hasContent ? `
    ${hasSeekerInsights ? `<article class="captured-section job-seeker-card"><h4>Job seeker insights</h4>${seekerSummary.length ? `<p class="seeker-summary">${seekerSummary.map((value) => `<strong>${escapeHtml(value)}</strong>`).join('')}</p>` : ''}${(seeker.skills || []).length ? `<div class="insight-tags">${seeker.skills.map(({ name, category }) => `<span class="insight-tag" title="${escapeHtml(category)}">${escapeHtml(name)}</span>`).join('')}</div>` : ''}${(seeker.attributes || []).length ? `<p class="seeker-attributes">Also emphasizes: ${escapeHtml(seeker.attributes.join(' · '))}</p>` : ''}</article>` : ''}
    ${facts.length ? `<div class="detail-facts">${facts.map(([label, value]) => `<div class="detail-fact"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}</div>` : ''}
    ${sections.map(([label, value]) => `<article class="captured-section"><h4>${escapeHtml(label)}</h4><p>${escapeHtml(value)}</p></article>`).join('')}
    ${(companyFacts || profile.description) ? `<article class="captured-section company-profile-card"><h4>Company profile</h4>${companyFacts ? `<p><strong>${escapeHtml(companyFacts)}</strong></p>` : ''}${profile.description ? `<p>${escapeHtml(profile.description)}</p>` : ''}</article>` : ''}
  ` : '';
}

async function openJob(id) {
  const job = state.jobs.find((candidate) => candidate.id === Number(id));
  if (!job) return;
  state.selectedJob = job;
  state.detailSource = { plainText: '', html: '' };
  state.enrichResult = null;
  $('#job-company-monogram').textContent = monogram(job.company || '');
  $('#job-company-kicker').textContent = (job.company || 'Company not identified').toUpperCase();
  $('#job-dialog-title').textContent = job.title;
  $('#job-dialog-subtitle').textContent = job.location || 'Location not captured';
  fillJobForm(job);
  $('#enrich-preview').classList.add('hidden');
  $('#apply-details').classList.add('hidden');
  $('#detail-paste').textContent = '';
  $('#enrich-warnings').innerHTML = '';
  $('#job-sources').classList.add('hidden');
  $('#job-sources').innerHTML = '';
  $('#toggle-sources').textContent = 'Show sources';
  $('#job-dialog').showModal();
}

function collectCustomFields() {
  const values = {};
  $$('[data-custom-key]', $('#job-custom-fields')).forEach((input) => {
    const definition = state.fields.find((field) => field.key === input.dataset.customKey);
    let value = input.value;
    if (definition?.type === 'checkbox') value = value === 'true';
    if (definition?.type === 'number' && value !== '') value = Number(value);
    values[input.dataset.customKey] = value;
  });
  return values;
}

async function saveJob() {
  const form = $('#job-shell');
  const button = $('#save-job');
  const value = (name) => form.elements.namedItem(name).value.trim();
  setBusy(button, true, 'Saving…');
  try {
    await api(`/api/jobs/${state.selectedJob.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        title: value('title'), company: value('company'), location: value('location'), status: value('status'),
        interestStatus: value('interestStatus'), interestNote: value('interestNote'),
        workArrangement: value('workArrangement'), employmentType: value('employmentType'), seniority: value('seniority'),
        salary: value('salary'), jobUrl: value('jobUrl'), notes: value('notes'), description: value('description'),
        customFields: collectCustomFields(),
      }),
    });
    $('#job-dialog').close();
    await loadData();
    toast('Job updated.');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

function renderEnrichPreview(result) {
  state.enrichResult = result;
  const details = result.details;
  const structured = details.structuredDetails || {};
  const capturedSections = (Array.isArray(structured.sections) && structured.sections.length) ||
    [structured.responsibilities, structured.minimumQualifications, structured.preferredQualifications,
      structured.benefits, structured.workModel, details.companyDetails?.description].filter(Boolean).length;
  renderWarnings($('#enrich-warnings'), result.warnings || []);
  $('#enrich-preview').innerHTML = `
    <div class="enrich-summary">
      <div><span>Destination job</span><strong>${escapeHtml(state.selectedJob.title)} at ${escapeHtml(state.selectedJob.company || 'Company not identified')}</strong></div>
      <div><span>Identity fields</span><strong>Title, company, location, and URL will be retained</strong></div>
      <div><span>Listing location found</span><strong>${escapeHtml(details.location || 'Not found')}</strong></div>
      <label>Employment type<input data-enrich="employmentType" value="${escapeHtml(details.employmentType || '')}"></label>
      <label>Seniority<input data-enrich="seniority" value="${escapeHtml(details.seniority || '')}"></label>
      <label>Salary<input data-enrich="salary" value="${escapeHtml(details.salary || '')}"></label>
      <div><span>Posting date</span><strong>${escapeHtml(formatPostingDate(structured.postedDate, structured.postedAgo) || 'Not found')}</strong></div>
      <div><span>Listing status</span><strong>${escapeHtml(structured.listingStatus || 'Not found')}</strong></div>
      <div><span>Application deadline</span><strong>${escapeHtml(formatDate(structured.applicationDeadline) || 'Not found')}</strong></div>
      <div><span>Applicant activity</span><strong>${escapeHtml(structured.applicantActivity || 'Not found')}</strong></div>
      <div><span>Job type & shift</span><strong>${escapeHtml([structured.jobType, structured.shift].filter(Boolean).join(' · ') || 'Not found')}</strong></div>
      <div><span>Structured sections</span><strong>${capturedSections} captured</strong></div>
      <div><span>Description captured</span><strong>${(details.description || '').length.toLocaleString()} characters</strong></div>
      <div><span>Company profile captured</span><strong>${details.companyDetails?.description ? 'Yes' : 'Not found'}</strong></div>
    </div>
  `;
  $('#enrich-preview').classList.remove('hidden');
  $('#apply-details').classList.remove('hidden');
}

async function analyzeDetails() {
  if (!state.detailSource.plainText && !state.detailSource.html) return toast('Paste the job details first.', 'error');
  const button = $('#analyze-details');
  setBusy(button, true, 'Analyzing…');
  try {
    const result = await api('/api/parse', {
      method: 'POST', body: JSON.stringify({ ...state.detailSource, mode: 'details' }),
    });
    renderEnrichPreview(result);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function applyDetails() {
  const button = $('#apply-details');
  const details = structuredClone(state.enrichResult.details);
  $$('[data-enrich]', $('#enrich-preview')).forEach((input) => { details[input.dataset.enrich] = input.value.trim(); });
  Object.assign(details, {
    title: state.selectedJob.title,
    company: state.selectedJob.company,
    location: state.selectedJob.location,
    jobUrl: state.selectedJob.job_url,
    linkedinJobId: state.selectedJob.linkedin_job_id,
  });
  setBusy(button, true, 'Applying…');
  try {
    const { job } = await api(`/api/jobs/${state.selectedJob.id}/enrich`, {
      method: 'POST',
      body: JSON.stringify({ ...state.detailSource, sourceType: 'pasted_job_details', details }),
    });
    state.selectedJob = job;
    fillJobForm(job);
    $('#job-company-kicker').textContent = (job.company || 'Company not identified').toUpperCase();
    $('#job-dialog-title').textContent = job.title;
    $('#job-dialog-subtitle').textContent = job.location || 'Location not captured';
    $('#enrich-panel').classList.add('hidden');
    await loadData();
    toast('Job and company details added.');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function toggleSources() {
  const container = $('#job-sources');
  if (!container.classList.contains('hidden')) {
    container.classList.add('hidden');
    $('#toggle-sources').textContent = 'Show sources';
    return;
  }
  const { sources } = await api(`/api/jobs/${state.selectedJob.id}/sources`);
  container.innerHTML = sources.length ? sources.map((source) => `
    <details class="source-item">
      <summary>${escapeHtml(titleCase(source.source_type))} · ${escapeHtml(new Date(`${source.created_at}Z`).toLocaleString())}</summary>
      <pre>${escapeHtml(source.raw_text || '(Formatted source retained without a plain-text representation.)')}</pre>
    </details>
  `).join('') : '<p class="warning">No sources are associated with this job yet.</p>';
  container.classList.remove('hidden');
  $('#toggle-sources').textContent = 'Hide sources';
}

function renderFieldList() {
  const container = $('#field-list');
  if (!state.fields.length) {
    container.innerHTML = '<p class="warning">No custom fields yet. Add one below and it will appear on every job.</p>';
    return;
  }
  container.innerHTML = state.fields.map((field) => `
    <article class="field-item">
      <div><strong>${escapeHtml(field.label)}</strong><span>${escapeHtml(titleCase(field.type))}${field.options.length ? ` · ${escapeHtml(field.options.join(', '))}` : ''}</span></div>
      <button type="button" data-delete-field="${field.id}">Remove</button>
    </article>
  `).join('');
}

function openFields() {
  renderFieldList();
  $('#fields-dialog').showModal();
}

async function createField() {
  const label = $('#field-label').value.trim();
  if (!label) return toast('Enter a label for the custom field.', 'error');
  const type = $('#field-type').value;
  const options = type === 'select' ? $('#field-options').value.split(',').map((value) => value.trim()).filter(Boolean) : [];
  const button = $('#create-field');
  setBusy(button, true, 'Adding…');
  try {
    await api('/api/custom-fields', { method: 'POST', body: JSON.stringify({ scope: 'job', label, type, options }) });
    $('#field-label').value = '';
    $('#field-options').value = '';
    await loadData();
    toast('Custom field added.');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function removeField(id) {
  await api(`/api/custom-fields/${id}`, { method: 'DELETE' });
  await loadData();
  toast('Custom field removed from the interface. Existing stored values were left intact.');
}

capturePaste($('#import-paste'), 'importSource');
capturePaste($('#detail-paste'), 'detailSource');

['#open-import', '#sidebar-import', '#empty-import'].forEach((selector) => $(selector).addEventListener('click', openImport));
$('#manage-fields').addEventListener('click', openFields);
$('#fields-from-job').addEventListener('click', openFields);
$('#analyze-import').addEventListener('click', analyzeImport);
$('#commit-import').addEventListener('click', commitImport);
$('#back-to-paste').addEventListener('click', () => {
  $('#import-paste-step').classList.remove('hidden');
  $('#import-preview-step').classList.add('hidden');
  $('#analyze-import').classList.remove('hidden');
  $('#commit-import').classList.add('hidden');
});
$('#save-job').addEventListener('click', saveJob);
$('#toggle-enrich').addEventListener('click', () => {
  $('#enrich-panel').classList.toggle('hidden');
  if (!$('#enrich-panel').classList.contains('hidden')) setTimeout(() => $('#detail-paste').focus(), 20);
});
$('#analyze-details').addEventListener('click', analyzeDetails);
$('#apply-details').addEventListener('click', applyDetails);
$('#toggle-sources').addEventListener('click', () => toggleSources().catch((error) => toast(error.message, 'error')));
$('#create-field').addEventListener('click', createField);
$('#field-type').addEventListener('change', () => $('#field-options-label').classList.toggle('hidden', $('#field-type').value !== 'select'));
$('#search').addEventListener('input', renderJobs);
$('#status-filter').addEventListener('change', () => {
  state.quickFilter = 'all';
  renderStats();
  renderJobs();
});
$('#interest-filter').addEventListener('change', renderJobs);
$('#sort-jobs').addEventListener('change', renderJobs);
$('#group-company').addEventListener('change', renderJobs);
$('#filter-needs-details').addEventListener('click', () => setQuickFilter('needs_details'));
$('#filter-all-jobs').addEventListener('click', () => setQuickFilter('all'));
$('#filter-saved').addEventListener('click', () => setQuickFilter('saved'));
$('#filter-applied').addEventListener('click', () => setQuickFilter('applied'));
$('#filter-in-progress').addEventListener('click', () => setQuickFilter('in_progress'));
$('#job-url').addEventListener('input', syncOpenJobLink);

$('#market-insights').addEventListener('click', (event) => {
  const chip = event.target.closest('[data-insight-query]');
  if (!chip) return;
  state.quickFilter = 'all';
  $('#search').value = chip.dataset.insightQuery;
  $('#status-filter').value = '';
  $('#interest-filter').value = '';
  renderStats();
  renderJobs();
  $('.workspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

$('#job-list').addEventListener('click', (event) => {
  const card = event.target.closest('[data-job-id]');
  if (card) openJob(card.dataset.jobId);
});
$('#job-list').addEventListener('keydown', (event) => {
  const card = event.target.closest('[data-job-id]');
  if (card && ['Enter', ' '].includes(event.key)) {
    event.preventDefault();
    openJob(card.dataset.jobId);
  }
});
$('#field-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-delete-field]');
  if (button) removeField(Number(button.dataset.deleteField)).catch((error) => toast(error.message, 'error'));
});

loadData().catch((error) => {
  toast(`Could not load JobTracker: ${error.message}`, 'error');
  $('#empty-state').classList.remove('hidden');
});
