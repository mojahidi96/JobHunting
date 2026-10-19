import { Link } from "react-router-dom";
import { useAuth } from "../auth";
import { Card } from "../components/ui";

const H = ({ children }: { children: string }) => <h2 className="mt-6 text-lg font-semibold">{children}</h2>;

/** Public. Describes what is collected and how email delivery works. Keep in sync with README "Data retention". */
export function PrivacyPage() {
  const { user } = useAuth();
  return (
    <main className="mx-auto w-full max-w-3xl p-4 sm:p-8">
      <Link to={user ? "/" : "/login"} className="text-sm font-medium text-primary hover:underline">← Back</Link>
      <Card className="mt-4 p-6 sm:p-8">
        <h1 className="text-2xl font-semibold tracking-tight">Privacy notice</h1>
        <p className="mt-2 text-sm text-muted">JobHunting helps you manage recruiter outreach. This page explains what it stores and how email is sent.</p>

        <H>What we collect</H>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          <li><strong>Account:</strong> your name, email address, and a salted password hash (never the password) if you use one.</li>
          <li><strong>Profile you choose to add:</strong> headline, skills, links, phone and similar fields used to fill your email templates.</li>
          <li><strong>Your outreach data:</strong> recruiter contacts you add or import, templates, and the history of emails you send.</li>
          <li><strong>Sign-in records:</strong> when you last signed in, and short-lived session and security data. One-time codes are stored only as a hash and expire in 5 minutes.</li>
        </ul>

        <H>How email is sent</H>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          <li><strong>Sign-in codes and account messages</strong> are sent from JobHunting's own verified sender through a transactional email provider. You never provide any email credentials for this.</li>
          <li><strong>Recruiter emails</strong> are sent from <em>your</em> Gmail account, but only if you choose “Connect Gmail”. Google asks for your consent to a send-only permission. We never ask for your Gmail password or an App Password, and we can't read your mailbox. You can disconnect in Email Sending Settings or revoke access in your Google Account at any time.</li>
          <li>Sending is rate-limited with daily caps, and only to recruiters you have saved.</li>
        </ul>

        <H>Who can see your data</H>
        <p className="mt-2 text-sm">Only you can see your contacts, templates and history. Administrators can see account details needed to run the service (name, email, role, status, registration and last sign-in dates, and usage counts) but not your contacts, messages, passwords or credentials. Administrative actions are recorded in an audit log.</p>

        <H>Security</H>
        <p className="mt-2 text-sm">Connections use HTTPS in production. Sessions use HttpOnly cookies. Connected-mailbox tokens are encrypted at rest and never sent to your browser.</p>

        <H>Your choices</H>
        <p className="mt-2 text-sm">You can export your data and permanently delete your account from the Profile page. Deleting removes your profile, contacts, templates, history and sessions. We don't sell your data.</p>
      </Card>
    </main>
  );
}
