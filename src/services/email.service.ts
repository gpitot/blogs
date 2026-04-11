export function isEmailAllowed(email: string, allowlist: string | undefined): boolean {
  if (!allowlist || !allowlist.trim()) return true;
  const normalized = email.trim().toLowerCase();
  return allowlist
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(normalized);
}

// Chunked base64 encoding — avoids stack overflow on large Uint8Arrays
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export async function sendEpubEmail(opts: {
  apiKey: string;
  fromAddress: string;
  to: string;
  title: string;
  filename: string;
  epubBytes: Uint8Array;
}): Promise<void> {
  const { apiKey, fromAddress, to, title, filename, epubBytes } = opts;

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromAddress,
      to: [to],
      subject: `Your EPUB: ${title}`,
      html: `<p>Your EPUB <strong>${title}</strong> is attached. Happy reading!</p>`,
      attachments: [
        {
          filename,
          content: uint8ArrayToBase64(epubBytes),
        },
      ],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "(no body)");
    throw new Error(`Resend API error (${resp.status}): ${body}`);
  }
}
