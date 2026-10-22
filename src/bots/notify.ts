// Phone push alerts through ntfy (free app for iPhone/Android). Set NTFY_TOPIC
// on Render to the private topic name you subscribe to in the app.
export async function push(title: string, body: string, urgent: boolean) {
  const topic = process.env.NTFY_TOPIC;
  console.log(`\n=== ${title} ===\n${body}\n`);
  if (!topic) return;
  const server = process.env.NTFY_SERVER || "https://ntfy.sh";
  const r = await fetch(`${server}/${encodeURIComponent(topic)}`, {
    method: "POST",
    headers: {
      Title: title,
      Priority: urgent ? "high" : "default",
      Tags: urgent ? "rotating_light" : "package",
    },
    body: body.slice(0, 3900),
  });
  if (!r.ok) console.error(`Push failed: ${r.status} ${await r.text()}`);
}
