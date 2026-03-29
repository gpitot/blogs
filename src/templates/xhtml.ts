export function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function xhtml(title: string, body: string, attrs = ""): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" ${attrs} xml:lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>${title}</title>
</head>
<body>
  ${body}
</body>
</html>`;
}
