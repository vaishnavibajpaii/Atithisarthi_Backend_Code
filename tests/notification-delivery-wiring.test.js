"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const fixture=()=>({id:"1",tenant_id:"11111111-1111-4111-8111-111111111111",property_id:"10",hotel_slug:"fixture-hotel",source_type:"order",source_id:"20",event_type:"order_created",status:"pending",retry_count:0,payload:{}});
function moduleFixture({enabled=true,qrEnabled=false,emailEnabled=true,sendFailure=false,admission="claimed",bounded=false,loseAtRenewal=0,settingsWait}={}){
  const state={sends:0,settingsReads:0,updates:[],rpcs:[]},event=fixture(),syntheticValue="synthetic-only";
  const scoped={from(table){assert.equal(table,"hotel_notification_settings");state.settingsReads++;return{select(){return this;},eq(){return this;},async maybeSingle(){await settingsWait;return{data:{hotel_slug:event.hotel_slug,email_enabled:emailEnabled,owner_email:"owner@example.test",notify_on_new_order:true},error:null};}};}};
  const service={from(table){if(table==="hotel_notification_settings")return scoped.from(table);assert.equal(table,"notification_events");return{update(patch){state.updates.push(patch);return this;},eq(){return this;},select(){return this;},async single(){return{data:{...event,...state.updates.at(-1)},error:null};}};},async rpc(name,args){state.rpcs.push({name,args});
    if(name==="task7d_claim_notification_delivery")return{data:{admission,event,lease:{owner:args.p_lease_owner,version:"1"}}};
    if(name==="task7d_renew_notification_delivery")return{data:!loseAtRenewal||state.rpcs.filter(r=>r.name===name).length!==loseAtRenewal};
    if(name==="task7d_complete_notification_delivery")return{data:{...event,status:args.p_status,error_message:args.p_error_message}};
    throw new Error("UNEXPECTED_RPC");}};
  const env={task7NotificationLeasesEnabled:enabled,task7QrLeasedWorkerEnabled:qrEnabled,task7NotificationSmtpDeadlineEnabled:bounded,notificationDeliveryEnabled:true,notificationDeliveryChannel:"email",
    notificationEmailFrom:"notifier@example.test",notificationSmtpHost:"smtp.example.test",notificationSmtpPort:587,notificationSmtpUser:syntheticValue,notificationSmtpPass:syntheticValue};
  const dependencies={"./supabase":{supabase:service},"../config/env":{env},"./notification-live":{publishNotificationEvent(){}},
    nodemailer:{createTransport(){return{async sendMail(mail){state.sends++;state.legacyMail=mail;assert.equal(mail.to,"owner@example.test");assert.equal(mail.disableFileAccess,true);if(sendFailure)throw new Error("PRIVATE-SMTP-DIAGNOSTIC");return{accepted:[mail.to]};}};}},
    "./bounded-notification-smtp":{async sendBoundedNotificationSmtp(input){state.boundedInput=input;state.sends++;assert.equal(input.timeoutMs,45000);assert.equal(input.signal.aborted,false);assert.equal(input.mail.to,"owner@example.test");if(sendFailure)throw Object.assign(new Error("PRIVATE-SMTP-DIAGNOSTIC"),{code:typeof sendFailure==="string"?sendFailure:undefined});return{accepted:[input.mail.to]};}},
    "./notification-dedupe":require("../utils/notification-dedupe"),"./notification-delivery-lease-store":require("../utils/notification-delivery-lease-store"),"./notification-delivery-gate":require("../utils/notification-delivery-gate")};
  const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../utils/notifications.js"),"utf8"),{module,exports:module.exports,require(name){if(!(name in dependencies))throw new Error("UNEXPECTED_DEPENDENCY");return dependencies[name];},console:{error(){}}},{filename:"notifications.js"});
  return{api:module.exports,state,event,scoped};
}
test("enabled production wrapper keeps settings on caller adapter and status only in fenced RPC",async()=>{
  const x=moduleFixture();const row=await x.api.processNotificationEventDelivery(x.event,{databaseClient:x.scoped});assert.equal(row.status,"sent");assert.equal(x.state.sends,1);assert.equal(x.state.settingsReads,1);assert.equal(x.state.updates.length,0);
  assert.equal(x.state.rpcs.filter(r=>r.name==="task7d_complete_notification_delivery").length,1);
});
test("enabled production skip keeps existing reason and never contacts SMTP",async()=>{
  const x=moduleFixture({emailEnabled:false});const row=await x.api.processNotificationEventDelivery(x.event,{databaseClient:x.scoped});assert.equal(row.status,"skipped");assert.equal(row.error_message,"Hotel email notifications disabled");assert.equal(x.state.sends,0);assert.equal(x.state.updates.length,0);
});
test("enabled provider failure stores bounded category, while default-off keeps legacy path",async()=>{
  const x=moduleFixture({sendFailure:true});const failed=await x.api.processNotificationEventDelivery(x.event,{databaseClient:x.scoped});assert.equal(failed.status,"failed");assert.equal(failed.error_message,"NOTIFICATION_SMTP_DELIVERY_FAILED");
  const legacy=moduleFixture({enabled:false});assert.equal((await legacy.api.processNotificationEventDelivery(legacy.event)).status,"sent");assert.equal(legacy.state.updates.length,1);assert.equal(legacy.state.rpcs.length,0);
});
test("enabled but disabled schema and QR-without-shared-gate configuration fail before effect",async()=>{
  const disabled=moduleFixture({admission:"disabled"});await assert.rejects(disabled.api.processNotificationEventDelivery(disabled.event),{code:"NOTIFICATION_DELIVERY_DISABLED"});assert.equal(disabled.state.sends,0);assert.equal(disabled.state.updates.length,0);
  const incoherent=moduleFixture({enabled:false,qrEnabled:true});await assert.rejects(incoherent.api.processNotificationEventDelivery(incoherent.event),{code:"NOTIFICATION_DELIVERY_SHARED_GATE_REQUIRED"});assert.equal(incoherent.state.sends,0);assert.equal(incoherent.state.rpcs.length,0);
});

