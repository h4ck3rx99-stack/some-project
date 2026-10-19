/** The one stylesheet, served at /static/app.css. No web fonts, CSS variables, light/dark. */
export const CSS = `
:root{--bg:#fbfbfa;--fg:#17181a;--muted:#5d6168;--card:#fff;--line:#e3e4e6;--accent:#2f5bea;--accent-fg:#fff;
--pass:#1d7a46;--pass-bg:#e5f4ea;--warn:#8a5a00;--warn-bg:#fdf2d8;--fail:#b3261e;--fail-bg:#fbe6e4;--skip:#5d6168;--skip-bg:#eef0f2;
--radius:10px;--font:system-ui,-apple-system,"Segoe UI",Roboto,Ubuntu,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#121315;--fg:#e9eaec;--muted:#a1a5ad;--card:#1b1c1f;--line:#2c2e33;--accent:#7b9bff;--accent-fg:#0d0f14;
--pass:#6fd39b;--pass-bg:#173523;--warn:#f0c46a;--warn-bg:#3a2e13;--fail:#ff8f87;--fail-bg:#3e1c1a;--skip:#a1a5ad;--skip-bg:#25272b}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 var(--font)}
a{color:var(--accent)}a:hover{text-decoration:none}
.wrap{max-width:1040px;margin:0 auto;padding:0 16px}
header.site{border-bottom:1px solid var(--line);background:var(--card)}
header.site .wrap{display:flex;align-items:center;gap:16px;min-height:56px;flex-wrap:wrap}
.brand{font-weight:700;color:var(--fg);text-decoration:none;font-size:18px;margin-right:auto}
nav a{color:var(--muted);text-decoration:none;margin-left:14px}nav a:hover{color:var(--fg)}
nav form{display:inline}nav button{margin-left:14px}
main{padding:28px 0 56px}footer.site{border-top:1px solid var(--line);color:var(--muted);font-size:14px;padding:24px 0}
footer.site a{color:var(--muted);margin-right:14px}
h1{font-size:30px;line-height:1.2;margin:0 0 12px}h2{font-size:22px;margin:32px 0 12px}h3{font-size:18px;margin:20px 0 8px}
p{margin:0 0 12px}.muted{color:var(--muted)}.small{font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:18px;margin:0 0 16px}
.grid{display:grid;gap:16px}.grid.two{grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}.grid.three{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
label{display:block;font-weight:600;margin:0 0 6px}
input[type=text],input[type=email],input[type=url],input[type=number],input[type=date],select{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
input:focus,select:focus,button:focus,a:focus,summary:focus{outline:3px solid color-mix(in srgb,var(--accent) 45%,transparent);outline-offset:2px}
.btn,button{display:inline-block;padding:10px 16px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-fg);font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
.btn.secondary,button.secondary{background:transparent;color:var(--accent)}button.link{background:none;border:0;color:var(--muted);padding:0;font-weight:400}
button.danger{background:var(--fail);border-color:var(--fail);color:#fff}
.row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}.row>*{flex:1 1 auto}.row>.btn,.row>button{flex:0 0 auto}
.scanform{display:flex;gap:10px;flex-wrap:wrap}.scanform input{flex:1 1 260px;font-size:18px}
.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
.notice{border-left:4px solid var(--accent);padding:10px 14px;background:var(--card);margin:0 0 16px;border-radius:6px}
.notice.error{border-color:var(--fail)}.notice.warn{border-color:var(--warn)}
.chip{display:inline-block;font-size:13px;font-weight:600;padding:2px 9px;border-radius:999px;background:var(--skip-bg);color:var(--skip);white-space:nowrap}
.s-pass{background:var(--pass-bg);color:var(--pass)}.s-warn{background:var(--warn-bg);color:var(--warn)}.s-fail,.s-error{background:var(--fail-bg);color:var(--fail)}.s-skip{background:var(--skip-bg);color:var(--skip)}
.report-head{display:flex;gap:24px;align-items:center;flex-wrap:wrap}.dial{flex:0 0 auto}.dial text{fill:var(--fg)}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:4px 18px;font-size:14px;color:var(--muted)}
.meta b{color:var(--fg);font-weight:600}
.bars{display:grid;gap:10px}.bar{display:grid;grid-template-columns:130px 1fr 54px;gap:10px;align-items:center;font-size:14px}
.bar .track{display:block;width:100%;height:10px;background:var(--skip-bg);border-radius:6px;overflow:hidden}.bar .fill{fill:var(--accent)}
.checks{list-style:none;padding:0;margin:0}.checks li{border-top:1px solid var(--line);padding:12px 0}
.check-head{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}.check-head .title{font-weight:600}
details{margin-top:6px}summary{cursor:pointer;color:var(--muted);font-size:14px}
.evidence{margin:8px 0 0;padding:0;list-style:none;font-size:14px}.evidence li{border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:6px 0;background:var(--bg)}
.evidence code,.mono{font-family:var(--mono);font-size:13px;word-break:break-all;overflow-wrap:anywhere;white-space:pre-wrap}
dl.ev{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin:4px 0 0}dl.ev dt{color:var(--muted)}dl.ev dd{margin:0;min-width:0}
table{width:100%;border-collapse:collapse;font-size:15px}th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:13px;color:var(--muted);font-weight:600}
.table-wrap{overflow-x:auto}
.spark{vertical-align:middle}.spark polyline,.chart polyline{fill:none;stroke:var(--accent);stroke-width:2}.chart .grid line{stroke:var(--line)}.chart text{fill:var(--muted);font-size:11px}
progress.progress{display:block;width:100%;height:8px;margin:10px 0;border:0;border-radius:6px;background:var(--skip-bg);overflow:hidden;appearance:none}
progress.progress::-webkit-progress-bar{background:var(--skip-bg)}progress.progress::-webkit-progress-value{background:var(--accent)}progress.progress::-moz-progress-bar{background:var(--accent)}
.price{font-size:32px;font-weight:700}.plan ul{padding-left:18px}
.prose{max-width:720px}.prose pre{background:var(--card);border:1px solid var(--line);padding:12px;border-radius:8px;overflow-x:auto}.prose code{font-family:var(--mono);font-size:14px}
.copy{margin-left:6px}
.mt0{margin-top:0}.mt4{margin:4px 0 0}.mt6{margin:6px 0 0}.mt8{margin-top:8px}.mt10{margin-top:10px}.mt12{margin-top:12px}.m0{margin:0}.mb4{margin:0 0 4px}.mb12{margin-bottom:12px}
.w440{max-width:440px}.w560{max-width:560px}.w640{max-width:640px}.wnone{max-width:none}.fw400{font-weight:400}.center{align-items:center}
.hero{padding:24px 0 8px}.lead{font-size:18px;max-width:720px}.grow{flex:1 1 320px;min-width:0}.logo{max-height:48px;max-width:200px}
.brandhead{display:flex;align-items:center;gap:16px;margin-bottom:16px}
@media (max-width:600px){h1{font-size:24px}.bar{grid-template-columns:96px 1fr 44px}nav a{margin-left:10px}}
@media print{header.site,footer.site,.no-print,form{display:none!important}body{background:#fff;color:#000}.card{border-color:#ccc;break-inside:avoid}details{display:block}details>*{display:block}a{color:#000}
.checks li{break-inside:avoid}}
`;
