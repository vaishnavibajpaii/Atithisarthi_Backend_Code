"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {createNotificationDeliveryGate}=require("../utils/notification-delivery-gate");
const {NotificationDeliveryLeaseStore}=require("../utils/notification-delivery-lease-store");
const TENANT="11111111-1111-4111-8111-111111111111";
const fixture=()=>({id:"9007199254740993",tenant_id:TENANT,property_id:"10",hotel_slug:"fixture-hotel",source_type:"order",source_id:"20",event_type:"order_created",status:"pending",retry_count:0,payload:{}});
function setup(){
  const x={sends:0,stops:0,completions:[],claims:[],busy:false};x.event=fixture();
  x.store={async claim(event,manual){x.claims.push({event,manual});if(x.busy)return{admission:"busy_or_scope"};x.busy=true;return{admission:"claimed",event:{...x.event,_task7Lease:{owner:TENANT,version:"1"}}};},
    watch(){return{assertOwned:async()=>{},stop(){x.stops++;}};},async complete(event,status,errorMessage){x.completions.push({status,errorMessage});x.busy=false;return{...x.event,status};}};
  x.perform=async()=>{x.sends++;return{status:"sent"};};
  x.gate=(overrides={})=>createNotificationDeliveryGate({leaseStore:x.store,perform:x.perform,...overrides});return x;
}
test("shared helper/QR/admin invocations allow only one current effect and completion",async()=>{
  const x=setup();let release,entered;const ready=new Promise(r=>entered=r),pending=new Promise(r=>release=r);
  const deliver=x.gate({perform:async()=>{x.sends++;entered();await pending;return{status:"sent"};}});
  const first=deliver(x.event);await ready;
  await assert.rejects(deliver(x.event),{code:"NOTIFICATION_DELIVERY_BUSY_OR_SCOPE"});
  await assert.rejects(deliver(x.event,{manualResend:{expectedStatus:"failed",expectedRetry:0}}),{code:"NOTIFICATION_DELIVERY_BUSY_OR_SCOPE"});
  release();const done=await first;assert.equal(done.status,"sent");assert.equal(x.sends,1);assert.equal(x.completions.length,1);assert.equal(x.stops,1);assert.equal(done._task7Lease,undefined);
});
test("sent/skipped dedupe results are terminal without SMTP or status mutation",async()=>{
  for(const status of ["sent","skipped"]){const x=setup();x.store.claim=async()=>({admission:"terminal",event:{...x.event,status}});
    assert.equal((await x.gate()(x.event)).status,status);assert.equal(x.sends,0);assert.equal(x.completions.length,0);}
});
test("disabled, historical, busy, backoff, exhausted and stale admin admissions never fall back",async()=>{
  for(const admission of ["disabled","historical_excluded","busy_or_scope","retry_later","retry_exhausted","stale_admin","admin_limit"]){const x=setup();x.store.claim=async()=>({admission});
    await assert.rejects(x.gate()(x.event),{code:"NOTIFICATION_DELIVERY_"+admission.toUpperCase()});assert.equal(x.sends,0);assert.equal(x.completions.length,0);}
});
test("canonical identity mismatches fail before SMTP, including large source IDs",async()=>{
  for(const change of [{tenant_id:"22222222-2222-4222-8222-222222222222"},{property_id:"11"},{hotel_slug:"other"},{source_type:"inquiry"},{source_id:"21"},{id:"9007199254740992"}]){
    const x=setup();const original=x.store.claim;x.store.claim=async(...args)=>{const value=await original(...args);Object.assign(value.event,change);return value;};
    await assert.rejects(x.gate()(x.event),{code:"NOTIFICATION_DELIVERY_SCOPE_INVALID"});assert.equal(x.sends,0);
  }
});
test("unsupported email types and missing canonical owners cannot claim",async()=>{
  for(const change of [{tenant_id:null},{property_id:0},{source_type:"room_booking"},{id:9007199254740992},{source_id:{}},{source_id:[]}]){const x=setup();
    await assert.rejects(x.gate()({...x.event,...change}),{code:"NOTIFICATION_DELIVERY_SCOPE_INVALID"});assert.equal(x.claims.length,0);}
});
test("caller settings adapter is preserved while effects use canonical stored payload",async()=>{
  const x=setup(),adapter={scoped:true};x.event.payload={persisted:true};
  await x.gate({perform:async(event,options)=>{assert.equal(event.payload,x.event.payload);assert.equal(options.databaseClient,adapter);assert.equal(event._task7Lease,undefined);return{status:"skipped",errorMessage:"Hotel email notifications disabled"};}})({...x.event,payload:{untrusted:true}},{databaseClient:adapter});
  assert.deepEqual(x.completions,[{status:"skipped",errorMessage:"Hotel email notifications disabled"}]);
});
test("manual resend expectations travel atomically with claim, not an independent status update",async()=>{
  const x=setup(),manual={expectedStatus:"failed",expectedRetry:2};await x.gate()(x.event,{manualResend:manual});assert.equal(x.claims[0].manual,manual);
});
test("lease loss before or after effect cannot write successful or failed completion",async()=>{
  for(const lostAt of [1,2]){const x=setup();let checks=0;x.store.watch=()=>({stop(){x.stops++;},assertOwned:async()=>{if(++checks===lostAt)throw Object.assign(new Error("lost"),{code:"NOTIFICATION_DELIVERY_LEASE_LOST"});}});
    await assert.rejects(x.gate()(x.event),{code:"NOTIFICATION_DELIVERY_LEASE_LOST"});assert.equal(x.sends,lostAt-1);assert.equal(x.completions.length,0);assert.equal(x.stops,1);}
});
test("null stale completion never reports sent and cleanup always stops heartbeat",async()=>{
  const x=setup();x.store.complete=async()=>null;await assert.rejects(x.gate()(x.event),{code:"NOTIFICATION_DELIVERY_LEASE_LOST"});assert.equal(x.sends,1);assert.equal(x.stops,1);
});
test("effect failure records bounded category rather than raw recipient/provider diagnostics",async()=>{
  const x=setup();await assert.rejects(x.gate({perform:async()=>{throw new Error("PRIVATE-SMTP-DIAGNOSTIC");}})(x.event),{message:"NOTIFICATION_DELIVERY_EFFECT_FAILED"});
  assert.deepEqual(x.completions,[{status:"failed",errorMessage:"NOTIFICATION_DELIVERY_EFFECT_FAILED"}]);assert.equal(x.stops,1);
});
test("broker transport errors and malformed claimed statuses cannot escape or send",async()=>{
  const x=setup();x.store.claim=async()=>{throw new Error("PRIVATE-RPC-DIAGNOSTIC");};
  await assert.rejects(x.gate()(x.event),{message:"NOTIFICATION_DELIVERY_ADMISSION_FAILED"});assert.equal(x.sends,0);
  const y=setup();y.event.status="sent";await assert.rejects(y.gate()(y.event),{code:"NOTIFICATION_DELIVERY_CONTRACT_INVALID"});assert.equal(y.sends,0);
});
test("claimed envelope binds fresh owner and exact decimal version; admin expectations retain types",async()=>{
  const calls=[];const store=new NotificationDeliveryLeaseStore({rpc:async(name,args)=>{calls.push({name,args});return{data:{admission:"claimed",event:fixture(),lease:{owner:args.p_lease_owner,version:"9007199254740993"}}};}});
  const first=await store.claim(fixture(),{expectedStatus:"failed",expectedRetry:2}),second=await store.claim(fixture());
  assert.notEqual(first.event._task7Lease.owner,second.event._task7Lease.owner);assert.equal(first.event._task7Lease.version,"9007199254740993");assert.equal(calls[0].args.p_expected_retry,2);assert.equal(calls[1].args.p_mode,"auto");
});
test("malformed broker responses, owner substitution and unsafe versions fail closed",async()=>{
  for(const make of [()=>null,()=>({}),(_,args)=>({admission:"claimed",event:fixture(),lease:{owner:TENANT,version:"1"}}),(_,args)=>({admission:"claimed",event:fixture(),lease:{owner:args.p_lease_owner,version:9007199254740992}})]){
    const store=new NotificationDeliveryLeaseStore({rpc:async(...args)=>({data:make(...args)})});await assert.rejects(store.claim(fixture()),{code:"NOTIFICATION_DELIVERY_LEASE_LOST"});}
});
test("completion and renewal include exact lease identity and refuse truthy nonboolean renewals",async()=>{
  const calls=[],row={...fixture(),_task7Lease:{owner:TENANT,version:"9007199254740993"}};
  const store=new NotificationDeliveryLeaseStore({rpc:async(name,args)=>{calls.push({name,args});return{data:"true"};}});
  assert.equal(await store.renew(row),false);await store.complete(row,"failed","NOTIFICATION_SMTP_DELIVERY_FAILED");
  assert.equal(calls[1].args.p_event_id,"9007199254740993");assert.equal(calls[1].args.p_claim_version,"9007199254740993");assert.equal(calls[1].args.p_status,"failed");
});
test("store heartbeat transport loss fences later effects and stop removes timer",async(t)=>{
  t.mock.timers.enable({apis:["setInterval"]});let renewals=0;const row={...fixture(),_task7Lease:{owner:TENANT,version:"1"}};
  const store=new NotificationDeliveryLeaseStore({rpc:async()=>{renewals++;throw new Error("PRIVATE-RPC-DIAGNOSTIC");}},{heartbeatMs:1000});const watch=store.watch(row);
  try{t.mock.timers.tick(1000);await new Promise(r=>setImmediate(r));await assert.rejects(watch.assertOwned(),{code:"NOTIFICATION_DELIVERY_LEASE_LOST"});assert.equal(renewals,1);watch.stop();t.mock.timers.tick(2000);assert.equal(renewals,1);}finally{watch.stop();}
});

