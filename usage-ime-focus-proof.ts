import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { startControlUiE2eServer } from './src/test-helpers/control-ui-e2e.ts';
import { createControlUiE2eArtifactDir } from './src/test-helpers/control-ui-e2e-artifacts.ts';
import { installUsageOverviewGateway, openUsageFilter } from './src/e2e/usage-overview-fixture.test-support.ts';
import { createEmptyCostUsageTotals } from '../src/infra/session-cost-usage-totals.js';
import { buildUsageOverview } from '../src/shared/usage-overview.js';

const stage = process.argv[2];
assert.ok(stage === 'before' || stage === 'after');
const artifacts = createControlUiE2eArtifactDir(`usage-ime-focus-${stage}`, '/proof/evidence');
const observations: unknown[] = [];
const record = (row: unknown) => { observations.push(row); console.log(JSON.stringify(row)); writeFileSync(`${artifacts}/trace.json`, JSON.stringify(observations, null, 2)); };
record({ stage, sourceSha256: createHash('sha256').update(readFileSync('ui/src/pages/usage/view-value-picker.tsx')).digest('hex') });
const server = await startControlUiE2eServer(undefined, { source: true });
let browser;
try {
 browser = await chromium.launch({ executablePath: '/opt/google/chrome/chrome', headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: '/browser-libs' } });
 const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'en-US', timezoneId: 'UTC' });
 page.setDefaultTimeout(45000);
 page.on('pageerror', error => record({ pageError: error.message }));
 page.on('requestfailed', request => record({ failedRequest: request.url(), failure: request.failure() }));
 const now = Date.now();
 const date = new Date(now).toISOString().slice(0,10);
 const sessions = ['research','developer'].map((name,i) => {
   const totals = { ...createEmptyCostUsageTotals(), input: 100, output: 20, totalTokens: 120, totalCost: i+1, inputCost: i+1 };
   return { key: `agent:${name}:proof`, label: `${name} session`, agentId: name, modelProvider:i ? 'anthropic' : 'openai', model:'proof-model', updatedAt: now,
    usage: { ...totals, firstActivity: now, messageCounts: { total:2,user:1,assistant:1,toolCalls:0,toolResults:0,errors:0 }, modelUsage:[{provider:i ? 'anthropic' : 'openai',model:'proof-model',count:1,totals}] } };
 });
 const projected = buildUsageOverview({ rows:sessions, options:{}, dayBucket:{mode:'utc-offset',utcOffsetMinutes:0} });
 const gateway = await installUsageOverviewGateway(page, { methodResponses: { 'sessions.usage': { ...projected, updatedAt:now,startDate:date,endDate:date,sessions }, 'usage.status':{updatedAt:now,providers:[]} } });
 try {
  const response = await page.goto(server.baseUrl+'usage');
  assert.equal(response?.status(),200);
  await page.getByText('research session',{exact:true}).waitFor();
  const picker = await openUsageFilter(page,'Provider');
  const input = picker.getByRole('textbox');
  const option = picker.getByRole('menuitemcheckbox',{name:'openai',exact:true});
  await input.fill('open');
  await option.waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({path:`${artifacts}/draft.png`});
  const check = async (event:string, selected:boolean) => {
   await page.waitForFunction(({selected}) => document.querySelector('[role="menuitemcheckbox"][aria-label="openai"]')?.getAttribute('aria-checked')===String(selected),{selected});
   const requests = await gateway.getRequests('sessions.usage');
   record({event,selected:await option.getAttribute('aria-checked'),draft:await input.inputValue(),queryRequests:requests.map(r=>r.params),chips:await page.locator('.usage-filter-chip').allTextContents()});
   assert.equal(await option.getAttribute('aria-checked'),String(selected));
   assert.equal(await input.inputValue(),'open');
  };
  for (const kind of ['keyCode229', 'isComposing', 'compositionend']) {
   await input.focus();
   const result = await input.evaluate((element, kind) => {
    const end = new CompositionEvent('compositionend', { bubbles:true });
    if (kind === 'compositionend') element.dispatchEvent(end);
    const event = new KeyboardEvent('keydown', { key:'Enter', bubbles:true, cancelable:true, keyCode:kind === 'keyCode229' ? 229 : 13, isComposing:kind === 'isComposing' });
    if (kind === 'compositionend') Object.defineProperty(event,'timeStamp',{value:end.timeStamp-1});
    element.dispatchEvent(event);
    return { defaultPrevented:event.defaultPrevented, focused:document.activeElement===element };
   }, kind);
   record({kind,...result});
   const interrupted = stage === 'before' && kind !== 'isComposing';
   assert.equal(result.defaultPrevented, interrupted);
   assert.equal(result.focused, !interrupted);
   await check(kind,false);
   await page.screenshot({path:`${artifacts}/${kind}.png`});
   await input.dispatchEvent('keyup',{key:'Enter',bubbles:true});
  }
  assert.ok((await gateway.getRequests('sessions.usage')).every(r=>!(r.params as {query?:string}).query?.includes('provider:')));
  await input.focus();
  await input.press('Enter');
  await gateway.waitForRequest('sessions.usage',{match:{query:'provider:openai '}});
  await check('keyup + normal Enter',true);
  await page.screenshot({path:`${artifacts}/final.png`});
  record({stage,result:'PASS',url:page.url(),requests:await gateway.getRequests('sessions.usage')});
 } catch(error) {record({failure:String(error),body:await page.locator('body').innerText().catch(()=>'' )});await page.screenshot({path:`${artifacts}/failure.png`}).catch(()=>{});throw error;}
} finally {await browser?.close();await server.close();}
