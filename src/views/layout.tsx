import type { Child } from 'hono/jsx';

export interface LayoutProps {
  title: string;
  description?: string;
  user?: { email: string; role: string } | null;
  csrf?: string;
  noindex?: boolean;
  children?: Child;
  bare?: boolean;
}

export function Layout(p: LayoutProps) {
  const title = p.title === 'CartProbe' ? p.title : `${p.title} · CartProbe`;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        {p.description ? <meta name="description" content={p.description} /> : null}
        {p.noindex ? <meta name="robots" content="noindex" /> : null}
        <link rel="stylesheet" href="/static/app.css" />
        <link rel="icon" href="data:," />
      </head>
      <body>
        {p.bare ? null : (
          <header class="site">
            <div class="wrap">
              <a class="brand" href="/">
                CartProbe
              </a>
              <nav aria-label="Main">
                <a href="/pricing">Pricing</a>
                <a href="/docs">Docs</a>
                {p.user ? (
                  <>
                    <a href="/app">Dashboard</a>
                    {p.user.role === 'admin' ? <a href="/admin">Admin</a> : null}
                    <form method="post" action="/logout">
                      <input type="hidden" name="_csrf" value={p.csrf ?? ''} />
                      <button class="link" type="submit">
                        Log out
                      </button>
                    </form>
                  </>
                ) : (
                  <a href="/login">Log in</a>
                )}
              </nav>
            </div>
          </header>
        )}
        <main>
          <div class="wrap">{p.children}</div>
        </main>
        {p.bare ? null : (
          <footer class="site">
            <div class="wrap">
              <a href="/bot">About our bot</a>
              <a href="/terms">Terms</a>
              <a href="/privacy">Privacy</a>
              <a href="/aup">Acceptable use</a>
              <span>Readiness scores are estimates from automated checks.</span>
            </div>
          </footer>
        )}
        <script src="/static/app.js" defer></script>
      </body>
    </html>
  );
}

export function Notice(p: { kind?: 'info' | 'error' | 'warn'; children?: Child }) {
  return (
    <div class={`notice ${p.kind ?? ''}`} role={p.kind === 'error' ? 'alert' : 'status'}>
      {p.children}
    </div>
  );
}

export function Csrf(p: { token?: string }) {
  return <input type="hidden" name="_csrf" value={p.token ?? ''} />;
}
