import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { calculatePostingDate, canonicalizeLinkedInJobUrl, extractJobSeekerInsights, parseJobDetails, parseLinkedInAlert } from '../linkedin-parser.mjs';

const fixture = (name) => readFile(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

test('canonicalizes LinkedIn email tracking URLs', () => {
  assert.deepEqual(
    canonicalizeLinkedInJobUrl('https://www.linkedin.com/comm/jobs/view/4448674024?trackingId=secret'),
    { linkedinJobId: '4448674024', jobUrl: 'https://www.linkedin.com/jobs/view/4448674024' },
  );
});

test('converts LinkedIn relative posting ages into stable dates', () => {
  const capturedAt = new Date('2026-08-12T12:00:00-07:00');
  assert.equal(calculatePostingDate('1 week ago', capturedAt), '2026-08-05');
  assert.equal(calculatePostingDate('3 days ago', capturedAt), '2026-08-09');
  assert.equal(calculatePostingDate('yesterday', capturedAt), '2026-08-11');
  assert.equal(calculatePostingDate('2 hours ago', capturedAt), '2026-08-12');
});

test('extracts practical job-seeker signals from a full description', () => {
  const insights = extractJobSeekerInsights(`
    This hands-on role requires 7+ years of experience and a Bachelor's degree.
    Build generative AI applications in Python and TypeScript using AWS, Docker, SQL, and data pipelines.
    Lead a team of cross-functional stakeholders, mentor engineers, and demonstrate the ability to travel 0-10%.
  `);

  assert.deepEqual(insights.skills.map(({ name }) => name),
    ['Python', 'SQL', 'TypeScript', 'Generative AI', 'Data pipelines', 'AWS', 'Docker']);
  assert.equal(insights.minimumExperienceYears, 7);
  assert.deepEqual(insights.education, ["Bachelor's degree"]);
  assert.deepEqual(insights.attributes, ['Leadership', 'Mentoring', 'Stakeholder partnership', 'Hands-on development']);
  assert.equal(insights.travelRequirement, '0-10%');
});

test('parses and deduplicates the alert confirmation format', async () => {
  const result = parseLinkedInAlert({ plainText: await fixture('linkedin-alert-confirmation.txt') });
  assert.equal(result.detectedType, 'linkedin_alert');
  assert.equal(result.jobs.length, 2);
  assert.deepEqual(result.jobs[0], {
    linkedinJobId: '4448674024',
    jobUrl: 'https://www.linkedin.com/jobs/view/4448674024',
    title: 'Lead AI and Data Science Engineer',
    company: 'Northwind Analytics',
    location: 'Portland, Oregon, United States',
    confidence: 0.98,
  });
});

test('parses company, location, and hybrid markers from digest alerts', async () => {
  const result = parseLinkedInAlert({ plainText: await fixture('linkedin-alert-digest.txt') });
  assert.equal(result.jobs.length, 2);
  assert.equal(result.jobs[1].company, 'Adventure Works');
  assert.equal(result.jobs[1].location, 'Portland, OR (Hybrid)');
});

test('parses rich HTML clipboard content and groups repeated job links', () => {
  const url = 'https://www.linkedin.com/comm/jobs/view/4442630952/?trackingId=example';
  const result = parseLinkedInAlert({
    plainText: 'Fabrikam\nPrincipal Server Software Integration Engineer\nFabrikam · Hillsboro, OR\nActively recruiting',
    html: `<div>Fabrikam</div><a href="${url}">Principal Server Software Integration Engineer</a><a href="${url}&company=1">Fabrikam · Hillsboro, OR</a><a href="${url}&recruiting=1">Actively recruiting</a>`,
  });
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].title, 'Principal Server Software Integration Engineer');
  assert.equal(result.jobs[0].company, 'Fabrikam');
  assert.equal(result.jobs[0].location, 'Hillsboro, OR');
});

