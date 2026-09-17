import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { generateExportHtmlVendorAssets } from '../../scripts/runtime-postbuild.mts';
import { createOpenClawTestState } from '../../src/test-utils/openclaw-test-state.js';
import { replaceSessionEntry, replaceTranscriptEvents } from '../../src/config/sessions/session-accessor.js';
const proof=path.resolve('.artifacts/export-html-proof');
const phase=process.argv[2]??'red';
const modulePath=path.join(proof,'commands-export-session.mjs');
await build({entryPoints:['src/auto-reply/reply/commands-export-session.ts'],outfile:modulePath,bundle:true,format:'esm',platform:'node',plugins:[{name:'retain-source-imports',setup(builder){builder.onResolve({filter:/.*/},args=>{if(args.kind==='entry-point')return;if(!args.path.startsWith('.'))return{path:args.path,external:true};let target=path.resolve(args.resolveDir,args.path);if(target.endsWith('.js')&&!existsSync(target)&&existsSync(target.slice(0,-3)+'.ts'))target=target.slice(0,-3)+'.ts';return{path:target,external:true};});}}]});
const assets=path.join(proof,'export-html');await fs.mkdir(path.join(assets,'vendor'),{recursive:true});
for(const name of ['template.html','template.css','template.js'])await fs.copyFile(path.join('src/auto-reply/reply/export-html',name),path.join(assets,name));
for(const [name,value] of Object.entries(generateExportHtmlVendorAssets()))await fs.writeFile(path.join(assets,'vendor',name),value);
const state=await createOpenClawTestState({label:'export-html-chain',layout:'home',env:{OPENCLAW_DISABLE_BUNDLED_PLUGINS:'1',OPENCLAW_TEST_MINIMAL_GATEWAY:'1'}});
let browser;
try{
 const cfg={agents:{defaults:{workspace:state.workspaceDir}},plugins:{enabled:false},tools:{deny:['*']}};await state.writeConfig(cfg);
 const sessionId='deep-chain-proof',sessionKey='agent:main:deep-chain-proof';
 const storePath=path.join(state.agentDir('main'),'openclaw-agent.sqlite');
 const scope={agentId:'main',sessionKey,sessionId,storePath};const entry={sessionId,updatedAt:Date.now()};
 await replaceSessionEntry(scope,entry);
 const count=10000;const entries=Array.from({length:count},(_,i)=>({type:'message',id:`entry-${i}`,parentId:i?`entry-${i-1}`:null,timestamp:new Date(1700000000000+i).toISOString(),message:{role:i%2?'assistant':'user',content:`Synthetic message ${i+1}`,timestamp:1700000000000+i}}));
 await replaceTranscriptEvents(scope,[{type:'session',version:3,id:sessionId,timestamp:'2026-09-18T00:00:00Z',cwd:state.workspaceDir},...entries]);
 const {buildExportSessionReply}=await import(pathToFileURL(modulePath).href);
 const reply=await buildExportSessionReply({cfg,ctx:{SessionKey:sessionKey},command:{commandBodyNormalized:'/export-session deep-chain.html',isAuthorizedSender:true,senderIsOwner:true,senderId:'proof-owner',channel:'quietchat',surface:'quietchat',ownerList:[],rawBodyNormalized:'/export-session deep-chain.html'},sessionEntry:entry,sessionKey,storePath,agentId:'main',workspaceDir:state.workspaceDir,directives:{},elevated:{enabled:false,allowed:false,failures:[]},defaultGroupActivation:()=> 'mention',resolvedVerboseLevel:'off',resolvedReasoningLevel:'off',resolveDefaultThinkingLevel:async()=>undefined,provider:'synthetic',model:'synthetic-model',contextTokens:0,isGroup:false});
 const html=path.join(proof,`command-${phase}.html`);await fs.copyFile(path.join(state.workspaceDir,'deep-chain.html'),html);
 browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true});const page=await browser.newPage({viewport:{width:1280,height:800}});const errors=[];page.on('pageerror',e=>errors.push({message:e.message,stack:e.stack}));await page.goto(pathToFileURL(html).href);
 const result={phase,count,reply,errors,treeNodes:await page.locator('.tree-node').count(),first:await page.getByText('Synthetic message 1',{exact:true}).count(),last:await page.getByText('Synthetic message 10000',{exact:true}).count()};
 if(phase==='green'){
  await page.locator('.tree-node[data-id="entry-0"]').click();
  result.afterFirstClick={messages:await page.locator('[id^="entry-entry-"]').count(),selected:await page.locator('.tree-node.active').getAttribute('data-id'),first:await page.getByText('Synthetic message 1',{exact:true}).count(),last:await page.getByText('Synthetic message 10000',{exact:true}).count()};
  await page.locator('#entry-entry-0').evaluate(el=>el.scrollIntoView({block:'start'}));
  await page.screenshot({path:path.join(proof,'command-green.png')});
  await page.locator('.tree-node[data-id="entry-9999"]').click();
  result.afterLastClick={messages:await page.locator('[id^="entry-entry-"]').count(),selected:await page.locator('.tree-node.active').getAttribute('data-id'),last:await page.getByText('Synthetic message 10000',{exact:true}).count()};
  await page.locator('#entry-entry-9999').evaluate(el=>el.scrollIntoView({block:'center'}));
  await page.screenshot({path:path.join(proof,'command-green-last.png')});
 }else{await page.screenshot({path:path.join(proof,`command-${phase}.png`)});}
 await fs.writeFile(path.join(proof,`command-${phase}.json`),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser?.close();await state.cleanup();}