test("bounded SMTP branch retains rendered content and scopes its cancellation to the internal lease",async()=>{
  const old=moduleFixture(),bounded=moduleFixture({bounded:true});
  await old.api.processNotificationEventDelivery(old.event,{databaseClient:old.scoped});
  const row=await bounded.api.processNotificationEventDelivery(bounded.event,{databaseClient:bounded.scoped,signal:new AbortController().signal});
  assert.equal(row.status,"sent");assert.equal(bounded.state.updates.length,0);
  assert.deepEqual(JSON.parse(JSON.stringify(bounded.state.boundedInput.mail)),JSON.parse(JSON.stringify(old.state.legacyMail)));
  assert.equal(bounded.state.boundedInput.signal.aborted,true,"gate stops its private ownership context after completion");
});

test("bounded SMTP requires shared admission and never falls back to legacy delivery",async()=>{
  const x=moduleFixture({enabled:false,bounded:true});await assert.rejects(x.api.processNotificationEventDelivery(x.event),{code:"NOTIFICATION_DELIVERY_SHARED_GATE_REQUIRED"});
  assert.equal(x.state.sends,0);assert.equal(x.state.updates.length,0);assert.equal(x.state.rpcs.length,0);
});

test("lost lease after slow settings prevents opening either SMTP transport",async()=>{
  for(const bounded of [false,true]){let release;const waiting=new Promise(resolve=>{release=resolve;});
    const x=moduleFixture({bounded,loseAtRenewal:2,settingsWait:waiting});const run=x.api.processNotificationEventDelivery(x.event,{databaseClient:x.scoped});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(x.state.settingsReads,1);assert.equal(x.state.sends,0);release();
    await assert.rejects(run,{code:"NOTIFICATION_DELIVERY_LEASE_LOST"});assert.equal(x.state.sends,0);
    assert.equal(x.state.rpcs.filter(r=>r.name==="task7d_complete_notification_delivery").length,0);
  }
});

