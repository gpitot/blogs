import { useState } from "react";

export default function KindleHelp() {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-2 text-xs text-brown-light">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="italic underline cursor-pointer hover:text-teal"
      >
        {open
          ? "Hide Kindle setup instructions"
          : "How do I find my Kindle email?"}
      </button>
      {open && (
        <ol className="mt-2 space-y-2 list-decimal list-inside bg-parchment border border-tan rounded-sm p-3 text-brown leading-relaxed">
          <li>
            Go to{" "}
            <a
              href="https://www.amazon.com.au/hz/mycd/digital-console/alldevices"
              target="_blank"
              rel="noopener noreferrer"
              className="text-teal underline hover:text-teal-dark"
            >
              Manage Your Devices
            </a>
            , click on your Kindle, and find its Send-to-Kindle email address
            (ends in @kindle.com).
          </li>
          <li>
            Go to{" "}
            <a
              href="https://www.amazon.com.au/hz/mycd/preferences/myx"
              target="_blank"
              rel="noopener noreferrer"
              className="text-teal underline hover:text-teal-dark"
            >
              Preferences
            </a>
            , scroll down to{" "}
            <strong>Approved Personal Document E-mail List</strong>, and add{" "}
            <code className="font-mono bg-cream border border-tan px-1 rounded-sm">
              blogs@northmanlysquash.com
            </code>{" "}
            as an approved sender.
          </li>
        </ol>
      )}
    </div>
  );
}
