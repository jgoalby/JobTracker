import {
  cleanText,
  extractAnchors,
  extractMarkdownLinks,
  extractUrls,
  htmlToText,
  normalizeInput,
  textLines,
  uniqueBy,
} from './parser.mjs';

const noisePatterns = [
  /^view job$/i,
  /^apply( now)?$/i,
  /^save(d)?$/i,
  /^show more$/i,
  /^easy apply$/i,
  /^actively recruiting$/i,
  /^promoted$/i,
  /^linkedin$/i,
  /^see who .* hired/i,
  /^your job alert/i,
  /^jobs? you may be interested/i,
  /^new jobs? for/i,
  /^unsubscribe/i,
  /^manage alerts/i,
  /^you(?:'|’)?ll receive notifications/i,
  /^new jobs? .* match your preferences/i,
  /^this email was intended for/i,
  /^radar icon$/i,
  /^\d+\s+notifications?$/i,
  /^home$/i,
  /^my network$/i,
  /^jobs$/i,
  /^messaging$/i,
  /^notifications$/i,
  /^me$/i,
  /^for business$/i,
  /^retry for \$0$/i,
  /^company logo for\s*,/i,
];

function isNoise(line) {
  const normalized = normalizeLinkText(line);
  return !normalized || noisePatterns.some((pattern) => pattern.test(normalized));
}

function normalizeLinkText(value = '') {
  return cleanText(value)
    .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function unwrapLinkedInRedirect(rawUrl) {
  let url = rawUrl;
  try {
    const parsed = new URL(rawUrl);
    for (const parameter of ['url', 'dest', 'destination', 'redirect', 'redirectUrl']) {
      const value = parsed.searchParams.get(parameter);
      if (value?.includes('linkedin.com')) {
        url = decodeURIComponent(value);
        break;
      }
    }
  } catch {
    // Retain the original string when it is not a complete URL.
  }
  return url;
}

export function canonicalizeLinkedInJobUrl(rawUrl = '') {
  let candidate = unwrapLinkedInRedirect(rawUrl).replace(/&amp;/g, '&');
  try {
    const url = new URL(candidate);
    if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return null;
    const path = decodeURIComponent(url.pathname);
    const direct = path.match(/\/jobs\/view\/(?:[^/?#]*?-)?(\d{6,})(?:[/?#]|$)/i);
    const comm = path.match(/\/comm\/jobs\/view\/(?:[^/?#]*?-)?(\d{6,})(?:[/?#]|$)/i);
    const jobId = direct?.[1] || comm?.[1] || url.searchParams.get('currentJobId');
    if (!jobId || !/^\d+$/.test(jobId)) return null;
    return {
      jobUrl: `https://www.linkedin.com/jobs/view/${jobId}`,
      linkedinJobId: jobId,
    };
  } catch {
    const match = candidate.match(/linkedin\.com\/(?:comm\/)?jobs\/view\/(?:[^\s/?#]*?-)?(\d{6,})/i);
    return match ? {
      jobUrl: `https://www.linkedin.com/jobs/view/${match[1]}`,
      linkedinJobId: match[1],
    } : null;
  }
}

function canonicalizeLinkedInCompanyUrl(rawUrl = '') {
  try {
    const url = new URL(String(rawUrl).replace(/&amp;/g, '&'));
    if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return '';
    const match = decodeURIComponent(url.pathname).match(/^\/company\/([^/?#]+)/i);
    return match ? `https://www.linkedin.com/company/${match[1]}/` : '';
  } catch {
    return '';
  }
}

function inferLocation(line = '') {
  if (/^company\s*,/i.test(line)) return '';
  if (/\b(remote|hybrid|on[- ]site)\b/i.test(line)) return line;
  if (/^[^,]{2,60},\s*[^,]{2,40}(?:,\s*[^,]{2,30})?$/.test(line)) return line;
  if (/\b(United States|United Kingdom|Canada|Australia|Europe|EMEA)\b/i.test(line)) return line;
  return '';
}

function inferFromContext(title, contextText) {
  const lines = textLines(contextText).filter((line) => !isNoise(line));
  const titleIndex = lines.findIndex((line) => title && line.toLowerCase().includes(title.toLowerCase()));
  const afterTitle = lines.slice(Math.max(0, titleIndex + 1), Math.max(0, titleIndex + 7));
  let company = '';
  let location = '';
  for (const line of afterTitle) {
    if (!location && inferLocation(line)) {
      location = line;
      continue;
    }
    if (!company && line.length <= 100 && !/\b(applicant|ago|hour|day|week|month|salary|remote|hybrid)\b/i.test(line)) {
      company = line;
    }
  }
  return { company, location };
}

function titleFromNearbyLines(lines, urlIndex) {
  const before = lines.slice(Math.max(0, urlIndex - 5), urlIndex).reverse();
  return before.find((line) => !isNoise(line) && line.length >= 3 && line.length <= 140 && !/^https?:/i.test(line)) || '';
}

function parseCompanyLocation(value = '') {
  const normalized = normalizeLinkText(value);
  const separator = normalized.search(/[·•⋅]/u);
  if (separator < 1) return null;

  const company = normalized.slice(0, separator).trim();
  const location = normalized.slice(separator + 1).trim();
  if (!company || !location || isNoise(company) || !inferLocation(location)) return null;
  return { company, location };
}

function companyLocationNearTitle(lines, title) {
  const normalizedTitle = normalizeLinkText(title).toLowerCase();
  if (!normalizedTitle) return null;

  const titleIndex = lines.findIndex((line) => normalizeLinkText(line).toLowerCase().includes(normalizedTitle));
  if (titleIndex < 0) return null;

  for (const line of lines.slice(titleIndex + 1, titleIndex + 5)) {
    const parsed = parseCompanyLocation(line);
    if (parsed) return parsed;
  }
  return null;
}

function probableCompanyBeforeTitle(lines, title) {
  const normalizedTitle = normalizeLinkText(title).toLowerCase();
  if (!normalizedTitle) return '';

  const titleIndex = lines.findIndex((line) => normalizeLinkText(line).toLowerCase().includes(normalizedTitle));
  if (titleIndex < 1) return '';

  const candidate = normalizeLinkText(lines[titleIndex - 1]);
  if (
    isNoise(candidate) ||
    parseCompanyLocation(candidate) ||
    inferLocation(candidate) ||
    candidate.length > 100 ||
    candidate.toLowerCase().includes(normalizedTitle) ||
    /[.!?]$/.test(candidate)
  ) return '';
  return candidate;
}

function jobsFromStructuredLinks(links, sourceText) {
  const groups = new Map();
  for (const link of links) {
    const linkedIn = canonicalizeLinkedInJobUrl(link.url);
    if (!linkedIn) continue;
    if (!groups.has(linkedIn.linkedinJobId)) groups.set(linkedIn.linkedinJobId, { linkedIn, links: [] });
    groups.get(linkedIn.linkedinJobId).links.push(link);
  }

  const lines = textLines(sourceText).map(normalizeLinkText);
  return [...groups.values()].map(({ linkedIn, links: groupedLinks }) => {
    const normalizedLinks = groupedLinks.map((link) => ({ ...link, text: normalizeLinkText(link.text) }));
    const companyLocationLink = normalizedLinks.find((link) => parseCompanyLocation(link.text));
    const companyLocation = parseCompanyLocation(companyLocationLink?.text || '') || {};
    const titleLink = normalizedLinks.find((link) =>
      !isNoise(link.text) &&
      !parseCompanyLocation(link.text) &&
      !/\bconnections?\b/i.test(link.text) &&
      link.text.length >= 3,
    );
    const nearbyCompanyLocation = titleLink ? companyLocationNearTitle(lines, titleLink.text) : null;
    const company = companyLocation.company || nearbyCompanyLocation?.company ||
      (titleLink ? probableCompanyBeforeTitle(lines, titleLink.text) : '');
    const location = companyLocation.location || nearbyCompanyLocation?.location || '';
    return {
      ...linkedIn,
      title: titleLink?.text || 'Untitled LinkedIn job',
      company,
      location,
      confidence: titleLink && company ? 0.98 : titleLink ? 0.82 : 0.55,
    };
  });
}

function markdownJobs(plainText) {
  return jobsFromStructuredLinks(extractMarkdownLinks(plainText), plainText);
}

export function parseLinkedInAlert(input) {
  const normalized = normalizeInput(input);
  const anchors = extractAnchors(normalized.html);
  const jobs = uniqueBy([
    ...markdownJobs(normalized.plainText),
    ...jobsFromStructuredLinks(anchors, htmlToText(normalized.html)),
  ], (job) => job.linkedinJobId || job.jobUrl);

  const allUrls = uniqueBy([
    ...extractUrls(normalized.plainText),
    ...anchors.map((anchor) => anchor.url),
  ], (url) => url);

  const plainLines = textLines(normalized.plainText);
  for (const rawUrl of allUrls) {
    const linkedIn = canonicalizeLinkedInJobUrl(rawUrl);
    if (!linkedIn || jobs.some((job) => job.linkedinJobId === linkedIn.linkedinJobId)) continue;
    const urlIndex = plainLines.findIndex((line) => line.includes(rawUrl) || line.includes(linkedIn.linkedinJobId));
    const title = titleFromNearbyLines(plainLines, urlIndex < 0 ? 0 : urlIndex);
    const inferred = inferFromContext(title, plainLines.slice(Math.max(0, urlIndex - 5), urlIndex + 5).join('\n'));
    jobs.push({
      ...linkedIn,
      title: title || 'Untitled LinkedIn job',
      company: inferred.company,
      location: inferred.location,
      confidence: title ? 0.72 : 0.5,
    });
  }

  return {
    detectedType: jobs.length > 1 ? 'linkedin_alert' : jobs.length === 1 ? 'linkedin_job_link' : 'unknown',
    jobs: uniqueBy(jobs, (job) => job.linkedinJobId || job.jobUrl),
    warnings: jobs.length ? [] : ['No LinkedIn job links were detected. Try copying the email with formatting, or paste a job description instead.'],
  };
}

function valueAfterLabel(lines, labels) {
  for (let index = 0; index < lines.length; index += 1) {
    for (const label of labels) {
      const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const inline = lines[index].match(new RegExp(`^${escapedLabel}\\s*[:·-]\\s*(.+)$`, 'i'));
      if (inline?.[1]) return inline[1].trim();
      if (new RegExp(`^${escapedLabel}\\s*[:·-]?$`, 'i').test(lines[index]) && lines[index + 1]) return lines[index + 1];
    }
  }
  return '';
}

function sectionBetween(text, startPatterns, endPatterns) {
  const lines = textLines(text);
  let start = lines.findIndex((line) => startPatterns.some((pattern) => pattern.test(line)));
  if (start < 0) return '';
  start += 1;
  let end = lines.slice(start).findIndex((line) => endPatterns.some((pattern) => pattern.test(line)));
  if (end < 0) end = lines.length - start;
  return cleanText(lines.slice(start, start + end).join('\n'));
}

function sectionFromLines(lines, startPatterns, endPatterns) {
  let start = lines.findIndex((line) => startPatterns.some((pattern) => pattern.test(line)));
  if (start < 0) return '';
  start += 1;
  const relativeEnd = lines.slice(start).findIndex((line) => endPatterns.some((pattern) => pattern.test(line)));
  const end = relativeEnd < 0 ? lines.length : start + relativeEnd;
  return cleanText(lines.slice(start, end).join('\n'));
}

const postingSectionAliases = [
  { key: 'overview', patterns: [/^inside the role$/i, /^about the role$/i, /^the role$/i, /^role overview$/i, /^job summary$/i, /^position summary$/i, /^job description$/i] },
  { key: 'postingInformation', patterns: [/^posting information$/i, /^posting details$/i] },
  { key: 'responsibilities', patterns: [/^key responsibilities$/i, /^responsibilities$/i, /^what you(?:'|’)ll do$/i, /^what you will do$/i, /^work you(?:'|’)ll do$/i, /^work you will do$/i, /^your responsibilities$/i, /^the impact you will make$/i, /^strategy & stakeholder partnership$/i, /^analytics & data science$/i, /^software & data engineering$/i, /^people leadership$/i] },
  { key: 'minimumQualifications', patterns: [/^minimum qualifications$/i, /^required qualifications$/i, /^requirements$/i, /^required$/i, /^knowledge you should bring$/i, /^what you bring$/i, /^what we(?:'|’)re looking for$/i, /^what we are looking for$/i] },
  { key: 'preferredQualifications', patterns: [/^preferred qualifications$/i, /^preferred$/i, /^exceptional candidates$/i, /^nice to have$/i, /^nice-to-have$/i, /^bonus points$/i, /^preferred experience$/i] },
  { key: 'coreCompetencies', patterns: [/^core competencies$/i, /^behavioral competencies$/i, /^competencies$/i, /^skills and competencies$/i, /^a successful candidate would possess these skills$/i] },
  { key: 'team', patterns: [/^the team$/i, /^about the team$/i, /^our team$/i] },
  { key: 'benefits', patterns: [/^benefits$/i, /^we take care of our team$/i, /^compensation and benefits$/i, /^what we offer$/i, /^benefits found in job post$/i] },
  { key: 'workLocation', patterns: [/^where we work$/i, /^work location$/i, /^workplace location$/i] },
  { key: 'workModel', patterns: [/^work model for this role$/i, /^work model$/i, /^working model$/i] },
  { key: 'scheduleType', patterns: [/^schedule type$/i, /^work schedule$/i] },
  { key: 'additionalInformation', patterns: [/^additional information$/i, /^other information$/i] },
  { key: 'postingStatement', patterns: [/^posting statement$/i, /^equal opportunity$/i] },
  { key: 'qualificationSummary', patterns: [/^qualifications$/i] },
  { key: 'jobType', patterns: [/^job type$/i] },
  { key: 'shift', patterns: [/^shift$/i] },
  { key: 'primaryLocation', patterns: [/^primary location$/i] },
  { key: 'additionalLocations', patterns: [/^additional locations$/i] },
  { key: 'positionOfTrust', patterns: [/^position of trust$/i] },
  { key: 'incentiveCompensation', patterns: [/^incentive compensation$/i] },
  { key: 'compensationDetails', patterns: [/^compensation details$/i] },
];

function normalizedHeading(line = '') {
  return normalizeLinkText(line).replace(/:\s*$/, '');
}

function canonicalSectionKey(line = '') {
  const heading = normalizedHeading(line);
  return postingSectionAliases.find(({ patterns }) => patterns.some((pattern) => pattern.test(heading)))?.key || '';
}

function looksLikePostingHeading(line = '') {
  const heading = normalizedHeading(line);
  if (canonicalSectionKey(heading)) return true;
  if (heading.length < 3 || heading.length > 80 || /[\d$@]|[.,;!?]$|[,;]/.test(heading)) return false;
  const words = heading.split(/\s+/).filter(Boolean);
  if (words.length > 9) return false;
  const allowedLowercase = new Set(['a', 'an', 'and', 'as', 'at', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
  const meaningful = words.filter((word) => !allowedLowercase.has(word.toLowerCase()));
  return meaningful.length > 0 && meaningful.every((word) =>
    /^[A-Z][\p{L}\p{N}'’/&+()-]*$/u.test(word) || /^[A-Z0-9/&+.-]{2,}$/u.test(word),
  );
}

function postingSections(lines) {
  const headings = lines.flatMap((line, index) => {
    if (looksLikePostingHeading(line)) return [{ index, contentStart: index + 1, heading: normalizedHeading(line) }];
    if (/^you may also be eligible to participate in .*incentive/i.test(line)) {
      return [{ index, contentStart: index, heading: 'Incentive compensation' }];
    }
    if (/^(?:the )?(?:wage|salary|compensation) range for this role/i.test(line)) {
      return [{ index, contentStart: index, heading: 'Compensation details' }];
    }
    return [];
  });
  const sections = [];
  const firstHeadingIndex = headings[0]?.index ?? lines.length;
  const preamble = cleanText(lines.slice(0, firstHeadingIndex).join('\n'));
  if (preamble) sections.push({ key: 'overview', heading: 'Overview', content: preamble });

  for (let index = 0; index < headings.length; index += 1) {
    const current = headings[index];
    const nextIndex = headings[index + 1]?.index ?? lines.length;
    const content = cleanText(lines.slice(current.contentStart, nextIndex).join('\n'));
    if (!content) continue;
    sections.push({
      key: canonicalSectionKey(current.heading) || 'other',
      heading: current.heading,
      content,
    });
  }
  return sections;
}

function sectionContent(sections, key) {
  return cleanText(sections.filter((section) => section.key === key).map((section) => section.content).join('\n'));
}

function lineValue(lines, labels) {
  return valueAfterLabel(lines, labels);
}

function linkedinPageHeader(lines) {
  const companyMarkerIndex = lines.findIndex((line) => /^company(?: logo for)?\s*,\s*.+/i.test(line));
  if (companyMarkerIndex >= 0) {
    const markerLine = lines[companyMarkerIndex];
    const company = markerLine.replace(/^company(?: logo for)?\s*,\s*/i, '').replace(/\.$/, '').trim();
    const afterMarker = lines.slice(companyMarkerIndex + 1, companyMarkerIndex + 7);
    const companyLocation = afterMarker.map(parseCompanyLocation).find(Boolean);
    const title = afterMarker.find((line) =>
      !isNoise(line) && line.toLowerCase() !== company.toLowerCase() && !parseCompanyLocation(line) &&
      !inferLocation(line.split(/\s*[·•⋅]\s*/)[0]),
    ) || '';
    const locationLine = afterMarker.find((line) => inferLocation(line.split(/\s*[·•⋅]\s*/)[0]));
    return {
      title,
      company: companyLocation?.company || company,
      location: companyLocation?.location || locationLine?.split(/\s*[·•⋅]\s*/)[0].trim() || '',
    };
  }

  const activityIndex = lines.findIndex((line) => /\bpeople (?:clicked )?apply\b/i.test(line));
  if (activityIndex >= 2) {
    const location = lines[activityIndex].split(/\s*[·•⋅]\s*/)[0].trim();
    const title = lines[activityIndex - 1];
    const company = lines[activityIndex - 2];
    if (!isNoise(title) && !isNoise(company) && inferLocation(location)) return { title, company, location };
  }
  return null;
}

function listingMetadata(lines) {
  const activityLine = lines.find((line) => /\bpeople (?:clicked )?apply\b/i.test(line)) || '';
  const activityParts = activityLine.split(/\s*[·•⋅]\s*/).map((part) => part.trim());
  const promotionLine = lines.find((line) => /promoted by hirer|responses managed|easy apply/i.test(line)) || '';
  const listingStatus = lines.find((line) =>
    /^(?:no longer|not currently|not) accepting applications$/i.test(line) ||
    /^(?:applications? (?:are )?closed|position (?:is )?filled|job (?:is )?expired)$/i.test(line),
  ) || '';
  const deadlineLine = lines.find((line) =>
    /recruiting for this role ends|applications? (?:close|end)|application deadline|apply by|closing date/i.test(line),
  ) || '';
  return {
    postedAgo: activityParts.find((part) => /\bago\b/i.test(part)) || '',
    applicantActivity: activityParts.find((part) => /\bpeople (?:clicked )?apply\b/i.test(part)) || '',
    promotedBy: promotionLine.match(/promoted by hirer/i)?.[0] || '',
    applicationMethod: /easy apply/i.test(promotionLine) ? 'Easy Apply' :
      (promotionLine.match(/responses managed (?:off|on) LinkedIn/i)?.[0] || ''),
    listingStatus,
    applicationDeadline: dateFromText(deadlineLine),
  };
}

function localIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateFromText(value = '') {
  const month = 'January|February|March|April|May|June|July|August|September|October|November|December';
  const match = String(value).match(new RegExp(`\\b(?:${month})\\s+\\d{1,2},\\s+\\d{4}\\b`, 'i'));
  if (!match) return '';
  const date = new Date(`${match[0]} 12:00:00`);
  return Number.isNaN(date.getTime()) ? '' : localIsoDate(date);
}

export function calculatePostingDate(relativeValue = '', capturedAt = new Date()) {
  const value = normalizeLinkText(relativeValue).replace(/^reposted\s+/i, '').toLowerCase();
  if (!value) return '';

  const date = new Date(capturedAt);
  if (Number.isNaN(date.getTime())) return '';
  date.setHours(12, 0, 0, 0);
  if (/^(today|just now|\d+\s+(?:minutes?|hours?)\s+ago)$/.test(value)) return localIsoDate(date);
  if (value === 'yesterday') {
    date.setDate(date.getDate() - 1);
    return localIsoDate(date);
  }

  const match = value.match(/^(\d+)\s+(days?|weeks?|months?|years?)\s+ago$/);
  if (!match) return '';
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit.startsWith('day')) date.setDate(date.getDate() - amount);
  if (unit.startsWith('week')) date.setDate(date.getDate() - amount * 7);
  if (unit.startsWith('month')) date.setMonth(date.getMonth() - amount);
  if (unit.startsWith('year')) date.setFullYear(date.getFullYear() - amount);
  return localIsoDate(date);
}

function companyProfile(lines) {
  const start = lines.findIndex((line) => /^about the company$/i.test(line));
  if (start < 0) return { description: '', website: '', industry: '', companySize: '' };
  const profileLines = lines.slice(start + 1);
  const labeledIndustry = lineValue(profileLines, ['industry', 'industries']);
  const labeledCompanySize = lineValue(profileLines, ['company size']);
  const hasLinkedInMetrics = profileLines.some((line) => /\b(followers?|on LinkedIn)\b/i.test(line));
  if (!hasLinkedInMetrics && (labeledIndustry || labeledCompanySize)) {
    const end = profileLines.findIndex((line) => /^(industry|industries|company size|website|company website)\s*[:·-]?$/i.test(line));
    return {
      company: '',
      description: cleanText(profileLines.slice(0, end < 0 ? profileLines.length : end).join('\n')),
      website: lineValue(profileLines, ['website', 'company website']),
      industry: labeledIndustry,
      companySize: labeledCompanySize,
      followers: '',
      linkedInEmployees: '',
    };
  }
  const company = profileLines[0] || '';
  const followers = profileLines.find((line) => /^[\d,.]+\s+followers?$/i.test(line)) || '';
  const companySize = profileLines.find((line) => /\b[\d,+–-]+\s+employees\b/i.test(line)) || '';
  const linkedInEmployees = profileLines.find((line) => /\b[\d,.]+\s+on LinkedIn\b/i.test(line)) || '';
  const industry = profileLines.slice(1, 10).find((line) =>
    !/^follow$/i.test(line) && line !== followers && line !== companySize && line !== linkedInEmployees &&
    !/\b(followers?|employees|on LinkedIn)\b/i.test(line),
  ) || '';
  const descriptionStart = profileLines.findIndex((line, index) =>
    index > 0 && line !== followers && line !== companySize && line !== linkedInEmployees && line !== industry &&
    !/^follow$/i.test(line),
  );
  const descriptionLines = descriptionStart < 0 ? [] : profileLines.slice(descriptionStart);
  const descriptionEnd = descriptionLines.findIndex((line) =>
    /^need help|^interested in working|^company photos$|^show more$|^more jobs$/i.test(line),
  );
  const description = cleanText(descriptionLines.slice(0, descriptionEnd < 0 ? descriptionLines.length : descriptionEnd).join('\n'));

  return { company, description, website: '', industry, companySize, followers, linkedInEmployees };
}

function inferHeader(lines) {
  const candidates = lines.slice(0, 14).filter((line) => !isNoise(line));
  const title = candidates.find((line) =>
    line.length >= 4 && line.length <= 140 &&
    !inferLocation(line) &&
    !/\b(applicant|ago|followers?|employees?|connections?)\b/i.test(line) &&
    !/^about\b/i.test(line),
  ) || '';
  const titleIndex = candidates.indexOf(title);
  const company = candidates.slice(titleIndex + 1).find((line) =>
    line.length <= 100 && !inferLocation(line) && !/\b(applicant|ago|followers?|employees?)\b/i.test(line),
  ) || '';
  const location = candidates.find((line) => inferLocation(line)) || '';
  return { title, company, location };
}

const skillDefinitions = [
  ['Python', 'Languages', [/\bpython\b/i]],
  ['SQL', 'Languages', [/\bsql\b/i, /structured query language/i]],
  ['JavaScript', 'Languages', [/\bjavascript\b/i]],
  ['TypeScript', 'Languages', [/\btypescript\b/i]],
  ['Java', 'Languages', [/\bjava\b/i]],
  ['C#', 'Languages', [/\bc#(?!\w)/i]],
  ['C++', 'Languages', [/\bc\+\+(?!\+)/i]],
  ['Go', 'Languages', [/\bgolang\b/i, /\bgo programming\b/i]],
  ['HTML/CSS', 'Languages', [/\bhtml\b/i, /hypertext markup language/i, /cascading style sheets/i]],
  ['Node.js', 'Frameworks', [/\bnode(?:\.js|js)\b/i]],
  ['React', 'Frameworks', [/\breact(?:\.js|js)?\b/i]],
  ['Angular', 'Frameworks', [/\bangular\b/i]],
  ['Machine learning', 'AI & data science', [/\bmachine learning\b/i]],
  ['Generative AI', 'AI & data science', [/\bgenerative (?:artificial intelligence|ai)\b/i, /\bgenai\b/i]],
  ['Large language models', 'AI & data science', [/\blarge language models?\b/i, /\bllms?\b/i]],
  ['Agentic AI', 'AI & data science', [/\bagentic (?:artificial intelligence|ai)\b/i, /\bai agents?\b/i]],
  ['RAG', 'AI & data science', [/\bretrieval[- ]augmented generation\b/i, /\brag\b/i]],
  ['NLP', 'AI & data science', [/\bnatural language processing\b/i, /\bnlp\b/i]],
  ['Computer vision', 'AI & data science', [/\bcomputer vision\b/i]],
  ['Deep learning', 'AI & data science', [/\bdeep learning\b/i]],
  ['Data science', 'AI & data science', [/\bdata science\b/i]],
  ['Statistics', 'AI & data science', [/\bstatistical (?:analysis|modeling|methods?)\b/i, /\bstatistics\b/i]],
  ['Spark', 'Data engineering', [/\bapache spark\b/i, /\bspark\b/i]],
  ['Databricks', 'Data engineering', [/\bdatabricks\b/i]],
  ['Snowflake', 'Data engineering', [/\bsnowflake\b/i]],
  ['ETL', 'Data engineering', [/\bextract,? transform,? (?:and )?load\b/i, /\betl\b/i]],
  ['Data pipelines', 'Data engineering', [/\bdata pipelines?\b/i, /\bpipeline (?:design|architecture|orchestration)\b/i]],
  ['PostgreSQL', 'Data engineering', [/\bpostgres(?:ql)?\b/i]],
  ['MongoDB', 'Data engineering', [/\bmongodb\b/i]],
  ['AWS', 'Cloud & infrastructure', [/\bamazon web services\b/i, /\baws\b/i]],
  ['Azure', 'Cloud & infrastructure', [/\bmicrosoft azure\b/i, /\bazure\b/i]],
  ['Google Cloud', 'Cloud & infrastructure', [/\bgoogle cloud(?: platform)?\b/i, /\bgcp\b/i]],
  ['Docker', 'Cloud & infrastructure', [/\bdocker\b/i]],
  ['Kubernetes', 'Cloud & infrastructure', [/\bkubernetes\b/i, /\bk8s\b/i]],
  ['Terraform', 'Cloud & infrastructure', [/\bterraform\b/i]],
  ['CI/CD', 'Engineering practices', [/\bci\s*\/\s*cd\b/i, /continuous integration and continuous (?:delivery|deployment)/i]],
  ['Git', 'Engineering practices', [/\bgit(?:hub|lab)?\b/i, /\bversion control\b/i]],
  ['APIs', 'Engineering practices', [/\brest(?:ful)? apis?\b/i, /\bapi (?:design|development|integration)s?\b/i]],
  ['Microservices', 'Engineering practices', [/\bmicroservices?\b/i]],
  ['System architecture', 'Engineering practices', [/\bsystem architecture\b/i, /\bsolution architecture\b/i, /\breference architectures?\b/i]],
];

const attributeDefinitions = [
  ['Leadership', [/\btechnical leadership\b/i, /\bpeople leadership\b/i, /\blead (?:a |the )?(?:team|delivery|strategy|projects?|initiatives?)/i]],
  ['Mentoring', [/\bmentor(?:ing|ed|s)?\b/i, /\bcoach(?:ing|ed|es)?\b/i]],
  ['Stakeholder partnership', [/\bstakeholders?\b/i, /\bcross-functional\b/i]],
  ['Communication', [/\bcommunication skills?\b/i, /\bcommunicate complex\b/i, /\bwritten and verbal\b/i]],
  ['Hands-on development', [/\bhands-on\b/i, /\bfull-stack\b/i, /\bapplication development\b/i]],
  ['Research & experimentation', [/\bresearch design\b/i, /\bexperimentation\b/i, /\ba\/b testing\b/i]],
];

export function extractJobSeekerInsights(text = '', structuredDetails = {}) {
  const searchable = cleanText([
    text,
    structuredDetails.responsibilities,
    structuredDetails.minimumQualifications,
    structuredDetails.preferredQualifications,
    structuredDetails.coreCompetencies,
  ].filter(Boolean).join('\n'));
  if (!searchable) return { skills: [], minimumExperienceYears: null, education: [], attributes: [], travelRequirement: '' };

  const skills = skillDefinitions
    .filter(([, , patterns]) => patterns.some((pattern) => pattern.test(searchable)))
    .map(([name, category]) => ({ name, category }));
  const experienceMatches = [...searchable.matchAll(/(?:minimum (?:of )?)?(\d{1,2})\s*\+?\s*(?:or more\s+)?years?(?:\s+of)?\s+(?:professional\s+|relevant\s+|hands-on\s+)?experience/gi)]
    .map((match) => Number(match[1]))
    .filter((years) => years > 0 && years <= 30);
  const education = [
    [/\b(?:ph\.?d\.?|doctorate|doctoral degree)\b/i, 'Doctorate'],
    [/\b(?:master(?:'s)? degree|master of|graduate degree)\b/i, "Master's or graduate degree"],
    [/\b(?:bachelor(?:'s)? degree|bachelor of|undergraduate degree)\b/i, "Bachelor's degree"],
  ].filter(([pattern]) => pattern.test(searchable)).map(([, label]) => label);
  const attributes = attributeDefinitions
    .filter(([, patterns]) => patterns.some((pattern) => pattern.test(searchable)))
    .map(([label]) => label);
  const travel = searchable.match(/\b(?:ability|willingness)?\s*to travel\s+(\d{1,3}(?:\s*[-–]\s*\d{1,3})?%)/i);

  return {
    skills,
    minimumExperienceYears: experienceMatches.length ? Math.max(...experienceMatches) : null,
    education,
    attributes,
    travelRequirement: travel?.[1]?.replace(/\s+/g, '') || '',
  };
}

export function parseJobDetails(input) {
  const normalized = normalizeInput(input);
  const text = normalized.combinedText;
  const lines = textLines(text);
  const linkedInHeader = linkedinPageHeader(lines);
  const header = linkedInHeader || inferHeader(lines);
  const anchors = extractAnchors(normalized.html);
  const links = [...extractUrls(text), ...anchors.map((anchor) => anchor.url)];
  const linkedIn = links.map(canonicalizeLinkedInJobUrl).find(Boolean) || {};
  const companyLinkedInUrl = links.map(canonicalizeLinkedInCompanyUrl).find(Boolean) || '';

  const descriptionSection = sectionFromLines(
    lines,
    [/^about the job$/i, /^job description$/i, /^about this job$/i, /^the role$/i],
    [/^set alert for similar jobs$/i, /^unlock hiring insights/i, /^about the company$/i, /^company description$/i, /^similar jobs$/i, /^people also viewed$/i],
  );
  const profile = companyProfile(lines);

  const salaryLine = lines.find((line) => /annual salary range|compensation range/i.test(line)) || '';
  const salaryMatch = (salaryLine || text).match(/(?:[$£€]\s?\d[\d,.]*\s*(?:-|–|to)\s*[$£€]?\s?\d[\d,.]*(?:\s*(?:USD|CAD|GBP|EUR|\/|per\s+)(?:year|yr|hour|hr|month)?)?)/i);
  const workArrangement = lines.find((line) => /^(remote|hybrid|on[- ]site)$/i.test(line)) ||
    (header.location.match(/\b(remote|hybrid|on[- ]site)\b/i)?.[1] || '');
  const employmentType = lines.find((line) => /^(full-time|part-time|contract|temporary|internship|volunteer)$/i.test(line)) ||
    lineValue(lines, ['employment type']);
  const metadata = listingMetadata(lines);
  const jobLines = textLines(descriptionSection);
  const sections = postingSections(jobLines);
  const structuredDetails = {
    ...metadata,
    postedDate: calculatePostingDate(metadata.postedAgo),
    overview: sectionContent(sections, 'overview'),
    postingInformation: sectionContent(sections, 'postingInformation'),
    responsibilities: sectionContent(sections, 'responsibilities'),
    coreCompetencies: sectionContent(sections, 'coreCompetencies'),
    qualificationSummary: sectionContent(sections, 'qualificationSummary'),
    minimumQualifications: sectionContent(sections, 'minimumQualifications'),
    preferredQualifications: sectionContent(sections, 'preferredQualifications'),
    team: sectionContent(sections, 'team'),
    incentiveCompensation: sectionContent(sections, 'incentiveCompensation'),
    compensationDetails: sectionContent(sections, 'compensationDetails'),
    jobType: lineValue(jobLines, ['job type']) || sectionContent(sections, 'jobType').split('\n')[0] || '',
    shift: lineValue(jobLines, ['shift']) || sectionContent(sections, 'shift').split('\n')[0] || '',
    primaryLocation: lineValue(jobLines, ['primary location']) || sectionContent(sections, 'primaryLocation').split('\n')[0] || '',
    additionalLocations: lineValue(jobLines, ['additional locations']) || sectionContent(sections, 'additionalLocations').split('\n')[0] || '',
    postingStatement: sectionContent(sections, 'postingStatement'),
    positionOfTrust: lineValue(jobLines, ['position of trust']),
    benefits: sectionContent(sections, 'benefits'),
    workLocation: sectionContent(sections, 'workLocation'),
    workModel: sectionContent(sections, 'workModel'),
    scheduleType: sectionContent(sections, 'scheduleType'),
    additionalInformation: sectionContent(sections, 'additionalInformation'),
    sections,
    applicantInsights: {
      employeeGrowth: (() => {
        const index = lines.findIndex((line) => /^employee growth$/i.test(line));
        return index > 0 && /%$/.test(lines[index - 1]) ? lines[index - 1] : '';
      })(),
      education: (() => {
        const index = lines.findIndex((line) => /^applicant education level$/i.test(line));
        return index >= 0 ? cleanText(lines.slice(index + 1, index + 3).join(' ')) : '';
      })(),
      seniority: (() => {
        const index = lines.findIndex((line) => /^applicant seniority level$/i.test(line));
        return index >= 0 ? cleanText(lines.slice(index + 1, index + 3).join(' ')) : '';
      })(),
    },
  };
  structuredDetails.jobSeekerInsights = extractJobSeekerInsights(descriptionSection || text, structuredDetails);

  return {
    detectedType: /about the job|job description|responsibilities|qualifications/i.test(text) ? 'job_details' : 'unstructured_text',
    details: {
      ...linkedIn,
      title: valueAfterLabel(lines, ['job title', 'position', 'role']) || header.title,
      company: valueAfterLabel(lines, ['company', 'organization', 'employer']) || linkedInHeader?.company || profile.company || header.company,
      location: valueAfterLabel(lines, ['location']) || header.location,
      workArrangement,
      employmentType,
      seniority: valueAfterLabel(lines, ['seniority level', 'seniority']),
      salary: (valueAfterLabel(lines, ['salary', 'compensation']) || salaryMatch?.[0] || '').replace(/[.;:,]+$/, ''),
      description: descriptionSection || text,
      structuredDetails,
      companyDetails: { ...profile, linkedinUrl: companyLinkedInUrl },
    },
    warnings: descriptionSection ? [] : ['A labeled job-description section was not found, so the complete pasted text will be kept as the description.'],
  };
}

export function parsePastedContent(input, { mode = 'auto' } = {}) {
  if (mode === 'details') return parseJobDetails(input);
  const alert = parseLinkedInAlert(input);
  if (mode === 'alert' || alert.jobs.length > 1) return alert;
  const normalized = normalizeInput(input);
  if (/about the job|job description|responsibilities|qualifications/i.test(normalized.combinedText)) {
    const details = parseJobDetails(input);
    return { ...details, jobs: [details.details] };
  }
  return alert.jobs.length ? alert : parseJobDetails(input);
}
