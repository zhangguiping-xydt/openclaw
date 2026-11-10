const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const { chromium } = require('/deps/' + fs.readdirSync('/deps').find(n => n.startsWith('playwright-core@')) + '/node_modules/playwright-core');
(async () => {
  const phase = process.argv[2];
  const html = execFileSync('bash', ['/src/scripts/changelog-to-html.sh', '2026.10.10', '/src/CHANGELOG/2026.10.10.md'], { encoding: 'utf8', maxBuffer: 8*1024*1024, timeout: 20000 });
  fs.writeFileSync('/proof/'+phase+'.html', html);
  const browser = await chromium.launch({ executablePath: '/chrome/chrome', headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1050, height: 700 } });
    await page.setContent(html);
    const commands = await page.locator('code').allTextContents();
    const expected = ['openclaw cron enable <job-id>', 'openclaw plugins enable <plugin-id>', '/learn undo <id>'];
    const observed = expected.map(command => ({ expected: command, observed: commands.find(text => text.startsWith(command.split('<')[0])), pass: commands.includes(command) }));
    const entry = page.locator('li').filter({ hasText: 'openclaw cron enable' }).first();
    await entry.screenshot({ path: '/proof/'+phase+'.png' });
    const report = { phase, source_sha256: crypto.createHash('sha256').update(fs.readFileSync('/src/scripts/changelog-to-html.sh')).digest('hex'), command: 'bash scripts/changelog-to-html.sh 2026.10.10 CHANGELOG/2026.10.10.md', browser: await browser.version(), observed };
    fs.writeFileSync('/proof/'+phase+'.json', JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report,null,2));
    process.exitCode = observed.every(r => r.pass) ? 0 : 1;
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode=2; });
