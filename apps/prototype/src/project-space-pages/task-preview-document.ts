import type { MockTask } from "./task-model";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function taskPreviewDocument(task: MockTask, kind: "preview" | "prototype") {
  const title = escapeHtml(task.title);
  const body = escapeHtml(task.body);
  const revision = escapeHtml(task.pullRequest?.revision ?? "local");
  const eyebrow = kind === "preview" ? `Revision ${revision}` : "Interaction prototype";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      * { box-sizing: border-box; }
      html, body { height: 100%; margin: 0; }
      body { background: #090a0c; color: #f5f5f5; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif; }
      header { align-items: center; border-bottom: 1px solid #ffffff12; display: flex; height: 56px; justify-content: space-between; padding: 0 20px; }
      nav { color: #ffffff77; display: flex; gap: 18px; font-size: 13px; }
      main { display: grid; min-height: calc(100% - 56px); place-items: center; padding: 32px 22px; }
      article { max-width: 560px; text-align: center; }
      .mark { background: #1589ff; border-radius: 14px; display: grid; font-weight: 700; height: 48px; margin: 0 auto 24px; place-items: center; width: 48px; }
      .eyebrow { color: #59a8ff; font-size: 12px; font-weight: 600; letter-spacing: .03em; }
      h1 { font-size: clamp(26px, 6vw, 42px); letter-spacing: -.04em; line-height: 1.05; margin: 12px 0 16px; }
      p { color: #ffffff88; margin: 0 auto; max-width: 480px; }
      .actions { display: flex; gap: 10px; justify-content: center; margin-top: 28px; }
      button { border: 0; border-radius: 999px; font: inherit; padding: 10px 18px; }
      .primary { background: #1589ff; color: white; }
      .secondary { background: #ffffff12; color: #ffffffbb; }
    </style>
  </head>
  <body>
    <header><strong>project-space</strong><nav><span>Tasks</span><span>Repository</span></nav></header>
    <main>
      <article>
        <div class="mark">PS</div>
        <div class="eyebrow">${eyebrow}</div>
        <h1>${title}</h1>
        <p>${body}</p>
        <div class="actions"><button class="primary">Continue</button><button class="secondary">Details</button></div>
      </article>
    </main>
  </body>
</html>`;
}
