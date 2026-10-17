import type { PlaceholderConfig } from "./templateEngine.js";

export interface Starter { key: string; name: string; subject: string; html: string; placeholderConfig: PlaceholderConfig }

export const STARTERS: Starter[] = [
  {
    key: "generic",
    name: "Generic introduction",
    subject: "Interested in the {{Role}} opportunity at {{Company}}",
    html: `<p>Hi {{firstName}},</p>
<p>I'm <b>{{SENDER_NAME}}</b>, {{HEADLINE}}. I came across the <b>{{Role}}</b> opening at <b>{{Company}}</b> and wanted to reach out directly.</p>
<p>A quick snapshot of my background:</p>
<p>{{SKILLS_SUMMARY}}</p>
<p>Would you be open to a short call to see whether my profile fits? My <a href="{{RESUME_LINK}}">resume</a> and <a href="{{LINKEDIN_LINK}}">LinkedIn</a> have more detail.</p>
<p>If this isn't relevant, just reply "no" and I won't follow up.</p>
<p>Thanks &amp; regards,<br><b>{{SENDER_NAME}}</b><br>Contact: {{CONTACT_NO}}<br>Email: {{SENDER_EMAIL}}</p>`,
    placeholderConfig: {},
  },
  {
    // Content of the original recruiter-outreach-mailer/sendEmails.js message, kept as an optional example.
    key: "frontend-lead-example",
    name: "Example: Frontend Lead (from sendEmails.js)",
    subject: "Request for an Interview Opportunity - {{Role}} at {{Company}}",
    html: `<p>Hi {{firstName}},</p>
<p>I'm <b>{{SENDER_NAME}}</b>, a <b>Frontend Lead</b> with <b>10+ years</b> of experience. I saw your post that <b>{{Company}}</b> is hiring for <b>{{Role}}</b> and wanted to reach out directly:</p>
<p>Quick snapshot:</p>
<ul>
<li><b>10+ years</b> in Frontend Engineering, specializing in <b>Angular, TypeScript &amp; JavaScript</b></li>
<li>Currently <b>leading a team of 4 engineers</b> on Morgan Stanley (via Synechron), owning <b>architecture, delivery &amp; code reviews</b> — recognized with <b>client appreciation</b> for the engagement</li>
<li>Deep expertise in <b>RxJS, NgRx, REST API integration, AEM frontend, Node.js, CI/CD</b></li>
<li>Built <b>Generative AI features</b> using <b>OpenAI/LLM &amp; SSE streaming</b>, cutting query resolution time by <b>25%</b></li>
<li>Delivered <b>real-time systems</b> on <b>WebSockets &amp; Node.js</b>, supporting <b>25K+ sessions/month</b></li>
</ul>
<p>I am <b>currently available and can join within a month</b>. Would you be open to a <b>quick 10-min call this week</b> to discuss this opportunity?</p>
<p>PS: My <b><a href="{{RESUME_LINK}}">Resume</a></b> &amp; <b><a href="{{LINKEDIN_LINK}}">LinkedIn</a></b> are linked above — happy to share more details.</p>
<p>Thanks &amp; Regards,<br><b>{{SENDER_NAME}}</b><br>Contact No: {{CONTACT_NO}}<br>Email: {{SENDER_EMAIL}}</p>`,
    placeholderConfig: {},
  },
];

export const getStarter = (key: string) => STARTERS.find((s) => s.key === key);