test('keeps all six companies paired with their job IDs when rich email markup splits the separator', () => {
  const postings = [
    ['4448674024', 'Lead AI and Data Science Engineer II', 'Deloitte', 'Portland, Oregon, United States'],
    ['4447377492', 'Systems Software Engineer - New College Grad 2026', 'NVIDIA AI', 'Hillsboro, Oregon, United States'],
    ['4447403415', 'Applied AI Developer', 'Leatherman Tool Group', 'Portland, Oregon, United States'],
    ['4447189152', 'Senior AI / Data Science Engineer', 'Intel', 'Hillsboro, Oregon, United States'],
    ['4449123110', 'AI Full Stack Engineer', 'Intel', 'Hillsboro, Oregon, United States'],
    ['4447302204', 'Software Architect – AI Workflow Architecture', 'Daimler Truck North America', 'Portland, Oregon, United States'],
  ];
  const result = parseLinkedInAlert({
    plainText: [
      'Your job alert has been created: Artificial Intelligence Engineer',
      'You’ll receive notifications when new jobs are posted that match your search preferences.',
      ...postings.flatMap(([, title, company, location]) => [company, title, `${company} · ${location}`]),
    ].join('\n'),
    html: `
      <p>You’ll receive notifications when new jobs are posted that match your search preferences.</p>
      ${postings.map(([id, title, company, location], index) => {
        const url = `https://www.linkedin.com/comm/jobs/view/${id}?trackingId=${index}`;
        const separator = index % 2 ? '<span>\u200b·</span>' : '<span>&nbsp;·&nbsp;</span>';
        return `<div>${company}</div><a href="${url}">${title}</a><a href="${url}&amp;posting=1"><span>${company}</span>${separator}<span>${location}</span></a>`;
      }).join('\n')}
    `,
  });

  assert.deepEqual(
    result.jobs.map(({ title, company, location }) => ({ title, company, location })),
    postings.map(([, title, company, location]) => ({ title, company, location })),
  );
});

test('does not use alert boilerplate as the company fallback', () => {
  const url = 'https://www.linkedin.com/comm/jobs/view/4448674024?trackingId=first';
  const result = parseLinkedInAlert({
    html: `
      <p>You’ll receive notifications when new jobs are posted that match your search preferences.</p>
      <a href="${url}">Lead AI and Data Science Engineer II</a>
      <a href="${url}&amp;posting=1">Deloitte<span> · </span>Portland, Oregon, United States</a>
    `,
  });

  assert.equal(result.jobs[0].company, 'Deloitte');
  assert.equal(result.jobs[0].location, 'Portland, Oregon, United States');
});

test('extracts labeled sections from pasted job details', () => {
  const result = parseJobDetails({ plainText: `
Senior Platform Engineer
Northwind Analytics
Portland, OR (Hybrid)

About the job
Build reliable data products and mentor engineers.

Seniority level
Senior
Employment type
Full-time

About the company
Northwind builds analytical tools for modern teams.
Industry
Software Development
Company size
201-500 employees
  ` });

  assert.equal(result.detectedType, 'job_details');
  assert.equal(result.details.title, 'Senior Platform Engineer');
  assert.equal(result.details.company, 'Northwind Analytics');
  assert.equal(result.details.seniority, 'Senior');
  assert.match(result.details.description, /Build reliable data products/);
  assert.match(result.details.companyDetails.description, /Northwind builds analytical tools/);
});

test('captures rich structured details from a copied LinkedIn job page', async () => {
  const result = parseJobDetails({ plainText: await fixture('linkedin-job-page.txt') });
  const { details } = result;

  assert.equal(details.title, 'Senior AI / Data Science Engineer');
  assert.equal(details.company, 'Intel');
  assert.equal(details.location, 'Hillsboro, OR (Hybrid)');
  assert.equal(details.workArrangement, 'Hybrid');
  assert.equal(details.employmentType, 'Full-time');
  assert.equal(details.salary, '$136,900.00 - 269,150.00 USD');
  assert.equal(details.structuredDetails.postedAgo, '1 week ago');
  assert.match(details.structuredDetails.postedDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(details.structuredDetails.applicantActivity, '59 people clicked apply');
  assert.equal(details.structuredDetails.applicationMethod, 'Responses managed off LinkedIn');
  assert.equal(details.structuredDetails.jobType, 'Experienced Hire');
  assert.equal(details.structuredDetails.shift, 'Shift 1 (United States of America)');
  assert.equal(details.structuredDetails.primaryLocation, 'US, Arizona, Phoenix');
  assert.equal(details.structuredDetails.additionalLocations, 'US, Oregon, Hillsboro');
  assert.match(details.structuredDetails.responsibilities, /scalable data pipelines/);
  assert.match(details.structuredDetails.minimumQualifications, /Python and SQL/);
  assert.match(details.structuredDetails.preferredQualifications, /Agentic AI/);
  assert.match(details.structuredDetails.benefits, /retirement/);
  assert.match(details.structuredDetails.workModel, /hybrid work model/);
  assert.equal(details.structuredDetails.applicantInsights.employeeGrowth, '10%');
  assert.equal(details.structuredDetails.applicantInsights.education, "40% have a Master's Degree");
  assert.equal(details.companyDetails.industry, 'Semiconductor Manufacturing');
  assert.equal(details.companyDetails.companySize, '10001+ employees');
  assert.equal(details.companyDetails.followers, '4,303,151 followers');
  assert.match(details.companyDetails.description, /shape the future of technology/);
  assert.doesNotMatch(details.description, /Unlock hiring insights/);
  assert.doesNotMatch(details.companyDetails.description, /More jobs/);
});

test('ignores navigation when LinkedIn uses its company-logo page header', async () => {
  const result = parseJobDetails({
    plainText: await fixture('linkedin-job-page-logo-header.txt'),
    html: '<a href="https://www.linkedin.com/company/intel-corporation/life/?trackingId=example">Intel</a>',
  });
  assert.equal(result.details.title, 'Senior AI / Data Science Engineer');
  assert.equal(result.details.company, 'Intel');
  assert.equal(result.details.location, 'Hillsboro, OR');
  assert.equal(result.details.workArrangement, 'Hybrid');
  assert.equal(result.details.employmentType, 'Full-time');
  assert.equal(result.details.companyDetails.linkedinUrl, 'https://www.linkedin.com/company/intel-corporation/');
});

test('maps employer-specific headings and retains their original sections', async () => {
  const result = parseJobDetails({ plainText: await fixture('linkedin-job-page-varied-sections.txt') });
  const structured = result.details.structuredDetails;

  assert.match(structured.overview, /scalable automation platforms/);
  assert.match(structured.postingInformation, /posting may close/);
  assert.match(structured.responsibilities, /reference architectures/);
  assert.match(structured.minimumQualifications, /8\+ years/);
  assert.match(structured.preferredQualifications, /multi-agent systems/);
  assert.match(structured.coreCompetencies, /structured communication/);
  assert.match(structured.benefits, /retirement contributions/);
  assert.match(structured.benefits, /Tuition assistance/);
  assert.match(structured.workLocation, /Portland/);
  assert.match(structured.scheduleType, /4 days per week/);
  assert.match(structured.additionalInformation, /legally authorized/);
  assert.deepEqual(
    structured.sections.map(({ heading }) => heading),
    ['Inside the Role', 'Posting Information', 'We Take Care of Our Team', 'What You Will Do',
      'Knowledge You Should Bring', 'Exceptional Candidates', 'Behavioral Competencies', 'Where We Work',
      'Schedule Type', 'Additional Information', 'Benefits found in job post'],
  );
});

test('captures closed listings, deadlines, and Deloitte-style subsections', async () => {
  const result = parseJobDetails({ plainText: await fixture('linkedin-job-page-closed.txt') });
  const { details } = result;
  const structured = details.structuredDetails;

  assert.equal(structured.listingStatus, 'No longer accepting applications');
  assert.equal(structured.applicationDeadline, '2026-08-10');
  assert.equal(details.salary, '$118700 to $218600');
  assert.match(structured.responsibilities, /AI roadmap/);
  assert.match(structured.responsibilities, /machine learning solutions/);
  assert.match(structured.responsibilities, /production-quality data pipelines/);
  assert.match(structured.responsibilities, /Mentor engineers/);
  assert.match(structured.coreCompetencies, /Clear communication/);
  assert.match(structured.team, /multidisciplinary AI engineering practice/);
  assert.match(structured.minimumQualifications, /Eight years/);
  assert.match(structured.preferredQualifications, /generative AI/);
  assert.match(structured.incentiveCompensation, /discretionary annual incentive/);
  assert.match(structured.compensationDetails, /wage range/);
  assert.deepEqual(
    structured.sections.map(({ heading }) => heading),
    ['Overview', "Work You'll Do", 'Strategy & Stakeholder Partnership', 'Analytics & Data Science',
      'Software & Data Engineering', 'People Leadership', 'A successful candidate would possess these skills',
      'The team', 'Qualifications', 'Required', 'Preferred', 'Incentive compensation', 'Compensation details'],
  );
});
