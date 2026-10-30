"use strict";
const SOURCES=new Set(["reservation","inquiry","contact_submission"]);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const identifier=(value)=>!(typeof value==="number"&&!Number.isSafeInteger(value))&&/^[1-9]\d*$/.test(String(value??""));
function validate(event){
  if(!event||!identifier(event.id)||!identifier(event.property_id)||!UUID.test(event.tenant_id||"")||!SOURCES.has(event.source_type)||
    typeof event.hotel_slug!=="string"||!event.hotel_slug||event.hotel_slug.trim()!==event.hotel_slug||!identifier(event.source_id)||event.event_type!==event.source_type+"_created"||
    typeof event.payload!=="object"||!event.payload||Array.isArray(event.payload))throw new Error("PUBLIC_NOTIFICATION_INTENT_SCOPE_INVALID");
}
function createPublicNotificationIntentProcessor({list,deliver,ack,publish=()=>{},metrics,logger}){
  let processing=false;
  return{isProcessing:()=>processing,async processBatch({limit=25}={}){
    if(processing)return{processed:0,skipped:true};processing=true;let processed=0,failed=false;
    metrics.worker("public_notification_intents",{running:true,started:true});
    try{
      const count=Number.isFinite(Number(limit))?Math.max(1,Math.min(25,Math.trunc(Number(limit)))):25;
      const events=await list(count);
      if(!Array.isArray(events)||events.length>count)throw new Error("PUBLIC_NOTIFICATION_INTENT_RESULT_INVALID");
      const seen=new Set();
      for(const event of events){
        try{
          validate(event);
          if(seen.has(String(event.id)))continue;seen.add(String(event.id));
          try{publish(event);}catch{logger.warn("Intent dashboard publication failed; polling can recover",{errorCode:"PUBLIC_NOTIFICATION_LOCAL_PUBLICATION_FAILED"});}
          const outcome=await deliver(event);
          validate(outcome);
          if(!["id","tenant_id","property_id","hotel_slug","source_type","source_id"].every(key=>String(outcome[key])===String(event[key])))throw new Error("PUBLIC_NOTIFICATION_INTENT_SCOPE_INVALID");
          if(["sent","skipped"].includes(outcome.status)){
            if(await ack(event.id)!==true)throw new Error("PUBLIC_NOTIFICATION_INTENT_ACK_REJECTED");
            processed++;
          }else failed=true;
        }catch{failed=true;logger.warn("Public notification intent remains pending or exhausted",{errorCode:"PUBLIC_NOTIFICATION_INTENT_RETRY_REQUIRED"});}
      }
      return{processed,skipped:false};
    }catch{failed=true;throw new Error("PUBLIC_NOTIFICATION_INTENT_BATCH_FAILED");}
    finally{processing=false;metrics.worker("public_notification_intents",{running:false,completed:true,failed});}
  }};
}
module.exports={createPublicNotificationIntentProcessor};