test("heartbeat rejection aborts an active effect and the gate cannot complete a stale send",async(t)=>{
  t.mock.timers.enable({apis:["setInterval","setTimeout"]});let renewals=0,completions=0,entered;
  const ready=new Promise(resolve=>{entered=resolve;}),event=fixture();
  const store=new NotificationDeliveryLeaseStore({rpc:async(name,args)=>{
    if(name==="task7d_claim_notification_delivery")return{data:{admission:"claimed",event,lease:{owner:args.p_lease_owner,version:"1"}}};
    if(name==="task7d_renew_notification_delivery")return{data:++renewals===1};
    if(name==="task7d_complete_notification_delivery"){completions++;return{data:{...event,status:"sent"}};}
  }},{heartbeatMs:1000});
  let signal;
  const gate=createNotificationDeliveryGate({leaseStore:store,perform:async(row,options,effect)=>{
    signal=effect.signal;entered();await new Promise((resolve,reject)=>{signal.addEventListener("abort",()=>reject(signal.reason),{once:true});});
  }});
  const run=gate(event);await ready;t.mock.timers.tick(1000);
  await assert.rejects(run,{code:"NOTIFICATION_DELIVERY_LEASE_LOST"});assert.equal(signal.aborted,true);assert.equal(completions,0);
  const count=renewals;t.mock.timers.tick(120000);await new Promise(resolve=>setImmediate(resolve));assert.equal(renewals,count);
});