test("bounded deadline/ambiguous outcomes retain bounded failure categories and fenced retry state",async()=>{
  for(const code of ["NOTIFICATION_SMTP_DEADLINE_PRE_DATA","NOTIFICATION_SMTP_OUTCOME_UNKNOWN","NOTIFICATION_SMTP_PRE_DATA_FAILED","NOTIFICATION_SMTP_PROVIDER_REJECTED"]){
    const x=moduleFixture({bounded:true,sendFailure:code});const row=await x.api.processNotificationEventDelivery(x.event,{databaseClient:x.scoped});
    assert.equal(row.status,"failed");assert.equal(row.error_message,code);assert.equal(x.state.updates.length,0);
    assert.equal(x.state.rpcs.filter(r=>r.name==="task7d_complete_notification_delivery").length,1);
  }
});

test("bounded sender lease abort is never converted to a retry/status write by the gate",async()=>{
  const x=moduleFixture({bounded:true,sendFailure:"NOTIFICATION_DELIVERY_LEASE_LOST"});
  await assert.rejects(x.api.processNotificationEventDelivery(x.event,{databaseClient:x.scoped}),{code:"NOTIFICATION_DELIVERY_LEASE_LOST"});
  assert.equal(x.state.rpcs.filter(r=>r.name==="task7d_complete_notification_delivery").length,0);
});

function adminFixture({enabled=true,status="failed",retry=1,busy=false}={}){
  const source=fs.readFileSync(path.join(__dirname,"../routes/admin.js"),"utf8"),prefix='router.post("/notification-events/:id/resend", ';
  const start=source.indexOf(prefix),end=source.indexOf("\n});",start);assert.ok(start>source.indexOf("router.use(requireAdminAuth)"));
  const event={...fixture(),status,retry_count:retry},state={updates:[],deliveries:[]};
  const supabase={from(table){assert.equal(table,"notification_events");return{select(){return this;},eq(){return this;},update(patch){state.updates.push(patch);return this;},async maybeSingle(){return{data:event};},then(resolve,reject){return Promise.resolve({error:null}).then(resolve,reject);}};}};
  const deliver=async(row,options)=>{state.deliveries.push({row,options});if(busy)throw Object.assign(new Error("busy"),{code:"NOTIFICATION_DELIVERY_BUSY_OR_SCOPE"});return{...row,status:"sent",retry_count:retry+1};};
  const handler=vm.runInNewContext("("+source.slice(start+prefix.length,end)+"\n})",{supabase,env:{task7NotificationLeasesEnabled:enabled},NOTIFICATION_EVENT_MAX_RETRIES:3,processNotificationEventDelivery:deliver,processNotificationEventDeliverySafely:deliver,console:{error(){}}});
  const res={statusCode:200,status(value){this.statusCode=value;return this;},json(value){this.body=value;return this;}};
  return{handler,state,event,res};
}
test("actual admin enabled handler admits exact expectations without legacy pending/count write",async()=>{
  const x=adminFixture({retry:2});await x.handler({params:{id:"1"}},x.res);assert.equal(x.res.statusCode,200);assert.equal(x.res.body.notificationEvent.retry_count,3);assert.equal(x.state.updates.length,0);assert.equal(x.state.deliveries[0].options.manualResend.expectedRetry,2);assert.equal(x.state.deliveries[0].options.manualResend.expectedStatus,"failed");
});
test("actual admin busy handler returns conflict without resetting status or retry counter",async()=>{
  const x=adminFixture({busy:true});await x.handler({params:{id:"1"}},x.res);assert.equal(x.res.statusCode,409);assert.equal(x.res.body.success,false);assert.equal(x.state.updates.length,0);assert.equal(x.event.retry_count,1);assert.equal(x.event.status,"failed");
});
test("admin keeps existing terminal eligibility and three-resend ceiling",async()=>{
  for(const options of [{status:"sent"},{retry:3}]){const x=adminFixture(options);await x.handler({params:{id:"1"}},x.res);assert.equal(x.res.statusCode,400);assert.equal(x.state.deliveries.length,0);assert.equal(x.state.updates.length,0);}
});
test("admin default-off branch preserves existing prepare and response fields",async()=>{
  const x=adminFixture({enabled:false});await x.handler({params:{id:"1"}},x.res);assert.equal(x.res.statusCode,200);assert.equal(x.state.updates.length,1);assert.equal(x.state.updates[0].status,"pending");assert.equal(x.state.updates[0].retry_count,2);assert.equal(x.res.body.notificationEventMaxRetries,3);
});