test("a hung renewal reaches the local ownership cutoff and a late success cannot resurrect it",async(t)=>{
  t.mock.timers.enable({apis:["setInterval","setTimeout"]});let resolveRpc,calls=0;
  const row={...fixture(),_task7Lease:{owner:TENANT,version:"1"}};
  const store=new NotificationDeliveryLeaseStore({rpc:async()=>{calls++;return new Promise(resolve=>{resolveRpc=resolve;});}},{leaseSeconds:30,heartbeatMs:1000});
  const watch=store.watch(row),owned=watch.assertOwned();await new Promise(resolve=>setImmediate(resolve));
  t.mock.timers.tick(25000);await assert.rejects(owned,{code:"NOTIFICATION_DELIVERY_LEASE_LOST"});assert.equal(watch.signal.aborted,true);
  resolveRpc({data:true});await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(watch.assertOwned(),{code:"NOTIFICATION_DELIVERY_LEASE_LOST"});assert.equal(calls,1);watch.stop();
});

test("watch stop cancels ownership waits without allowing a late renewal to restart timers",async(t)=>{
  t.mock.timers.enable({apis:["setInterval","setTimeout"]});let resolveRpc,calls=0;
  const store=new NotificationDeliveryLeaseStore({rpc:async()=>{calls++;return new Promise(resolve=>{resolveRpc=resolve;});}},{heartbeatMs:1000});
  const watch=store.watch({...fixture(),_task7Lease:{owner:TENANT,version:"1"}}),pending=watch.assertOwned();
  await new Promise(resolve=>setImmediate(resolve));watch.stop();await assert.rejects(pending,{code:"NOTIFICATION_DELIVERY_LEASE_LOST"});
  resolveRpc({data:true});await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(120000);assert.equal(calls,1);
  await assert.rejects(watch.assertOwned(),{code:"NOTIFICATION_DELIVERY_LEASE_LOST"});
});

test("a raw settings/effect failure after ownership abort cannot release or overwrite the claim",async()=>{
  const x=setup(),controller=new AbortController();
  x.store.watch=()=>({signal:controller.signal,assertOwned:async()=>{},stop(){x.stops++;}});
  await assert.rejects(x.gate({perform:async()=>{controller.abort();throw new Error("PRIVATE-SETTINGS-DIAGNOSTIC");}})(x.event),{code:"NOTIFICATION_DELIVERY_LEASE_LOST"});
  assert.equal(x.completions.length,0);assert.equal(x.stops,1);
});
